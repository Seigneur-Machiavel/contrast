import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
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
        this.miniLogger = new MiniLogger('P2PNetwork');
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

    async start(_uniqueHash) {
        let uniqueHash = _uniqueHash ? _uniqueHash : mining.generateRandomNonce(32).Hex;
        const hashUint8Array = this.toUint8Array(uniqueHash);
        const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hashUint8Array);
        try {
            this.p2pNode = await this.#createLibp2pNode(privateKeyObject);
            await this.p2pNode.start();
            this.miniLogger.log(`P2P network started with peerId ${this.p2pNode.peerId} and listen address ${this.options.listenAddress}`, (m) => { console.info(m); });
            this.#setupEventListeners();
            await this.connectToBootstrapNodes();
        } catch (error) {
            this.miniLogger.log('Failed to start P2P network', { error: error.message });
            throw error;
        }
    }
    async stop() {
        if (this.p2pNode) {
            await this.p2pNode.stop();
            this.miniLogger.log(`P2P network stopped with peerId ${this.p2pNode.peerId.toString()}`, (m) => { console.info(m); });
        }
        await this.reputationManager.shutdown();
    }
    /** @returns {Promise<Libp2p>} */
    async #createLibp2pNode(privateKeyObject) {    
        const peerDiscovery = [mdns()];
        if (this.options.bootstrapNodes.length > 0) {peerDiscovery.push(bootstrap({ list: this.options.bootstrapNodes }));}

        return createLibp2p({
            privateKey: privateKeyObject,
            addresses: { listen: [this.options.listenAddress] },
            transports: [tcp()],
            streamMuxers: [yamux()],
            connectionEncrypters: [noise()],
            services: {
                identify: identify(),
                pubsub: gossipsub()
            },
            peerDiscovery,
        });
    }
    async connectToBootstrapNodes() {
        await Promise.all(this.options.bootstrapNodes.map(async (addr) => {
            const ma = multiaddr(addr);
            try {
                const isBanned = this.reputationManager.isPeerBanned({ ip: ma.toString() });
                this.miniLogger.log(`Connecting to bootstrap node ${addr}`, (m) => { console.info(m); });
                
                await this.p2pNode.dial(ma, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                this.miniLogger.log(`Connected to bootstrap node ${addr}`, (m) => { console.info(m); });

                const peerId = ma.getPeerId();
                if (peerId) { this.updatePeer(peerId.toString(), { dialable: true });}
            } catch (err) {
                this.miniLogger.log(`Failed to connect to bootstrap node ${addr}`, (m) => { console.error(m); });
                const peerId = ma.getPeerId();
                if (peerId) { this.updatePeer(peerId.toString(), { dialable: false }); }
            }
        }));
    }
    #setupEventListeners() {
        this.p2pNode.addEventListener('peer:connect', this.#handlePeerConnect);
        this.p2pNode.addEventListener('peer:disconnect', this.#handlePeerDisconnect);
        this.p2pNode.addEventListener('peer:discovery', this.#handlePeerDiscovery);
        this.p2pNode.services.pubsub.addEventListener('message', this.#handlePubsubMessage);
    }
    #handlePeerDiscovery = async (event) => {
        const peerId = event.detail.id.toString();
        const peerMultiaddrs = event.detail.multiaddrs;
        const isBanned = this.reputationManager.isPeerBanned({ peerId });
        this.miniLogger.log(`Peer ${peerId} discovered`, (m) => { console.info(m); });

        if (!peerMultiaddrs || peerMultiaddrs.length === 0) {
            this.miniLogger.log(`Failed to find multiaddrs for peer ${peerId}`, (m) => { console.error(m); });
            return;
        }
        try {
            const isBanned = this.reputationManager.isPeerBanned({ ip: peerMultiaddrs.toString() });
            this.miniLogger.log(`Dialing after discovery ${peerMultiaddrs}`, (m) => { console.info(m); });
            await this.p2pNode.dial(peerMultiaddrs, { signal: AbortSignal.timeout(this.options.dialTimeout) });
            this.updatePeer(peerId, { dialable: true });
        }
        catch (error) {
            this.miniLogger.log(`Failed to dial peer ${peerId}`, (m) => { console.error(m); });
            this.updatePeer(peerId, { dialable: false });
        }
    };
    /** @param {CustomEvent} event */
    #handlePeerConnect = (event) => {
        const peerId = event.detail.toString();
        this.miniLogger.log(`Peer ${peerId} connected`, (m) => { console.debug(m); });

        const isBanned = this.reputationManager.isPeerBanned({ peerId });
        this.reputationManager.recordAction({ peerId }, ReputationManager.GENERAL_ACTIONS.CONNECTION_ESTABLISHED);

        if (isBanned) {
            this.miniLogger.log(`Peer ${peerId} is banned, closing connection`, (m) => { console.warn(m); });
            //this.closeConnection(peerId);
            //return;
        }

        // Retrieve multiaddrs of the connected peer
        const connections = this.p2pNode.getConnections(peerId);
        let peerInfo = { peerId, address: null };
        if (connections.length > 0) {
            const multiaddr = connections[0].remoteAddr;
            peerInfo.address = multiaddr.toString();
        }
        this.updatePeer(peerId, { status: 'connected', address: peerInfo.address });
        this.dial(event.detail);
    };
    /** @param {CustomEvent} event */
    #handlePeerDisconnect = (event) => {
        const peerId = event.detail.toString();
        this.miniLogger.log(`Peer ${peerId} disconnected`, (m) => { console.debug(m); });
        this.peers.delete(peerId);
    };
    async dial(peerId) {
        try {
            const con = await this.p2pNode.dial(peerId);
            this.miniLogger.log(`Dialed peer ${peerId} at address ${con.remoteAddr.toString()}`, (m) => { console.debug(m); });
            this.updatePeer(peerId.toString(), { status: 'dialed', address: con.remoteAddr.toString(), dialable: true });
        } catch (error) {
            this.miniLogger.log(`Failed to dial peer ${peerId}, error: ${error.message}`, (m) => { console.error(m); });
            this.updatePeer(peerId.toString(), { dialable: false });
            throw error;
        }
    }
    async createStream(peerId, protocol) {
        try {
            const stream = await this.p2pNode.dialProtocol(peerId, protocol);
            this.miniLogger.log(`Stream created with peer ${peerId} on protocol ${protocol}`, (m) => { console.debug(m); });
            this.updatePeer(peerId.toString(), { stream });
            return stream;
        } catch (error) {
            this.miniLogger.log(`Failed to create stream with peer ${peerId} on protocol ${protocol}, error: ${error.message}`, (m) => { console.error(m); });
            throw error;
        }
    }
    /** @param {CustomEvent} event */
    #handlePubsubMessage = async (event) => {
        const { topic, data, from } = event.detail;
        this.reputationManager.recordAction({ peerId: from }, ReputationManager.GENERAL_ACTIONS.PUBSUB_RECEIVED + topic);
        if (!this.validateTopic(topic)) {
            this.miniLogger.log(`Received message on unauthorized topic ${topic} from ${from}`, (m) => { console.warn(m); });
            return;
        }

        if (!(data instanceof Uint8Array)) { this.miniLogger.log(`Received non-binary data from ${from} dataset: ${data} topic: ${topic}`, (m) => { console.error(m); }); return; }
        const byteLength = data.byteLength;
       
        try {
            let parsedMessage;
            switch (topic) {
                case 'new_transaction':

                    this.miniLogger.log(`Received new transaction from ${from}`, (m) => { console.debug(m); });
                    if (data.byteLength > BLOCKCHAIN_SETTINGS.maxTransactionSize * 1.02) { this.miniLogger.log(`Transaction size exceeds the maximum allowed size from ${from}`, (m) => { console.error(m); }); return; }
                    parsedMessage = serializer.deserialize.transaction(data);
                    break;
                case 'new_block_candidate':
                    this.miniLogger.log(`Received new block candidate from ${from}`, (m) => { console.debug(m); });
                    if (data.byteLength > BLOCKCHAIN_SETTINGS.maxBlockSize * 1.02) { this.miniLogger.log(`Block candidate size exceeds the maximum allowed size from ${from}`, (m) => { console.error(m); }); return; }
                    parsedMessage = serializer.deserialize.block_candidate(data);
                    break;
                case 'new_block_finalized':
                    this.miniLogger.log(`Received new block finalized from ${from}`, (m) => { console.debug(m); });
                    if (data.byteLength > BLOCKCHAIN_SETTINGS.maxBlockSize * 1.02) { this.miniLogger.log(`Block finalized size exceeds the maximum allowed size from ${from}`, (m) => { console.error(m); }); return; }
                    parsedMessage = serializer.deserialize.block_finalized(data);
                    break;
                default:
                    parsedMessage = serializer.deserialize.rawData(data);
                    break;
            }

            const message = { content: parsedMessage, from, byteLength };
            this.emit(topic, message);

        } catch (error) { this.miniLogger.log(`Failed to parse pubsub message ${topic}, error: ${error.message}`, (m) => { console.error(m); });}
    }
    /** Validates a pubsub topic against the allowed topics. @param {string} topic - The topic to validate. */
    validateTopic(topic) {
        if (typeof topic !== 'string') {
            this.miniLogger.log(`Invalid topic type ${topic}, reason: Topic must be a string`, (m) => { console.warn(m); });
            return false;
        }
        if (!P2PNetwork.ALLOWED_TOPICS.has(topic)) {
            this.miniLogger.log(`Topic not allowed ${topic}`, (m) => { console.warn(m); });
            return false;
        }
        return true;
    }
    /** @param {string} topic @param {any} message - Can be any JavaScript object */
    async broadcast(topic, message) {
        //this.miniLogger.log(`Broadcasting message on topic ${topic}`, (m) => { console.debug(m); });
        if (this.peers.size === 0) { return new Error("No peers to broadcast to"); }
        try {
            let serialized;
            switch (topic) {
                case 'new_transaction':
                    serialized = serializer.serialize.transaction(message);
                    break;
                case 'new_block_candidate':
                    serialized = serializer.serialize.block_candidate(message);
                    break;
                case 'new_block_finalized':
                    serialized = serializer.serialize.block_finalized(message);
                    break;
                default:
                    serialized = serializer.serialize.rawData(message);
                    break;
            }

            await this.p2pNode.services.pubsub.publish(topic, serialized);
            this.miniLogger.log(`Broadcast complete on topic **${topic}**`, (m) => { console.debug(m); });
            return 'success';
        } catch (error) {
            if (error.message === "PublishError.NoPeersSubscribedToTopic") { return error; }
            this.miniLogger.log(`Broadcast error on topic **${topic}**`, (m) => { console.error(m); });
            this.miniLogger.log(error, (m) => { console.error(m); });
            return error;
        }
    }
    /**
      * @param {string} peerMultiaddr - The multiaddress of the peer.
      * @param {Object} message - The message to send.
      * @returns {Promise<Object>} The response from the peer.
      */
    async sendMessage(peerMultiaddr, message) {
        // Extract peerId using libp2p's multiaddr parsing for reliability
        let peerId;
        try {
            const ma = multiaddr(peerMultiaddr);
            const peerIdComponent = ma.getPeerId();
            if (!peerIdComponent) { throw new Error('Invalid multiaddr: Peer ID not found'); }
            peerId = peerIdComponent.toString();
        } catch (err) {
            this.miniLogger.log(`Failed to parse multiaddr ${peerMultiaddr}, error: ${err.message}`, (m) => { console.error(m); });
            throw err;
        }

        try {
            const stream = await this.acquireStream(peerId, peerMultiaddr);
            const response = await this.sendOverStream(stream, message);
            return response;
        } catch (error) {
            this.miniLogger.log(`Failed to send message to ${peerMultiaddr}, error: ${error.message}`, (m) => { console.error(m); });
            const peer = this.peers.get(peerId);
            if (peer && peer.stream && !peer.stream.closed) {
                try {
                    await peer.stream.close();
                    await peer.stream.reset();
                    this.updatePeer(peerId, { stream: null });
                    this.miniLogger.log(`Closed faulty stream after error with peer ${peerId}`, (m) => { console.debug(m); });
                } catch (closeErr) {
                    this.miniLogger.log(`Failed to close stream after error with peer ${peerId}, error: ${closeErr.message}`, (m) => { console.error(m); });
                }
            }
        }
    }
    /**
     * Acquires a valid stream for the given peer. Reuses existing streams if available and open,
     * otherwise creates a new stream.
     * @param {string} peerId - The ID of the peer.
     * @param {string} peerMultiaddr - The multiaddress of the peer.
     * @returns {Promise<Stream>} - The libp2p stream to use for communication.
     */
    async acquireStream(peerId, peerMultiaddr) {
        let stream;
        try {
            const abortController = new AbortController();
            const timeout = setTimeout(() => {
                abortController.abort();
            }, 300_000); 

            stream = await this.p2pNode.dialProtocol(peerMultiaddr, P2PNetwork.SYNC_PROTOCOL, { signal: abortController.signal });
            clearTimeout(timeout);

            this.updatePeer(peerId, { stream });
            this.miniLogger.log(`Created new stream with peer ${peerId}`, (m) => { console.debug(m); });
            return stream;
        } catch (error) {
            this.miniLogger.log(`Failed to acquire stream with peer ${peerId}, error: ${error.message}`, (m) => { console.error(m); });
            throw error;
        }
    }
    /**
     * Sends a serialized message over the provided stream and handles the response.
     * @param {Stream} stream - The libp2p stream to use for communication.
     * @param {Object} message - The message object to send.
     * @returns {Promise<Object>} - The response from the peer.
     */
    async sendOverStream(stream, message, timeoutMs = 1000) {
        const createTimeout = (ms) => {
            return new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Operation timed out after ${ms}ms`));
                }, ms);
            });
        };

        try {
            const lp = lpStream(stream);
            const serialized = serializer.serialize.rawData(message);

            // Write with timeout
            await Promise.race([ lp.write(serialized), createTimeout(timeoutMs) ]);

            this.miniLogger.log(`Message written to stream (${serialized.length} bytes)`, (m) => { console.info(m); });

            // Read with timeout
            const res = await Promise.race([ lp.read(), createTimeout(timeoutMs) ]);

            if (!res) { throw new Error('No response received (unexpected end of input)'); }

            this.miniLogger.log(`Response read from stream (${res.length} bytes)`, (m) => { console.info(m); });

            const response = serializer.deserialize.rawData(res.subarray());
            if (response.status !== 'error') {
                return response;
            }

            throw new Error(response.message);
        } catch (error) {
            this.miniLogger.log(`Error during sendOverStream, error: ${error.message}, timeout: ${timeoutMs}`, (m) => { console.error(m); });
            throw error;
        }
        finally {
            if (stream) {
                try {
                    stream.close();
                } catch (closeErr) {
                    this.miniLogger.log(`Failed to close stream, error: ${closeErr.message}`, (m) => { console.error(m); });
                }
            } else {
                this.miniLogger.log('Stream is undefined; cannot close stream', (m) => { console.warn(m); });
            }
        }
    }
    /** @param {string} topic @param {Function} [callback] */
    async subscribe(topic, callback) {
        // Check if already subscribed to topic
        if (this.subscriptions.has(topic)) {
            this.miniLogger.log(`Attempting to subscribe to already subscribed topic ${topic}`, (m) => { console.warn(m); });
            return;
        }

        this.miniLogger.log(`Subscribing to topic ${topic}`, (m) => { console.debug(m); });

        try {
            await this.p2pNode.services.pubsub.subscribe(topic);
            this.subscriptions.add(topic);
            
            if (callback) {
                this.on(topic, message => callback(topic, message));
            }
        } catch (error) {
            this.miniLogger.log(`Failed to subscribe to topic ${topic}, error: ${error.message}`, (m) => { console.error(m); });
            throw error;
        }
    }
    /** @param {string[]} topics @param {Function} [callback] */
    async subscribeMultipleTopics(topics, callback) {
        const uniqueTopics = [...new Set(topics)]; // Ensure topics are unique
        if (uniqueTopics.length !== topics.length) {
            this.miniLogger.log(`Duplicate topics detected in subscription request,
original count: ${topics.length},
unique count: ${uniqueTopics.length},
duplicates: ${topics.filter((topic, index) => topics.indexOf(topic) !== index)}`, (m) => { console.warn(m); });
        }

        await Promise.all(uniqueTopics.map((topic) => this.subscribe(topic, callback)));
    }
    /**  Unsubscribes from a topic and removes any associated callback @param {string} topic */
    async unsubscribe(topic) {
        if (!this.subscriptions.has(topic)) {
            this.miniLogger.log(`Attempting to unsubscribe from a topic that was not subscribed to ${topic}`, (m) => { console.error(m); });
            return;
        }
        try {
            await this.p2pNode.services.pubsub.unsubscribe(topic);
            this.p2pNode.services.pubsub.topics.delete(topic);
            this.subscriptions.delete(topic);
            this.miniLogger.log(`Unsubscribed from topic ${topic}`, (m) => { console.debug(m); });
        } catch (error) {
            this.miniLogger.log(`Error unsubscribing from topic ${topic}, error: ${error.message}`, (m) => { console.error(m); });
            throw error;
        }
    }
    /** @param {string} topic */
    getTopicBindingInfo(topic) {
        return {
            isSubscribed: this.subscriptions.has(topic),
            hasCallback: this.topicBindings.has(topic),
            callbackSource: this.topicBindings.get(topic)?.name || 'anonymous'
        };
    }
    /** @param {string} peerId @param {Object} data */
    updatePeer(peerId, data) {
        const existingPeer = this.peers.get(peerId) || {};
        const updatedPeer = {
            ...existingPeer,    // Preserve existing data
            ...data,            // Overwrite with new data
            lastSeen: this.timeSynchronizer.getCurrentTime(),
        };

        // Optionally, ensure that `address`, `stream`, and `dialable` are preserved if not provided in `data`
        if (data.address === undefined) {
            updatedPeer.address = existingPeer.address || null;
        }
        if (data.stream === undefined) {
            updatedPeer.stream = existingPeer.stream || null;
        }
        if (data.dialable === undefined) {
            updatedPeer.dialable = existingPeer.dialable !== undefined ? existingPeer.dialable : null;
        }

        this.peers.set(peerId, updatedPeer);
        this.miniLogger.log(`Peer ${peerId} updated`, (m) => { console.debug(m); });
        this.emit('peer:updated', peerId, data);
    }
    async disconnectPeer(identifier) {
        if (!this.p2pNode) return;

        const connections = this.p2pNode.getConnections();
        for (const connection of connections) {
            const peerId = connection.remotePeer.toString();
            const ip = connection.remoteAddr.nodeAddress().address;

            if (identifier === peerId || identifier === ip) {
                this.p2pNode.components.connectionManager.closeConnections(peerId);
                this.miniLogger.log(`Disconnected peer ${identifier}`, (m) => { console.info(m); });
            }
        }
    }
    closeConnection(peerId) {
        this.miniLogger.log(`Closing connections to ${peerId}`, (m) => { console.debug(m); });
        this.p2pNode.components.connectionManager.closeConnections(peerId);
    }
    /** @returns {string[]} */
    getConnectedPeers() {
        return Array.from(this.peers.keys());
    }
    getPeers() {
        return Object.fromEntries(this.peers);
    }
    /** @returns {string[]} */
    getSubscribedTopics() {
        return Array.from(this.subscriptions);
    }
    /** @returns {boolean} */
    isStarted() {
        return this.p2pNode && this.p2pNode.status === 'started';
    }
    // Connection Gating Methods
    async isDeniedPeer(peerId) {
        return this.reputationManager.isPeerBanned({ peerId: peerId.toString() });
    }
    async isDeniedMultiaddr(multiaddr) {
        const ip = multiaddr.nodeAddress().address.toString();
        const isBanned = this.reputationManager.isPeerBanned({ ip });
        return isBanned;
    }
    async isDeniedConnection(connection) {
        const peerId = connection.remotePeer.toString();
        const ip = connection.remoteAddr.nodeAddress().address;

        return this.reputationManager.isPeerBanned({ peerId }) ||
            this.reputationManager.isPeerBanned({ ip });
    }
    async isDeniedEncrypted(connection) {
        return this.isDeniedConnection(connection);
    }
    async isDeniedUpgraded(connection) {
        return this.isDeniedConnection(connection);
    }
    toUint8Array(hex) {
        if (hex.length % 2 !== 0) { throw new Error("The length of the input is not a multiple of 2."); }

        const length = hex.length / 2;
        const uint8Array = new Uint8Array(length);

        for (let i = 0, j = 0; i < length; ++i, j += 2) { uint8Array[i] = parseInt(hex.substring(j, j + 2), 16); }

        return uint8Array;
    }
}

export default P2PNetwork;
export { P2PNetwork };
