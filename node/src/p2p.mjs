import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { convert, FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { EventEmitter } from 'events';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { kadDHT } from '@libp2p/kad-dht';
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
 */

class P2PNetwork extends EventEmitter {
    static maxChunkSize = 64 * 1024; // 64 KB
    static maxStreamBytes = 1024 * 1024 * 1024; // 1 GB
    myAddr;
    timeSynchronizer;
    fastConverter = new FastConverter();
    /** @type {string} */
    static SYNC_PROTOCOL = '/blockchain-sync/1.0.0';
    static ALLOWED_TOPICS = new Set(['new_transaction', 'new_block_candidate', 'new_block_finalized']);
    
    /** @type {Libp2p} */
    p2pNode;
    /** @type {Object<string, Peer>} */
    peers = {};
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
    };
    connectedBootstrapNodes = {};
    connexionResume = { totalPeers: 0, connectedBootstraps: 0, totalBootstraps: 0 };
    targetBootstrapNodes = 5;
    totalOfDisconnections = 0;
    options = {
        bootstrapNodes: [],
        maxPeers: 12,
        logLevel: 'info',
        logging: true,
        listenAddresses: ['/ip4/0.0.0.0/tcp/27260', '/ip4/0.0.0.0/tcp/0'],
        dialTimeout: 3000, //3000,
        reputationOptions: {}, // Options for ReputationManager
    };
    
    /** @param {TimeSynchronizer} timeSynchronizer @param {string[]} [listenAddresses] */
    constructor(timeSynchronizer, listenAddresses) {
        super();
        this.timeSynchronizer = timeSynchronizer;
        if (listenAddresses) this.options.listenAddresses = listenAddresses;

        this.reputationManager = new ReputationManager(this.options.reputationOptions);
        this.reputationManager.on('identifierBanned', ({ identifier }) => {
            //this.disconnectPeer(identifier);
            this.miniLogger.log(`Peer ${readableId(identifier)} has been banned`, (m) => { console.info(m); });
        });
        this.reputationManager.on('identifierUnbanned', ({ identifier }) => {
            this.miniLogger.log(`Peer ${readableId(identifier)} has been unbanned`, (m) => { console.info(m); });
        });
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
                addresses: { listen: this.options.listenAddresses },
                transports: [tcp()],
                streamMuxers: [yamux()],
                modules: { dht: kadDHT() },
                //config: { dht: { enabled: true } },
                config: {
                    dht: { enabled: true },
                    relay: {
                        enabled: true, // Enable circuit relay dialer and listener (STOP)
                        hop: {
                            enabled: true, // Make this node a relay
                            active: true, // Allow other nodes to dial through this node
                        },
                    },
                },
                connectionEncrypters: [noise()],
                services: { identify: identify(), pubsub: gossipsub() },
                peerDiscovery
            });

            await p2pNode.start();
            this.miniLogger.log(`P2P network started. PeerId ${readableId(p2pNode.peerId.toString())} | Listen addresses ${this.options.listenAddresses}`, (m) => { console.info(m); });
            
            p2pNode.addEventListener('peer:connect', this.#handlePeerConnect);
            p2pNode.addEventListener('peer:disconnect', this.#handlePeerDisconnect);
            p2pNode.addEventListener('peer:discovery', this.#handlePeerDiscovery);
            p2pNode.services.pubsub.addEventListener('message', this.#handlePubsubMessage);
            this.p2pNode = p2pNode;
        } catch (error) {
            this.miniLogger.log('Failed to start P2P network', (m) => { console.error(m); });
            this.miniLogger.log(error.stack, (m) => { console.error(m); });
            throw error;
        }

        this.#bootstrapsReconnectLoop();
        this.#controlLoop();
        //this.#heartBeat();
    }
    async #controlLoop() {
        while(true) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const consInfo = {};
            this.p2pNode.getConnections().forEach(connection => {
                const peerIdStr = connection.remotePeer.toString();
                const ip = connection.remoteAddr.nodeAddress().address;

                if (!consInfo[peerIdStr]) consInfo[peerIdStr] = { ip, count: 0 };
                consInfo[peerIdStr].count++;
            });

            /*console.log(`[CONTROL] Total of disconnections: ${this.totalOfDisconnections} -------`);
            for (const peerIdStr in consInfo) {
                const { ip, count } = consInfo[peerIdStr];
                console.log(`Peer ${readableId(peerIdStr)} | IP ${ip} | Connections: ${count}`);
            }*/
        }
    }
    async #heartBeat() {
        // ping all peers through the pubsub
        while(true) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            this.broadcast('heartbeat', { time: this.timeSynchronizer.getCurrentTime() });
        }
    }
    #handlePeerDiscovery = async (event) => {
        /** @type {PeerId} */
        const peerId = event.detail.id;
        const peerIdStr = peerId.toString();
        const connections = this.p2pNode.getConnections(peerIdStr);
        if (connections.length > 0) { return; }

        try {
            const con = await this.p2pNode.dial(event.detail.multiaddrs, { signal: AbortSignal.timeout(this.options.dialTimeout) });
            con.newStream(P2PNetwork.SYNC_PROTOCOL);
            this.#updatePeer(peerIdStr, { dialable: true, id: peerId }, 'discovered');
        } catch (err) {
            this.miniLogger.log(`(Discovery) Failed to dial peer ${readableId(peerIdStr)}`, (m) => { console.error(m); });
        }
    };
    /** @param {CustomEvent} event */
    #handlePeerConnect = async (event) => {
        /** @type {PeerId} */
        const peerId = event.detail;
        const peerIdStr = peerId.toString();
        this.miniLogger.log(`(Connect) Dialed peer ${readableId(peerIdStr)}`, (m) => { console.debug(m); });

        const isBanned = this.reputationManager.isPeerBanned({ peerId: peerIdStr });
        this.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.CONNECTION_ESTABLISHED);
        //if (isBanned) { this.closeConnection(peerIdStr, 'Banned peer'); return; }

        this.#updatePeer(peerIdStr, { dialable: true, id: peerId }, 'connected');
    };
    /** @param {CustomEvent} event */
    #handlePeerDisconnect = async (event) => {
        this.totalOfDisconnections++;
        /** @type {PeerId} */
        const peerId = event.detail;
        const peerIdStr = peerId.toString();
        this.miniLogger.log(`--------> Peer ${readableId(peerIdStr)} disconnected`, (m) => { console.debug(m); });
        if (this.peers[peerIdStr]) { delete this.peers[peerIdStr]; }
        if (this.connectedBootstrapNodes[peerIdStr]) { delete this.connectedBootstrapNodes[peerIdStr]; }
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

    async #bootstrapsReconnectLoop() {
        while(true) {
            if (Object.keys(this.connectedBootstrapNodes).length < this.targetBootstrapNodes) {
                await this.#connectToBootstrapNodes();
            }
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    async #connectToBootstrapNodes() {
        let iAmBootstrap = false;
        
        const promises = [];
        for (const addr of this.options.bootstrapNodes) {
            if (this.myAddr === addr) { iAmBootstrap = true; continue; } // Skip if recognize as myself
            if (this.#isBootstrapNodeAlreadyConnected(addr)) { continue; } // Skip if already connected

            const ma = multiaddr(addr);
            const isBanned = this.reputationManager.isPeerBanned({ ip: ma.toString() });
            //this.miniLogger.log(`Connecting to bootstrap node ${addr}`, (m) => { console.info(m); });

            promises.push(this.p2pNode.dial(ma, { signal: AbortSignal.timeout(this.options.dialTimeout) })
                .then(con => {
                    con.newStream(P2PNetwork.SYNC_PROTOCOL);
                    const peerIdStr = con.remotePeer.toString();
                    this.connectedBootstrapNodes[peerIdStr] = addr;
                })
                .catch(err => {
                    if (err.message === 'Can not dial self') { this.myAddr = addr; iAmBootstrap = true; }
                    //this.miniLogger.log(`Failed to connect to bootstrap node ${addr}`, (m) => { console.error(m); });
                })
            );
        }

        await Promise.allSettled(promises);

        const totalPeers = Object.keys(this.peers).length;
        const connectedBootstraps = Object.keys(this.connectedBootstrapNodes).length;
        let totalBootstraps = iAmBootstrap ? this.options.bootstrapNodes.length - 1 : this.options.bootstrapNodes.length;
        this.connexionResume = { totalPeers, connectedBootstraps, totalBootstraps };
        this.miniLogger.log(`Connected to ${totalPeers} peers (${connectedBootstraps}/${totalBootstraps} bootstrap nodes)`, (m) => { console.info(m); });
    }
    async stop() {
        if (this.p2pNode) { await this.p2pNode.stop(); }
        this.miniLogger.log(`P2P network ${this.p2pNode.peerId.toString()} stopped`, (m) => { console.info(m); });
        await this.reputationManager.shutdown();
    }
    #isBootstrapNodeAlreadyConnected(addr) {
        for (const peerIdStr in this.connectedBootstrapNodes) {
            if (this.connectedBootstrapNodes[peerIdStr] === addr) { return true; }
        }
        return false;
    }
    static async streamWrite(stream, serializedMessage, maxChunkSize = P2PNetwork.maxChunkSize) {
        // limit the speed of sending chunks, at 64 KB/chunk, 1 GB would take:
        // 1 GB / 64 KB = 16384 chunks => 16384 * 2 ms = 32.768 more seconds
        async function* generateChunks(serializedMessage, maxChunkSize, delay = 2) {
            const totalChunks = Math.ceil(serializedMessage.length / maxChunkSize);
            for (let i = 0; i < totalChunks; i++) {
                const start = i * maxChunkSize;
                yield serializedMessage.slice(start, start + maxChunkSize); // send chunk
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        try { await stream.sink( generateChunks(serializedMessage, maxChunkSize) );
        } catch (error) { console.error(error); return false; }
        return true;
    }
    /** @param {Stream} stream */
    static async streamRead(stream) {
        const dataChunks = [];
        for await (const chunk of stream.source) { dataChunks.push(chunk.subarray()); }

        const data = new Uint8Array(Buffer.concat(dataChunks));
        return { data, nbChunks: dataChunks.length };
    }
    // PUBSUB
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
    /** @param {string} topic */
    async broadcast(topic, message) {
        //this.miniLogger.log(`Broadcasting message on topic ${topic}`, (m) => { console.debug(m); });
        if (Object.keys(this.peers).length === 0) { return; }
        
        const serializationFnc = this.topicsTreatment[topic]?.serialize || serializer.serialize.rawData;
        try {
            const serialized = serializationFnc(message);
            await this.p2pNode.services.pubsub.publish(topic, serialized);
        } catch (error) {
            if (error.message === "PublishError.NoPeersSubscribedToTopic") { return error; }
            this.miniLogger.log(`Broadcast error on topic **${topic}**`, (m) => { console.error(m); });
            this.miniLogger.log(error, (m) => { console.error(m); });
        }
    }
    /** @param {string} peerIdStr @param {Object} data @param {string} [reason] */
    #updatePeer(peerIdStr, data, reason) {
        const updatedPeer = this.peers[peerIdStr] || {};
        updatedPeer.id = data.id || updatedPeer.id;
        updatedPeer.lastSeen = this.timeSynchronizer.getCurrentTime();
        if (data.dialable !== undefined) { updatedPeer.dialable = data.dialable; }
        if (updatedPeer.dialable === undefined) { updatedPeer.dialable = null; }

        this.peers[peerIdStr] = updatedPeer;
        this.miniLogger.log(`Peer ${readableId(peerIdStr)} updated ${reason ? `for reason: ${reason}` : ''}`, (m) => { console.debug(m); });
    }
    /** @param {string} identifier - peerIdStr or ip */
    async disconnectPeer(identifier) {
        if (!this.p2pNode) return;

        for (const connection of this.p2pNode.getConnections()) {
            const peerIdStr = connection.remotePeer.toString();
            const ip = connection.remoteAddr.nodeAddress().address;
            if (identifier !== peerIdStr && identifier !== ip) { continue; }

            this.p2pNode.components.connectionManager.closeConnections(peerIdStr);
            this.miniLogger.log(`Disconnected peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
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

function readableId(peerIdStr) {
    return peerIdStr.replace('12D3KooW', '').slice(0, 12);
}

export default P2PNetwork;
export { P2PNetwork, readableId };