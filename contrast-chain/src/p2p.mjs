import { EventEmitter } from 'events';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { bootstrap } from '@libp2p/bootstrap';
import { lpStream } from 'it-length-prefixed-stream';
import utils from './utils.mjs';
import { multiaddr } from '@multiformats/multiaddr';
import ReputationManager from './peers-reputation.mjs'; // Import the ReputationManager
import { yamux } from '@chainsafe/libp2p-yamux';
import { Logger } from '../plugins/logger.mjs';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';

/**
 * @typedef {import("../plugins/time.mjs").TimeSynchronizer} TimeSynchronizer
 */

class P2PNetwork extends EventEmitter {
    /** @param {Object} [options={}] */
    constructor(options = {}, timeSynchronizer, logger) {
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
        this.logger = logger;
        if (this.logger === undefined) {
            this.logger = new Logger();
        }
        // Initialize ReputationManager
        this.reputationManager = new ReputationManager(this.options.reputationOptions);

        // Event listener for when an identifier is banned
        this.reputationManager.on('identifierBanned', ({ identifier }) => {
            //this.disconnectPeer(identifier);
            this.logger.info('luid-f7a23b4c Peer banned and disconnected', { identifier });
        });

        // Event listener for when an identifier is unbanned
        this.reputationManager.on('identifierUnbanned', ({ identifier }) => {
            this.logger.info(`luid-04ed05eb Identifier ${identifier} has been unbanned`, { identifier });
        });

    }

    /** @type {string} */
    static SYNC_PROTOCOL = '/blockchain-sync/1.0.0';

    static ALLOWED_TOPICS = new Set(['new_transaction', 'new_block_candidate', 'new_block_finalized']);

    async start(_uniqueHash) {
        let uniqueHash = _uniqueHash ? _uniqueHash : utils.mining.generateRandomNonce(32).Hex;
        const hashUint8Array = this.toUint8Array(uniqueHash);
        const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hashUint8Array);
        try {
            this.p2pNode = await this.#createLibp2pNode(privateKeyObject);
            await this.p2pNode.start();
            this.logger.info('luid-b4d2ba42 P2P network started', { peerId: this.p2pNode.peerId, listenAddress: this.options.listenAddress });
            this.#setupEventListeners();
            await this.connectToBootstrapNodes();
        } catch (error) {
            this.logger.error('luid-c2967a8b Failed to start P2P network', { component: 'P2PNetwork', error: error.message });
            throw error;
        }
    }
    async stop() {
        if (this.p2pNode) {
            await this.p2pNode.stop();
            this.logger.info('luid-44ec7003 P2P network stopped', { component: 'P2PNetwork', peerId: this.p2pNode.peerId.toString() });
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
                this.logger.info('luid-9167c650 Connecting to bootstrap node', { component: 'P2PNetwork bootstrap', bootstrapNode: addr, isBanned });
                await this.p2pNode.dial(ma, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                this.logger.info('luid-deffa2f2 Connected to bootstrap node', { component: 'P2PNetwork', bootstrapNode: addr });
                const peerId = ma.getPeerId();
                if (peerId) { this.updatePeer(peerId.toString(), { dialable: true });}
            } catch (err) {
                this.logger.error('luid-b240757b Failed to connect to bootstrap node', { component: 'P2PNetwork', bootstrapNode: addr, error: err.message });
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
        this.logger.info('luid-dd80c851 Peer discovered', { peerId, isBanned });

        if (!peerMultiaddrs || peerMultiaddrs.length === 0) {
            this.logger.error('luid-e142f758 Failed to find multiaddrs for peer', { component: 'P2PNetwork', peerId });
            return;
        }
        try {
            const isBanned = this.reputationManager.isPeerBanned({ ip: peerMultiaddrs.toString() });
            this.logger.info('luid-2b00a032 Dialing after discovery', { peerMultiaddrs, isBanned });
            await this.p2pNode.dial(peerMultiaddrs, { signal: AbortSignal.timeout(this.options.dialTimeout) });
            this.updatePeer(peerId, { dialable: true });
        }
        catch (error) {
            this.logger.error('luid-df1fa9c4 Failed to dial peer', { component: 'P2PNetwork', peerId, error: error.message });
            this.updatePeer(peerId, { dialable: false });
        }
    };
    /** @param {CustomEvent} event */
    #handlePeerConnect = (event) => {
        const peerId = event.detail.toString();
        this.logger.debug('luid-2878c082 Peer connected', { peerId });

        const isBanned = this.reputationManager.isPeerBanned({ peerId });
        this.reputationManager.recordAction({ peerId }, ReputationManager.GENERAL_ACTIONS.CONNECTION_ESTABLISHED);

        if (isBanned) {
            this.logger.warn('luid-33c7015e Peer is banned, closing connection', { peerId });
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
        this.logger.debug('luid-69a1977c Peer disconnected', { peerId });
        this.peers.delete(peerId);
    };
    async dial(peerId) {
        try {
            const con = await this.p2pNode.dial(peerId);
            this.logger.debug('luid-e3c31ac5 Dialed peer', { component: 'P2PNetwork', peerId, address: con.remoteAddr.toString() });
            this.updatePeer(peerId.toString(), { status: 'dialed', address: con.remoteAddr.toString(), dialable: true });
        } catch (error) {
            this.logger.error('luid-05b05850 Failed to dial peer', { component: 'P2PNetwork', peerId, error: error.message });
            this.updatePeer(peerId.toString(), { dialable: false });
            throw error;
        }
    }
    async createStream(peerId, protocol) {
        try {
            const stream = await this.p2pNode.dialProtocol(peerId, protocol);
            this.logger.debug('luid-9fd7aa8f Stream created', { component: 'P2PNetwork', peerId, protocol });
            this.updatePeer(peerId.toString(), { stream });
            return stream;
        } catch (error) {
            this.logger.error('luid-8dbfb594 Failed to create stream', { component: 'P2PNetwork', peerId, protocol, error: error.message });
            throw error;
        }
    }
    /** @param {CustomEvent} event */
    #handlePubsubMessage = async (event) => {
        const { topic, data, from } = event.detail;
        this.reputationManager.recordAction({ peerId: from }, ReputationManager.GENERAL_ACTIONS.PUBSUB_RECEIVED + topic);
        if (!this.validateTopic(topic)) {
            this.logger.warn('luid-42d36d6e luid-topic-validation Received message on unauthorized topic', { topic, from });
            return;
        }
        if (!(data instanceof Uint8Array)) { this.logger.error(`luid-db87846b Received non-binary data from ${from} dataset: ${data} topic: ${topic}`); return; }
        const byteLength = data.byteLength;
       
        try {
            let parsedMessage;
            switch (topic) {
                case 'new_transaction':

                    this.logger.debug('luid-7a511836 Received new transaction', { component: 'P2PNetwork', topic, from });
                    if (data.byteLength > utils.SETTINGS.maxTransactionSize * 1.02) { this.logger.error('luid-ed4b8d0b Transaction size exceeds the maximum allowed size', { component: 'P2PNetwork', topic, from }); return; }
                    parsedMessage = utils.serializerFast.deserialize.transaction(data);
                    break;
                case 'new_block_candidate':
                    this.logger.debug('luid-a305d036 Received new block candidate', { component: 'P2PNetwork', topic, from });
                    if (data.byteLength > utils.SETTINGS.maxBlockSize * 1.02) { this.logger.error('luid-bb4b664c Block candidate size exceeds the maximum allowed size', { component: 'P2PNetwork', topic, from }); return; }
                    parsedMessage = utils.serializer.block_candidate.fromBinary_v4(data);
                    break;
                case 'new_block_finalized':
                    this.logger.debug('luid-3431060a Received new block finalized', { component: 'P2PNetwork', topic, from });
                    if (data.byteLength > utils.SETTINGS.maxBlockSize * 1.02) { this.logger.error('luid-d4e9de17 Block finalized size exceeds the maximum allowed size', { component: 'P2PNetwork', topic, from }); return; }
                    parsedMessage = utils.serializer.block_finalized.fromBinary_v4(data);
                    break;
                default:
                    parsedMessage = utils.serializer.rawData.fromBinary_v1(data);
                    break;
            }

            const message = { content: parsedMessage, from, byteLength };
            this.emit(topic, message);

        } catch (error) { this.logger.error('luid-801de822 Failed to parse pubsub message', { component: 'P2PNetwork', topic, error: error.message });}
    }
    /**
     * Validates a pubsub topic against the allowed topics.
     * @param {string} topic - The topic to validate.
     * @returns {boolean} - Returns true if the topic is allowed, otherwise false.
     */
    validateTopic(topic) {
        if (typeof topic !== 'string') {
            this.logger.warn('luid-be3516e1 Invalid topic type', { topic, reason: 'Topic must be a string' });
            return false;
        }
        if (!P2PNetwork.ALLOWED_TOPICS.has(topic)) {
            this.logger.warn('luid-d0ad52f1 Topic not allowed', { topic });
            return false;
        }
        return true;
    }
    /** @param {string} topic @param {any} message - Can be any JavaScript object */
    async broadcast(topic, message) {
        //this.logger.debug({ component: 'P2PNetwork', topic }, 'Broadcasting message');
        if (this.peers.size === 0) { return new Error("No peers to broadcast to"); }
        try {
            let serialized;
            switch (topic) {
                case 'new_transaction':
                    serialized = utils.serializerFast.serialize.transaction(message);
                    break;
                case 'new_block_candidate':
                    serialized = utils.serializer.block_candidate.toBinary_v4(message);
                    break;
                case 'new_block_finalized':
                    serialized = utils.serializer.block_finalized.toBinary_v4(message);
                    break;
                default:
                    serialized = utils.serializer.rawData.toBinary_v1(message);
                    break;
            }

            await this.p2pNode.services.pubsub.publish(topic, serialized);
            this.logger.debug('luid-4937c817 Broadcast complete', { component: 'P2PNetwork', topic });
            return 'success';
        } catch (error) {
            if (error.message === "PublishError.NoPeersSubscribedToTopic") { return error; }
            this.logger.error('luid-8e340d55 Broadcast error', { component: 'P2PNetwork', topic, error: error });
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
            this.logger.error('luid-f03a471a Failed to parse multiaddr', { component: 'P2PNetwork', peerMultiaddr, error: err.message });
            throw err;
        }

        try {
            const stream = await this.acquireStream(peerId, peerMultiaddr);
            const response = await this.sendOverStream(stream, message);
            return response;
        } catch (error) {
            this.logger.error('luid-b2d7c0a9 Failed to send message', { component: 'P2PNetwork', peerMultiaddr, peerId, error: error.message });
            const peer = this.peers.get(peerId);
            if (peer && peer.stream && !peer.stream.closed) {
                try {
                    await peer.stream.close();
                    await peer.stream.reset();
                    this.updatePeer(peerId, { stream: null });
                    this.logger.debug('luid-c8221f8c Closed faulty stream after error', { component: 'P2PNetwork', peerId });
                } catch (closeErr) {
                    this.logger.error('luid-cb6e42b1 Failed to close stream after error', { component: 'P2PNetwork', peerId, error: closeErr.message });
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
            this.logger.debug('luid-64097d47 Created new stream', { component: 'P2PNetwork', peerId });
            return stream;
        } catch (error) {
            this.logger.error('luid-9dee0369 Failed to acquire stream', { component: 'P2PNetwork', peerId, error: error.message });
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
            const serialized = utils.serializer.rawData.toBinary_v1(message);

            // Write with timeout
            await Promise.race([
                lp.write(serialized),
                createTimeout(timeoutMs)
            ]);

            this.logger.info('luid-e99e2dac Message written to stream', { component: 'P2PNetwork', length: serialized.length });

            // Read with timeout
            const res = await Promise.race([
                lp.read(),
                createTimeout(timeoutMs)
            ]);

            if (!res) {
                throw new Error('No response received (unexpected end of input)');
            }

            this.logger.info('luid-d7de89d1 Response read from stream', { component: 'P2PNetwork', response_bytes: res.length });

            const response = utils.serializer.rawData.fromBinary_v1(res.subarray());
            if (response.status !== 'error') {
                return response;
            }

            throw new Error(response.message);
        } catch (error) {
            this.logger.error('luid-c50b7bfb Error during sendOverStream', { component: 'P2PNetwork', error: error.message, timeout: timeoutMs });
            throw error;
        }
        finally {
            if (stream) {
                try {
                    stream.close();
                } catch (closeErr) {
                    this.logger.error('luid-d0cd7dc0 Failed to close stream', { error: closeErr.message });
                }
            } else {
                this.logger.warn('luid-07277de5 Stream is undefined; cannot close stream');
            }
        }
    }
    /** @param {string} topic @param {Function} [callback] */
    async subscribe(topic, callback) {
        // Check if already subscribed to topic
        if (this.subscriptions.has(topic)) {
            this.logger.warn('luid-7b1b1b7d Attempting to subscribe to already subscribed topic', { component: 'P2PNetwork', topic });
            return;
        }

        this.logger.debug('luid-0f2f018d Subscribing to topic', { component: 'P2PNetwork', topic });

        try {
            await this.p2pNode.services.pubsub.subscribe(topic);
            this.subscriptions.add(topic);
            
            if (callback) {
                this.on(topic, message => callback(topic, message));
            }
        } catch (error) {
            this.logger.error('luid-fc18ad60 Failed to subscribe to topic', { component: 'P2PNetwork', topic, error: error.message });
            throw error;
        }
    }
    /** @param {string[]} topics @param {Function} [callback] */
    async subscribeMultipleTopics(topics, callback) {
        const uniqueTopics = [...new Set(topics)]; // Ensure topics are unique
        if (uniqueTopics.length !== topics.length) {
            this.logger.warn('luid-e1878159 Duplicate topics detected in subscription request', {
                component: 'P2PNetwork',
                originalCount: topics.length,
                uniqueCount: uniqueTopics.length,
                duplicates: topics.filter((topic, index) => topics.indexOf(topic) !== index)
            });
        }

        await Promise.all(uniqueTopics.map((topic) => this.subscribe(topic, callback)));
    }
    /** 
     * Unsubscribes from a topic and removes any associated callback
     * @param {string} topic 
     */
    async unsubscribe(topic) {
        if (!this.subscriptions.has(topic)) {
            this.logger.error('luid-7c191bc3 Attempting to unsubscribe from a topic that was not subscribed to', {
                component: 'P2PNetwork',
                topic
            });
            return;
        }
        try {
            await this.p2pNode.services.pubsub.unsubscribe(topic);
            this.p2pNode.services.pubsub.topics.delete(topic);
            this.subscriptions.delete(topic);
            this.logger.debug('luid-4d686b67 Unsubscribed from topic', { component: 'P2PNetwork',topic });
        } catch (error) {
            this.logger.error('luid-fb112b3b Error unsubscribing from topic', {component: 'P2PNetwork',topic,error: error.message});
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
        this.logger.debug('luid-3d55ce46 Peer updated', { component: 'P2PNetwork', peerId });
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
                this.logger.info('luid-9d42e1f5 Disconnected peer', { identifier });
            }
        }
    }
    closeConnection(peerId) {
        this.logger.debug(`luid-09602c57 Closing connections to ${peerId}`);
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
