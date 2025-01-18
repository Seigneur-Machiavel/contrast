import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { convert, FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { EventEmitter } from 'events';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { multiaddr } from '@multiformats/multiaddr';
import ReputationManager from './peers-reputation.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';

/**
 * @typedef {import("@libp2p/interface").Libp2p} Libp2p
 * @typedef {import("@multiformats/multiaddr").Multiaddr} Multiaddr
 * @typedef {import("../../utils/time.mjs").TimeSynchronizer} TimeSynchronizer
 * @typedef {import("@libp2p/interface").PeerId} PeerId
 * @typedef {import("@libp2p/interface").Stream} Stream
 * 
 * @typedef {Object} Peer
 * @property {PeerId} id
 * @property {boolean} dialable
 * @property {number} lastSeen
 * 
 * @typedef {Object} KnownPubKeysAddressesSnapInfo
 * @property {number} height
 * @property {string} hash
 * 
 * @typedef {Object} SyncRequest
 * @property {string} type - 'getStatus' | 'getBlocks' | 'getPubKeysAddresses'
 * @property {string?} pubKeysHash - Only for 'getPubKeysAddresses' -> 
 * @property {number?} startIndex
 * @property {number?} endIndex
 * 
 * @typedef {Object} SyncResponse
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 * @property {KnownPubKeysAddressesSnapInfo} knownPubKeysInfo
 * @property {Uint8Array[]?} blocks
 * @property {Uint8Array?} knownPubKeysAddresses
 */

class P2PNetwork extends EventEmitter {
    fastConverter = new FastConverter();
    /** @type {string} */
    static SYNC_PROTOCOL = '/blockchain-sync/1.0.0';
    static ALLOWED_TOPICS = new Set(['new_transaction', 'new_block_candidate', 'new_block_finalized']);
    
    /** @type {Libp2p} */
    p2pNode;
    /** @type {Object<string, Peer>} */
    peers = {};
    /** @type {Object<string, Stream>} */
    openStreams = {};
    subscriptions = new Set();
    miniLogger = new MiniLogger('P2PNetwork');
    topicsTreatment = {
        'new_transaction': {
            serialize: (data) => serializer.serialize.transaction(data),
            deserialize: (data) => serializer.deserialize.transaction(data),
            maxSize: BLOCKCHAIN_SETTINGS.maxTransactionSize * 1.02,
        },
        'new_block_candidate': {
            serialize: (data) => serializer.serialize.block_candidate(data),
            deserialize: (data) => serializer.deserialize.block_candidate(data),
            maxSize: BLOCKCHAIN_SETTINGS.maxBlockSize * 1.04,
        },
        'new_block_finalized': {
            serialize: (data) => serializer.serialize.block_finalized(data),
            deserialize: (data) => serializer.deserialize.block_finalized(data),
            maxSize: BLOCKCHAIN_SETTINGS.maxBlockSize * 1.05,
        },
    }
    timeSynchronizer;
    
    /** @param {Object} [options={}] @param {TimeSynchronizer} timeSynchronizer */
    constructor(options = {}, timeSynchronizer) {
        super();
        this.timeSynchronizer = timeSynchronizer;
        const defaultOptions = {
            bootstrapNodes: [],
            maxPeers: 12,
            logLevel: 'info',
            logging: true,
            listenAddress: '/ip4/0.0.0.0/tcp/27260',
            dialTimeout: 3000,
            reputationOptions: {}, // Options for ReputationManager
        };
        this.options = { ...defaultOptions, ...options };
        this.reputationManager = new ReputationManager(this.options.reputationOptions);
        this.reputationManager.on('identifierBanned', ({ identifier }) => {
            //this.disconnectPeer(identifier);
            this.miniLogger.log(`Peer ${identifier} has been banned`, (m) => { console.info(m); });
        });
        this.reputationManager.on('identifierUnbanned', ({ identifier }) => {
            this.miniLogger.log(`Peer ${identifier} has been unbanned`, (m) => { console.info(m); });
        });
    }

    #handlePeerDiscovery = async (event) => {
        /** @type {PeerId} */
        const peerId = event.detail.id;
        const peerIdStr = peerId.toString();
        const connections = this.p2pNode.getConnections(peerIdStr);
        if (connections.length > 0) { return; }

        try {
            await this.p2pNode.dial(event.detail.multiaddrs, { signal: AbortSignal.timeout(this.options.dialTimeout) });
        } catch (err) {
            this.miniLogger.log(`(Discovery) Failed to dial peer ${peerIdStr}`, (m) => { console.error(m); });
        }
    };
    /** @param {CustomEvent} event */
    #handlePeerConnect = async (event) => {
        /** @type {PeerId} */
        const peerId = event.detail;
        const peerIdStr = peerId.toString();
        this.miniLogger.log(`(Connect) Dialed peer ${peerIdStr}`, (m) => { console.debug(m); });

        const isBanned = this.reputationManager.isPeerBanned({ peerId: peerIdStr });
        this.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.CONNECTION_ESTABLISHED);
        //if (isBanned) { this.closeConnection(peerIdStr, 'Banned peer'); return; }

        this.#updatePeer(peerIdStr, { dialable: true, id: peerId }, 'connected');
    };
    /** @param {CustomEvent} event */
    #handlePeerDisconnect = async (event) => {
        /** @type {PeerId} */
        const peerId = event.detail;
        const peerIdStr = peerId.toString();
        this.miniLogger.log(`--------> Peer ${peerIdStr} disconnected`, (m) => { console.debug(m); });
        if (this.openStreams[peerIdStr] && this.openStreams[peerIdStr].status === 'open') { await this.openStreams[peerIdStr].close(); }
        if (this.openStreams[peerIdStr]) { delete this.openStreams[peerIdStr]; }
        delete this.peers[peerIdStr];
    };
    /** @param {CustomEvent} event */
    #handlePubsubMessage = async (event) => {
        const { topic, data, from } = event.detail;
        this.reputationManager.recordAction({ peerId: from }, ReputationManager.GENERAL_ACTIONS.PUBSUB_RECEIVED + topic);
        if (!this.#validateTopic(topic)) { return; }
        if (!this.#validateTopicData(topic, data)) { return; }

        try {
            const deserializationFnc = this.topicsTreatment[topic].deserialize || serializer.deserialize.rawData;
            const content = deserializationFnc(data);
            const message = { content, from, byteLength: data.byteLength };
            this.emit(topic, message);
        } catch (error) { this.miniLogger.log(error, (m) => { console.error(m); }); }
    }
    /** Validates a pubsub topic against the allowed topics. @param {string} topic - The topic to validate. */
    #validateTopic(topic) {
        if (typeof topic !== 'string') {
            this.miniLogger.log(`Invalid topic type ${topic}, reason: Topic must be a string`, (m) => { console.warn(m); });
            return false;
        }
        if (P2PNetwork.ALLOWED_TOPICS.has(topic)) { return true; }

        this.miniLogger.log(`Topic not allowed ${topic}`, (m) => { console.warn(m); });
        return false;
    }
    /** Validates the data of a pubsub message. @param {string} topic @param {Uint8Array} data */
    #validateTopicData(topic, data, verifySize = true) {
        if (!(data instanceof Uint8Array)) {
            this.miniLogger.log(`Received non-binary data dataset: ${data} topic: ${topic}`, (m) => { console.error(m); });
            return false;
        }

        if (!verifySize || data.byteLength <= this.topicsTreatment[topic].maxSize) { return true; }
        
        this.miniLogger.log(`Message size exceeds maximum allowed size, topic: ${topic}`, (m) => { console.error(m); });
        return false;
    }

    /** @param {string} uniqueHash - A unique hash of 32 bytes to generate the private key from. */
    async start(uniqueHash) {
        const hash = uniqueHash ? uniqueHash : mining.generateRandomNonce(32).Hex;
        const hashUint8Array = convert.hex.toUint8Array(hash);
        const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hashUint8Array);
        const peerDiscovery = [mdns()];
        if (this.options.bootstrapNodes.length > 0) {peerDiscovery.push(bootstrap({ list: this.options.bootstrapNodes }));}
        try {
            const p2pNode = await createLibp2p({
                privateKey: privateKeyObject,
                addresses: { listen: [this.options.listenAddress] },
                transports: [tcp()],
                streamMuxers: [yamux()],
                connectionEncrypters: [noise()],
                services: { identify: identify(), pubsub: gossipsub() },
                peerDiscovery
            });

            await p2pNode.start();
            this.miniLogger.log(`P2P network started with peerId ${p2pNode.peerId} and listen address ${this.options.listenAddress}`, (m) => { console.info(m); });
            
            p2pNode.addEventListener('peer:connect', this.#handlePeerConnect);
            p2pNode.addEventListener('peer:disconnect', this.#handlePeerDisconnect);
            p2pNode.addEventListener('peer:discovery', this.#handlePeerDiscovery);
            p2pNode.services.pubsub.addEventListener('message', this.#handlePubsubMessage);
            this.p2pNode = p2pNode;

            // await this.connectToBootstrapNodes(); -> we call it after setup syncHandler in node.start()
        } catch (error) {
            this.miniLogger.log('Failed to start P2P network', { error: error.message });
            throw error;
        }
    }
    async stop() {
        if (this.p2pNode) { await this.p2pNode.stop(); }
        this.miniLogger.log(`P2P network ${this.p2pNode.peerId.toString()} stopped`, (m) => { console.info(m); });
        await this.reputationManager.shutdown();
    }
    async connectToBootstrapNodes() {
        //return;
        await Promise.all(this.options.bootstrapNodes.map(async (addr) => {
            const ma = multiaddr(addr);
            const isBanned = this.reputationManager.isPeerBanned({ ip: ma.toString() });
            this.miniLogger.log(`Connecting to bootstrap node ${addr}`, (m) => { console.info(m); });
            try {
                await this.p2pNode.dial(ma, { signal: AbortSignal.timeout(this.options.dialTimeout) });
            } catch (err) {
                this.miniLogger.log(`Failed to connect to bootstrap node ${addr}`, (m) => { console.error(m); });
            }
        }));
    }
    /** @param {string} topic */
    async broadcast(topic, message) {
        //this.miniLogger.log(`Broadcasting message on topic ${topic}`, (m) => { console.debug(m); });
        if (Object.keys(this.peers).length === 0) { return; }
        
        const serializationFnc = this.topicsTreatment[topic].serialize || serializer.serialize.rawData;
        try {
            const serialized = serializationFnc(message);
            await this.p2pNode.services.pubsub.publish(topic, serialized);
        } catch (error) {
            if (error.message === "PublishError.NoPeersSubscribedToTopic") { return error; }
            this.miniLogger.log(`Broadcast error on topic **${topic}**`, (m) => { console.error(m); });
            this.miniLogger.log(error, (m) => { console.error(m); });
        }
    }
    /** @param {string} peerIdStr @param {SyncRequest} message */
    async sendSyncRequest(peerIdStr, message) {
        const peer = this.peers[peerIdStr];
        if (!peer || !peer.dialable) { return false; }

        try {
            if (this.openStreams[peerIdStr] && this.openStreams[peerIdStr].status !== 'open') { delete this.openStreams[peerIdStr]; }
            this.openStreams[peerIdStr] = this.openStreams[peerIdStr] || await this.p2pNode.dialProtocol(peer.id, [P2PNetwork.SYNC_PROTOCOL]);
            
            const serialized = serializer.serialize.rawData(message);
            await this.openStreams[peerIdStr].sink([serialized]);
            this.miniLogger.log(`Message written to stream (${serialized.length} bytes)`, (m) => { console.info(m); });
            
            const data = await P2PNetwork.streamRead(this.openStreams[peerIdStr]);
            this.miniLogger.log(`Message read from stream (${data.length} bytes)`, (m) => { console.info(m); });
            await this.openStreams[peerIdStr].close();

            /** @type {SyncResponse} */
            const response = serializer.deserialize.rawData(data);
            return response;
        } catch (err) {
            if (err.code !== 'ABORT_ERR') { this.miniLogger.log(err, (m) => { console.error(m); }); }
        }
    }
    /** @param {Stream} stream */
    static async streamRead(stream) {
        /** @type {Uint8Array[]} */
        const msgParts = [];
        let totalSize = 0;
        for await (const chunk of stream.source) {
            msgParts.push(new Uint8Array(chunk.subarray()));
            totalSize += chunk.length;
        }
        
        const data = new Uint8Array(totalSize);
        let offset = 0;
        for (const part of msgParts) {
            data.set(part, offset);
            offset += part.length;
        }

        return data;
    }
    /** @param {string} topic @param {Function} [callback] */
    subscribe(topic, callback) {
        if (this.subscriptions.has(topic)) { return; }

        this.miniLogger.log(`Subscribing to topic ${topic}`, (m) => { console.debug(m); });
        this.p2pNode.services.pubsub.subscribe(topic);
        this.subscriptions.add(topic);
        if (callback) { this.on(topic, message => callback(topic, message)); }
    }
    /** Unsubscribes from a topic and removes any associated callback @param {string} topic */
    unsubscribe(topic) {
        if (!this.subscriptions.has(topic)) { return; }

        this.p2pNode.services.pubsub.unsubscribe(topic);
        this.p2pNode.services.pubsub.topics.delete(topic);
        this.subscriptions.delete(topic);
        this.miniLogger.log(`Unsubscribed from topic ${topic}`, (m) => { console.debug(m); });
    }
    /** @param {string} peerIdStr @param {Object} data @param {string} [reason] */
    #updatePeer(peerIdStr, data, reason) {
        const updatedPeer = this.peers[peerIdStr] || {};
        updatedPeer.id = data.id || updatedPeer.id;
        updatedPeer.lastSeen = this.timeSynchronizer.getCurrentTime();
        if (data.dialable !== undefined) { updatedPeer.dialable = data.dialable; }
        if (updatedPeer.dialable === undefined) { updatedPeer.dialable = null; }

        this.peers[peerIdStr] = updatedPeer;
        this.miniLogger.log(`Peer ${peerIdStr} updated ${reason ? `for reason: ${reason}` : ''}`, (m) => { console.debug(m); });
    }
    /** @param {string} identifier - peerIdStr or ip */
    async disconnectPeer(identifier) {
        if (!this.p2pNode) return;

        for (const connection of this.p2pNode.getConnections()) {
            const peerIdStr = connection.remotePeer.toString();
            const ip = connection.remoteAddr.nodeAddress().address;
            if (identifier !== peerIdStr && identifier !== ip) { continue; }

            this.p2pNode.components.connectionManager.closeConnections(peerIdStr);
            this.miniLogger.log(`Disconnected peer ${identifier}`, (m) => { console.info(m); });
        }
    }
    /** @param {string} peerIdStr @param {string} reason */
    async closeConnection(peerIdStr, reason) {
        const message = `Closing connection to ${peerIdStr}${reason ? ` for reason: ${reason}` : ''}`;
        this.miniLogger.log(message, (m) => { console.debug(m); });
        this.p2pNode.components.connectionManager.closeConnections(peerIdStr);
    }
    /** @returns {string[]} */
    getConnectedPeers() {
        return Object.keys(this.peers);
    }
}

export default P2PNetwork;
export { P2PNetwork };