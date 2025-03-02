import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { convert, FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { EventEmitter } from 'events';
import { createLibp2p } from 'libp2p';
import { peerIdFromString } from '@libp2p/peer-id';
import { uPnPNAT } from '@libp2p/upnp-nat';

import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { kadDHT } from '@libp2p/kad-dht';
import { webRTCDirect, webRTC } from '@libp2p/webrtc';
import { circuitRelayTransport, circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { mplex } from '@libp2p/mplex';

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
 * @typedef {Object} sharedPeerUrls
 * @property {string[]} direct
 * @property {string[]} relayed
 * 
 * @typedef {Object<string, sharedPeerUrls>} sharedPeers // peerIdStr -> sharedPeerUrls
 */

class P2PNetwork extends EventEmitter {
    static maxChunkSize = 64 * 1024; // 64 KB
    static maxStreamBytes = 1024 * 1024 * 1024; // 1 GB
    iAmBootstrap = false;
    myAddr;
    timeSynchronizer;
    fastConverter = new FastConverter();

    static DIRECT_PORTS = ['27260', '27261', '27262', '27263', '27264', '27265', '27266', '27267', '27268', '27269'];
    static SYNC_PROTOCOL = '/blockchain-sync/1.0.0';
    static RELAY_SHARE_PROTOCOL = '/relay-share/1.0.0';
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
    targetBootstrapNodes = 3;
    totalOfDisconnections = 0;
    options = {
        bootstrapNodes: [],
        maxPeers: 12,
        logLevel: 'info',
        logging: true,
        listenAddresses: ['/ip4/0.0.0.0/tcp/0'],
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

    /** @param {string} uniqueHash - A unique 32 bytes hash to generate the private key from. */
    async start(uniqueHash) { // WebRTC
        const hash = uniqueHash ? uniqueHash : mining.generateRandomNonce(32).Hex;
        const hashUint8Array = convert.hex.toUint8Array(hash);
        const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hashUint8Array);
        const peerDiscovery = [mdns()];
        if (this.options.bootstrapNodes.length > 0) peerDiscovery.push( bootstrap({ list: this.options.bootstrapNodes }) );
        
        const listen = this.options.listenAddresses;
        if (!listen.includes('/p2p-circuit')) listen.push('/p2p-circuit');
        if (!listen.includes('/ip4/0.0.0.0/tcp/0')) listen.push('/ip4/0.0.0.0/tcp/0');

        try {
            const p2pNode = await createLibp2p({
                privateKey: privateKeyObject,
                streamMuxers: [ yamux() ],
                connectionEncrypters: [ noise() ],
                connectionGater: { denyDialMultiaddr: () => false },
                transports: [
                    circuitRelayTransport({ discoverRelays: 1 }),
                    tcp(),
                ],
                addresses: { listen },
                services: {
                    //uPnPNAT: uPnPNAT(),
                    dcutr: dcutr(),
                    autoNAT: autoNAT(),
                    pubsub: gossipsub(),
                    identify: identify(),
                    dht: kadDHT({ enabled: true }),
                    circuitRelay: circuitRelayServer({ reservations: { maxReservations: 6, reservationTtl: 60_000 } })
                },
                peerDiscovery
            });

            console.log('Listening on:')
            p2pNode.getMultiaddrs().forEach((ma) => console.log(ma.toString()))
            p2pNode.handle(P2PNetwork.RELAY_SHARE_PROTOCOL, this.#handleRelayShare.bind(this));

            p2pNode.addEventListener('self:peer:update', async (evt) => {
                console.log('\n -- selfPeerUpdate:');
                for (const addr of p2pNode.getMultiaddrs()) console.log(addr.toString());
            });

            /*p2pNode.addEventListener('self:peer:update', async (evt) => { // DEPRECATED
                const peers = await p2pNode.peerStore.all();
                for (const peer of peers) {
                    const peerId = peer.id;
                    //const dialable = await p2pNode.isDialable(peerId, { signal: AbortSignal.timeout(3000) });
                    try {
                        const peerInfo = await p2pNode.peerRouting.findPeer(peerId, { signal: AbortSignal.timeout(3_000) });
                        const multiaddrs = peerInfo.multiaddrs;
                        if (multiaddrs.length <= peer.addresses.length) continue;
                        console.log(`self:peer:update ${readableId(peerId.toString())} from ${peer.addresses.length} to ${multiaddrs.length} addresses`);
                        await p2pNode.peerStore.save(peerId, { multiaddrs });
                    } catch (error) {}
                }
            });*/
            p2pNode.services.circuitRelay.addEventListener('reservation', (evt) => {
                console.log('------');
                console.log('New relay reservation:', evt.detail);
                console.log('------');
            });

            // this.miniLogger.log(`P2P network started. PeerId ${readableId(p2pNode.peerId.toString())} | Listen addresses ${this.options.listenAddresses}`, (m) => { console.info(m); });
            this.miniLogger.log(`P2P network started. PeerId ${readableId(p2pNode.peerId.toString())}`, (m) => { console.info(m); });

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
    }
    
    async #handleRelayShare(lstream) { // PROBABLY FUCKED UP!!
        console.log('RELAY SHARE');
        /** @type {Stream} */
        const stream = lstream.stream;
        if (!stream) { return; }
        await stream.closeRead(); // nothing to read

        /** @type {sharedPeers} */
        const sharedPeerUrls = {};
        const cons = this.p2pNode.getConnections();
        for (const con of cons) {
            const maStr = con.remoteAddr.toString();
            if (maStr.includes('p2p-circuit')) continue; // Skip relayed connections
            if (!maStr.split('p2p/')[1]) continue;
            if (!maStr.split('tcp/')[1]) continue;
    
            const targetPeerIdStr = maStr.split('p2p/')[1].split('/')[0];
            const targetPort = maStr.split('tcp/')[1].split('/')[0];

            let targetMaStr = null;
            if (P2PNetwork.DIRECT_PORTS.includes(targetPort))
                targetMaStr = maStr; // direct connection
            else if (con.remotePeer.toString() === targetPeerIdStr)
                targetMaStr = maStr + '/p2p-circuit/p2p/' + this.p2pNode.peerId.toString(); // relayed connection
            
            if (!targetMaStr) continue;

            if (!sharedPeerUrls[targetPeerIdStr]) sharedPeerUrls[targetPeerIdStr] = { direct: [], relayed: [] };

            const type = targetMaStr.includes('p2p-circuit') ? 'relayed' : 'direct';
            sharedPeerUrls[targetPeerIdStr][type].push(targetMaStr);
        }

        const serializedMessage = serializer.serialize.rawData(sharedPeerUrls);
        console.info('SENDING RELAY SHARE RESPONSE:');
        console.info(sharedPeerUrls);
        await P2PNetwork.streamWrite(stream, serializedMessage);
    }
    /** @param {PeerId} peerId */
    async sendRelayShareRequest(peerId) {
        stream = await this.p2pNet.p2pNode.dialProtocol(peerId, P2PNetwork.RELAY_SHARE_PROTOCOL, { signal: AbortSignal.timeout(3000) });
        const readResult = await P2PNetwork.streamRead(stream);
    }
    async #updateConnexionResume() {
        const totalPeers = Object.keys(this.peers).length || 0;
        const connectedBootstraps = Object.keys(this.connectedBootstrapNodes).length;
        let totalBootstraps = this.iAmBootstrap ? this.options.bootstrapNodes.length - 1 : this.options.bootstrapNodes.length;
        this.connexionResume = { totalPeers, connectedBootstraps, totalBootstraps };

        const allPeers = await this.p2pNode.peerStore.all();
        const allPeersIdStr = allPeers.map(peer => peer.id.toString());
        this.miniLogger.log(`Connected to ${totalPeers} peers (${connectedBootstraps}/${totalBootstraps} bootstrap nodes) | ${allPeers.length} peers in peerStore`, (m) => { console.info(m); });
    }
    #handlePeerDiscovery = async (event) => {
        /** @type {PeerId} */
        const peerId = event.detail.id;
        const peerIdStr = peerId.toString();
        const connections = this.p2pNode.getConnections(peerId); //? NOT PeerID ?

        const discoveryMultiaddrs = event.detail.multiaddrs;
        const multiaddrs = connections.map(con => con.remoteAddr);

        const allPeers = await this.p2pNode.peerStore.all();
        const allPeersIdStr = allPeers.map(peer => peer.id.toString());
        console.log(`-------- DISCOVERY: ${allPeers.length} peers --------`);

        const multiAddrsToTry = [];
        for (const addr of discoveryMultiaddrs) {
            const matStr = multiAddrsToTry.map(addr => addr.toString());
            if (!matStr.includes(addr.toString())) multiAddrsToTry.push(addr);
        }
        for (const addr of multiaddrs) {
            const matStr = multiAddrsToTry.map(addr => addr.toString());
            if (!matStr.includes(addr.toString())) multiAddrsToTry.push(addr);
        }

        if (multiAddrsToTry.length === 0) {
            try {
                const peerInfo = await this.p2pNode.peerRouting.findPeer(peerIdStr, { signal: AbortSignal.timeout(3000) });
                const multiAddrs = peerInfo.multiaddrs;
                if (multiAddrs.length === 0) { console.error('No multiaddrs', peerIdStr); return; }
                const con = await this.p2pNode.dial(multiAddrs, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                await con.newStream(P2PNetwork.SYNC_PROTOCOL);
                this.miniLogger.log(`(Discovery) Dialed relay node ${relayAddr}`, (m) => { console.debug(m); });
            } catch (error) { console.error(error.message); }
            console.log('No multiaddrs', peerIdStr);
            return;
        }

        // if one address contains "p2p/" it can be added to p2pDiscoveryArray
        /*for (const addr of discoveryMultiaddrs) {
            if (!addr.toString().includes('p2p/')) continue;
            
            await this.p2pNode.peerStore.save(peerId, { multiaddrs: discoveryMultiaddrs });
            break;
        }*/

        //const nbOfOutboundConnections = connections.filter(con => con.direction === 'outbound').length;
        //if (nbOfOutboundConnections > 0) { await this.#updateConnexionResume(); return; }
        try {
            await this.p2pNode.dialProtocol(multiAddrsToTry, P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(this.options.dialTimeout) });
            const connectionsUpdated = this.p2pNode.getConnections(peerId);
            this.#updatePeer(peerIdStr, { dialable: true, id: peerId }, 'discovered');
        } catch (err) {
            this.miniLogger.log(`(Discovery) Failed to dial peer ${readableId(peerIdStr)}`, (m) => { console.error(m); });
        }

        await this.#updateConnexionResume();
    };
    /** @param {CustomEvent} event */
    #handlePeerConnect = async (event) => {
        /** @type {PeerId} */
        const peerId = event.detail;
        const peerIdStr = peerId.toString();
        this.miniLogger.log(`(Connect) dial from peer ${readableId(peerIdStr)} success`, (m) => { console.debug(m); });

        const isBanned = this.reputationManager.isPeerBanned({ peerId: peerIdStr });
        this.reputationManager.recordAction({ peerId: peerIdStr }, ReputationManager.GENERAL_ACTIONS.CONNECTION_ESTABLISHED);
        //if (isBanned) { this.closeConnection(peerIdStr, 'Banned peer'); return; }

        const connections = this.p2pNode.getConnections(peerId);
        const multiaddrs = connections.map(con => con.remoteAddr);
        if (!multiaddrs) {
            console.error('No multiaddrs'); return; }

        //if (!this.connectedBootstrapNodes[peerIdStr]) this.connectedBootstrapNodes[peerIdStr] = multiaddrs.toString().split('/p2p/')[0];

        try {
            await this.p2pNode.dialProtocol(peerId, P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(this.options.dialTimeout) });
            this.miniLogger.log(`(Connect) dial to peer ${readableId(peerIdStr)} success`, (m) => { console.debug(m); });
        } catch (error) { console.error(error.message); }

        /*await new Promise(resolve => setTimeout(resolve, 5000));

        const peerInfo = await this.p2pNode.peerRouting.findPeer(peerId, { signal: AbortSignal.timeout(3000) });

        for (const addr of multiaddrs) {
            const addrStr = addr.toString();
            const targetPeerIdStr = addrStr.split('p2p/')[1].split('/')[0];
			if (!targetPeerIdStr || relayPeerIdStr === targetPeerIdStr) continue;

            try {
                const relayAddresses = peerInfo.multiaddrs.filter(addr => addr.toString().split('/').pop() === 'p2p-circuit');
                if (relayAddresses.length === 0) { throw new Error('No relay addresses'); }

                //const con = await this.p2pNode.dial(relayAddresses, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                await con.newStream(P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(this.options.dialTimeout) });
            } catch (error) { console.error(error.message); }

            break;
        }*/

        this.#updatePeer(peerIdStr, { dialable: true, id: peerId }, 'connected');
        await this.#updateConnexionResume();
    };
    /** @param {CustomEvent} event */
    #handlePeerDisconnect = async (event) => {
        this.totalOfDisconnections++;
        /** @type {PeerId} */
        const peerId = event.detail;
        const peerIdStr = peerId.toString();
        this.miniLogger.log(`--------> Peer ${readableId(peerIdStr)} disconnected`, (m) => { console.debug(m); });
        if (this.peers[peerIdStr]) delete this.peers[peerIdStr];
        if (this.connectedBootstrapNodes[peerIdStr]) delete this.connectedBootstrapNodes[peerIdStr];
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
    #isBootstrapNodeAlreadyConnected(addr) {
        for (const peerIdStr in this.connectedBootstrapNodes) {
            if (this.connectedBootstrapNodes[peerIdStr] === addr) { return true; }
        }
        return false;
    }
    async #connectToBootstrapNodes() {
        const promises = [];
        for (const addr of this.options.bootstrapNodes) {
            if (this.myAddr === addr) { this.iAmBootstrap = true; continue; } // Skip if recognize as myself
            if (this.#isBootstrapNodeAlreadyConnected(addr)) { continue; } // Skip if already connected

            const ma = multiaddr(addr);
            const isBanned = this.reputationManager.isPeerBanned({ ip: ma.toString() });
            //this.miniLogger.log(`Connecting to bootstrap node ${addr}`, (m) => { console.info(m); });

            promises.push(this.p2pNode.dial(ma, { signal: AbortSignal.timeout(this.options.dialTimeout) })
                .then(async con => {
                    await con.newStream(P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                    const peerIdStr = con.remotePeer.toString();
                    this.connectedBootstrapNodes[peerIdStr] = addr;
                    console.log('--- CONNECT TO BOOTSTRAP ---> ', addr.toString());
                    // try to init relay transport

                    await new Promise(resolve => setTimeout(resolve, 5000)); // time to get the relay addresses
                    
                    const peerId = peerIdFromString(peerIdStr);
                    try {
                        const peerInfo = await this.p2pNode.peerRouting.findPeer(peerId, { signal: AbortSignal.timeout(3000) });
                        const relayAddresses = peerInfo.multiaddrs.filter(addr => addr.toString().split('/').pop() === 'p2p-circuit');
                        if (relayAddresses.length === 0) { throw new Error('No relay addresses'); }
                        
                        await this.p2pNode.dial(relayAddresses, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                        console.log('--- RELAY DIALED ON ADDRS ---> ', relayAddresses.map(addr => addr.toString()));
                    } catch (error) { console.error(error.message); }
                    
                    return;
                    // try to init webrtc direct
                    try {
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        const connections = this.p2pNode.getConnections(peerId);
                        const multiaddrs = connections.map(con => con.remoteAddr);
                        
                        const peer = await this.p2pNode.peerStore.get(con.remotePeer); // TODO LOOK THIS
                        const webRtcAddrs = [];
                        for (const addrObj of peer.addresses) {
                            if (!addrObj.isCertified) continue; // Skip non-certified addresses
                            if (!addrObj.multiaddr.toString().includes('webrtc-direct')) continue; // Skip non-webrtc addresses
                            //const splitWebRtcAdd = addrObj.multiaddr.toString().split('/');
                            //const protocol = splitWebRtcAdd[1]; // probably ip4
                            
                            //const usableConAddr = multiaddrs.find(addr => addr.toString().includes(protocol));
                            //if (!usableConAddr) break;

                            //const splitConAdd = usableConAddr.toString().split('/');
                            //splitWebRtcAdd[2] = splitConAdd[2]; // replace ip

                            const splitConAdd = multiaddrs[0].toString().split('/');
                            const splitStoreAdd = addrObj.multiaddr.toString().split('/');
                            splitStoreAdd[1] = splitConAdd[1]; // replace protocol
                            splitStoreAdd[2] = splitConAdd[2]; // replace ip
                            const publicRtcAddr = splitStoreAdd.join('/');
                            webRtcAddrs.push(multiaddr(publicRtcAddr));
                        }

                        if (peerIdStr !== '12D3KooWEKjHKUrLW8o8EAL9wofj2LvWynFQZzx1kLPYicd4aEBX') return;
                        if (webRtcAddrs.length === 0) { throw new Error('No webrtc addrs'); }
                        await this.p2pNode.dial(webRtcAddrs, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                        console.log('--- RELAY DIALED ON WEBRTC ADDRS ---> ', webRtcAddrs.map(addr => addr.toString()));


                        console.log('MULTIADDRS', multiaddrs.map(addr => addr.toString()));
                        await this.p2pNode.dial(multiaddrs);
                        //const uma = this.p2pNode.getConnections(peerId).map(con => con.remoteAddr);
                    } catch (error) {
                        console.error(error.message);
                    }
                })
                .catch(async err => {
                    if (err.message === 'Can not dial self') {
                        this.myAddr = addr;
                        this.iAmBootstrap = true;

                        await this.p2pNode.services.dht.setMode('server');
                        //setTimeout(async () => await this.p2pNode.services.dht.setMode('server'), 10000);
                        this.miniLogger.log(']]]]]]]]]]]]]]]]]]]]][[[[[[[[[[[[[[[[[[[[[', (m) => { console.info(m); });
                        this.miniLogger.log(`]]] I AM BOOTSTRAP! DHT SERVER ENABLED [[[`, (m) => { console.info(m); });
                        this.miniLogger.log(']]]]]]]]]]]]]]]]]]]]][[[[[[[[[[[[[[[[[[[[[', (m) => { console.info(m); });
                    } else {
                        console.error(err.message);
                        //this.miniLogger.log(`Failed to connect to bootstrap node ${addr}`, (m) => { console.error(m); });
                    }
                })
            );
        }

        await Promise.allSettled(promises);

        await this.#updateConnexionResume();
    }
    async stop() {
        if (this.p2pNode) { await this.p2pNode.stop(); }
        this.miniLogger.log(`P2P network ${this.p2pNode.peerId.toString()} stopped`, (m) => { console.info(m); });
        await this.reputationManager.shutdown();
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
        } catch (error) { console.error(error.message); return false; }
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
        this.miniLogger.log(`--{ Peer } ${readableId(peerIdStr)} updated ${reason ? `for reason: ${reason}` : ''}`, (m) => { console.debug(m); });
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
        const message = `Closing connection to ${readableId(peerIdStr)}${reason ? ` for reason: ${reason}` : ''}`;
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