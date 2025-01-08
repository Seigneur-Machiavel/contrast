import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { convert } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { EventEmitter } from 'events';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { bootstrap } from '@libp2p/bootstrap';
import { lpStream } from 'it-length-prefixed-stream';
import { multiaddr } from '@multiformats/multiaddr';
import ReputationManager from './peers-reputation.mjs';
import { yamux } from '@chainsafe/libp2p-yamux';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';

/**
 * @typedef {import("../../utils/time.mjs").TimeSynchronizer} TimeSynchronizer
 */

class P2PNetwork extends EventEmitter {
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

    /** @param {Object} [options={}] @param {TimeSynchronizer} timeSynchronizer */
    constructor(options = {}, timeSynchronizer) {
        super();
        /** @type {TimeSynchronizer} */
        this.timeSynchronizer = timeSynchronizer;
        const defaultOptions = {
            bootstrapNodes: [],
            maxPeers: 12,
            logLevel: 'info',
            logging: true,
            listenAddress: '/ip4/0.0.0.0/tcp/27260',
            dialTimeout: 30000,
            reputationOptions: {}, // Options for ReputationManager
        };
        this.options = { ...defaultOptions, ...options };
        this.p2pNode = null;
        this.peers = new Map();
        this.subscriptions = new Set();
        this.reputationManager = new ReputationManager(this.options.reputationOptions);
        this.reputationManager.on('identifierBanned', ({ identifier }) => {
            //this.disconnectPeer(identifier);
            this.miniLogger.log(`Peer ${identifier} has been banned`, (m) => { console.info(m); });
        });
        this.reputationManager.on('identifierUnbanned', ({ identifier }) => {
            this.miniLogger.log(`Peer ${identifier} has been unbanned`, (m) => { console.info(m); });
        });
    }

    /** @type {string} */
    static SYNC_PROTOCOL = '/blockchain-sync/1.0.0';
    static ALLOWED_TOPICS = new Set(['new_transaction', 'new_block_candidate', 'new_block_finalized']);

    /** @param {string} uniqueHash - A unique hash of 32 bytes to generate the private key from. */
    async start(uniqueHash) {
        const hash = uniqueHash ? uniqueHash : mining.generateRandomNonce(32).Hex;
        const hashUint8Array = convert.hex.toUint8Array(hash);
        const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hashUint8Array);
        const peerDiscovery = [mdns()];
        if (this.options.bootstrapNodes.length > 0) {peerDiscovery.push(bootstrap({ list: this.options.bootstrapNodes }));}
        try {
            this.p2pNode = await createLibp2p({
                privateKey: privateKeyObject,
                addresses: { listen: [this.options.listenAddress] },
                transports: [tcp()],
                streamMuxers: [yamux()],
                connectionEncrypters: [noise()],
                services: { identify: identify(), pubsub: gossipsub() },
                peerDiscovery,
            });

            await this.p2pNode.start();
            this.miniLogger.log(`P2P network started with peerId ${this.p2pNode.peerId} and listen address ${this.options.listenAddress}`, (m) => { console.info(m); });
            
            this.p2pNode.addEventListener('peer:connect', this.#handlePeerConnect);
            this.p2pNode.addEventListener('peer:disconnect', this.#handlePeerDisconnect);
            this.p2pNode.addEventListener('peer:discovery', this.#handlePeerDiscovery);
            this.p2pNode.services.pubsub.addEventListener('message', this.#handlePubsubMessage);

            await this.connectToBootstrapNodes();
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
        await Promise.all(this.options.bootstrapNodes.map(async (addr) => {
            const ma = multiaddr(addr);
            try {
                const isBanned = this.reputationManager.isPeerBanned({ ip: ma.toString() });
                this.miniLogger.log(`Connecting to bootstrap node ${addr}`, (m) => { console.info(m); });
                
                await this.p2pNode.dial(ma, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                this.miniLogger.log(`Connected to bootstrap node ${addr}`, (m) => { console.info(m); });
            } catch (err) {
                this.miniLogger.log(`Failed to connect to bootstrap node ${addr}`, (m) => { console.error(m); });
                const peerId = ma.getPeerId();
                if (peerId) { this.updatePeer(peerId.toString(), { dialable: false }); }
            }
        }));
    }
    #handlePeerDiscovery = async (event) => {
        const peerIdStr = event.detail.id.toString();
        const peerMultiaddrs = event.detail.multiaddrs;
        if (!peerMultiaddrs || peerMultiaddrs.length === 0) {
            this.miniLogger.log(`Failed to find multiaddrs for peer ${peerIdStr}`, (m) => { console.error(m); });
            return;
        }
        
        const isBanned = this.reputationManager.isPeerBanned({ peerId: peerIdStr, ip: peerMultiaddrs.toString() });
        this.miniLogger.log(`Peer ${peerIdStr} discovered, Dialing...`, (m) => { console.info(m); });

        try {
            await this.p2pNode.dial(peerMultiaddrs, { signal: AbortSignal.timeout(this.options.dialTimeout) });
            this.updatePeer(peerIdStr, { dialable: true });
        } catch (error) {
            this.miniLogger.log(`Failed to dial peer ${peerIdStr}`, (m) => { console.error(m); });
            this.updatePeer(peerIdStr, { dialable: false });
        }
    };
    /** @param {CustomEvent} event */
    #handlePeerConnect = async (event) => {
        const peerId = event.detail;
        const peerIdStr = peerId.toString();
        this.miniLogger.log(`Peer ${peerIdStr} connected`, (m) => { console.debug(m); });

        const isBanned = this.reputationManager.isPeerBanned({ peerId: peerIdStr });
        this.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.CONNECTION_ESTABLISHED);
        //if (isBanned) { this.closeConnection(peerIdStr, 'Banned peer'); return; }

        const connections = this.p2pNode.getConnections(peerIdStr);
        const address = connections.length > 0 ? connections[0].remoteAddr.toString() : null;

        try {
            const con = await this.p2pNode.dial(peerId);
            this.miniLogger.log(`Dialed peer ${peerId} at address ${con.remoteAddr.toString()}`, (m) => { console.debug(m); });
            this.updatePeer(peerId.toString(), { status: 'dialed', address: con.remoteAddr.toString(), dialable: true });
        } catch (error) {
            this.miniLogger.log(`Failed to dial peer ${peerId}, error: ${error.message}`, (m) => { console.error(m); });
            this.updatePeer(peerId.toString(), { status: 'connected', address, dialable: false });
        }
    };
    /** @param {CustomEvent} event */
    #handlePeerDisconnect = (event) => {
        const peerId = event.detail.toString();
        this.miniLogger.log(`Peer ${peerId} disconnected`, (m) => { console.debug(m); });
        this.peers.delete(peerId);
    };
    /** @param {CustomEvent} event */
    #handlePubsubMessage = async (event) => {
        const { topic, data, from } = event.detail;
        this.reputationManager.recordAction({ peerId: from }, ReputationManager.GENERAL_ACTIONS.PUBSUB_RECEIVED + topic);
        if (!this.#validateTopic(topic)) { return; }
        if (!this.#validateTopicData(topic, data)) { return; }

        const deserializationFnc = this.topicsTreatment[topic].deserialize || serializer.deserialize.rawData;

        try {
            const content = deserializationFnc(data);
            const message = { content, from, byteLength: data.byteLength };
            this.emit(topic, message);
        } catch (error) {
            this.miniLogger.log(error, (m) => { console.error(m); });
        }
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
        
        this.miniLogger.log(`Message size exceeds maximum allowed size from ${from}`, (m) => { console.error(m); });
        return false;
    }
    /** @param {string} topic */
    async broadcast(topic, message) {
        //this.miniLogger.log(`Broadcasting message on topic ${topic}`, (m) => { console.debug(m); });
        if (this.peers.size === 0) { return new Error("No peers to broadcast to"); }
        
        const serializationFnc = this.topicsTreatment[topic].serialize || serializer.serialize.rawData;
        
        try {
            const serialized = serializationFnc(message);
            await this.p2pNode.services.pubsub.publish(topic, serialized);
            return 'success';
        } catch (error) {
            if (error.message === "PublishError.NoPeersSubscribedToTopic") { return error; }
            this.miniLogger.log(`Broadcast error on topic **${topic}**`, (m) => { console.error(m); });
            this.miniLogger.log(error, (m) => { console.error(m); });
            return error;
        }
    }
    /** @param {string} peerMultiaddr - The multiaddress of the peer. @param {Object} message - The message to send. */
    async sendMessage(peerMultiaddr, message) {
        const ma = multiaddr(peerMultiaddr);
        const peerIdStr = ma.getPeerId();
        if (!peerIdStr) { throw new Error('Invalid multiaddr: Peer ID not found'); }

        const abortController = new AbortController();
        const timeout = setTimeout(() => { abortController.abort(); }, 300_000);
        const stream = await this.p2pNode.dialProtocol(peerMultiaddr, P2PNetwork.SYNC_PROTOCOL, { signal: abortController.signal });
        clearTimeout(timeout);
        
        this.updatePeer(peerIdStr, { stream });
        const response = await this.#sendOverStream(stream, message);
        if (response && response.status !== 'error') { return response; }

        const peer = this.peers.get(peerIdStr);
        if (!peer || !peer.stream || peer.stream.closed) { return; }

        this.miniLogger.log(`sendMessage stream not closed, forcing...`, (m) => { console.debug(m); });
        try {
            await peer.stream.close();
            await peer.stream.reset();
            this.updatePeer(peerIdStr, { stream: null });
            this.miniLogger.log(`Closed faulty stream after error with peer ${peerIdStr}`, (m) => { console.debug(m); });
        } catch (closeErr) {
            this.miniLogger.log(`Failed to close stream after error with peer ${peerIdStr}, error: ${closeErr.message}`, (m) => { console.error(m); });
        }
    }
    async #sendOverStream(stream, message, timeoutMs = 1000) {
        const createTimeout = (ms) => {
            return new Promise((_, reject) => {
                setTimeout(() => { reject(new Error(`Operation timed out after ${ms}ms`)); }, ms);
            });
        };

        let response = 'failed';
        try {
            const lp = lpStream(stream);
            const serialized = serializer.serialize.rawData(message);
            await Promise.race([ lp.write(serialized), createTimeout(timeoutMs) ]);
            this.miniLogger.log(`Message written to stream (${serialized.length} bytes)`, (m) => { console.info(m); });

            const res = await Promise.race([ lp.read(), createTimeout(timeoutMs) ]);
            if (!res) { throw new Error('No response received (unexpected end of input)'); }

            this.miniLogger.log(`Response read from stream (${res.length} bytes)`, (m) => { console.info(m); });
            response = serializer.deserialize.rawData(res.subarray());
        } catch (error) {
            this.miniLogger.log(`Error during sendOverStream, error: ${error.message}, timeout: ${timeoutMs}`, (m) => { console.error(m); });
            throw error;
        }

        stream.close();
        return response;
    }
    /** @param {string} topic @param {Function} [callback] */
    subscribe(topic, callback) {
        if (this.subscriptions.has(topic)) {
            this.miniLogger.log(`Attempting to subscribe to already subscribed topic ${topic}`, (m) => { console.warn(m); });
            return;
        }

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
    /** @param {string} peerIdStr @param {Object} data */
    updatePeer(peerIdStr, data) {
        const updatedPeer = this.peers.get(peerIdStr) || {};
        updatedPeer.address = data.address || updatedPeer.address || null;
        updatedPeer.stream = data.stream || updatedPeer.stream || null;
        if (data.dialable !== undefined) { updatedPeer.dialable = data.dialable; }
        if (updatedPeer.dialable === undefined) { updatedPeer.dialable = null; }
        updatedPeer.lastSeen = this.timeSynchronizer.getCurrentTime();

        this.peers.set(peerIdStr, updatedPeer);
        this.miniLogger.log(`Peer ${peerIdStr} updated`, (m) => { console.debug(m); });
    }
    /** @param {string} identifier - peerId or ip */
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
    async closeConnection(peerIdStr, reason) {
        const message = `Closing connection to ${peerIdStr}${reason ? ` for reason: ${reason}` : ''}`;
        this.miniLogger.log(message, (m) => { console.debug(m); });
        this.p2pNode.components.connectionManager.closeConnections(peerIdStr);
    }
    /** @returns {string[]} */
    getConnectedPeers() {
        return Array.from(this.peers.keys());
    }
    getPeers() {
        return Object.fromEntries(this.peers);
    }
}

export default P2PNetwork;
export { P2PNetwork };