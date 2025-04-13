import { convert, FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { PeersManager } from './p2p-peers-manager.mjs';

import { EventEmitter } from 'events';
import { createLibp2p } from 'libp2p';
import { peerIdFromString } from '@libp2p/peer-id';

import { tcp } from '@libp2p/tcp';
//import { webRTCDirect, webRTC } from '@libp2p/webrtc'; // very heavy, uninstalled
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';

import { identify } from '@libp2p/identify';
import { uPnPNAT } from '@libp2p/upnp-nat';
//import { mdns } from '@libp2p/mdns'; // uninstalled
//import { kadDHT } from '@libp2p/kad-dht'; // uninstalled
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';

// LIBP2P UTILS
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { multiaddr } from '@multiformats/multiaddr';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { PROTOCOLS, STREAM, FILTERS, P2P_OPTIONS, PUBSUB } from './p2p-utils.mjs';

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
    peersManager = new PeersManager(); // vanilla interface to manage peers
    fastConverter = new FastConverter();
    subscriptions = new Set();
    miniLogger = new MiniLogger('P2PNetwork');
    timeSynchronizer;
    myIpAddr; // my ip address (only filled if I am a bootstrap node)
    addresses = []; // my listening addresses
    myRelayCircuitAddrs = {}; // my relay circuit addresses by relayPeerIdStr (endWith('/p2p-circuit'))
    connectedBootstrapNodes = {};
    connexionResume = { totalPeers: 0, connectedBootstraps: 0, totalBootstraps: 0, relayedPeers: 0 };
    targetBootstrapNodes = 2;
    options = {
        bootstrapNodes: [],
        maxPeers: 12,
        maxRelayedPeers: 8,
        logLevel: 'info',
        logging: true,
        listenAddresses: [], // '/ip4/0.0.0.0/tcp/27260', '/ip4/0.0.0.0/tcp/0'
        dialTimeout: 3000
    };

    /** @type {Libp2p} */
    p2pNode;
    /** @type {Object<string, Peer>} */
    peers = {}; // should be replaced by peersManager
    
    /** @param {TimeSynchronizer} timeSynchronizer @param {string[]} [listenAddresses] */
    constructor(timeSynchronizer, listenAddresses = []) {
        super();
        this.timeSynchronizer = timeSynchronizer;
        this.peersManager.timeSynchronizer = timeSynchronizer;
        for (const addr of listenAddresses)
            if (!this.options.listenAddresses.includes(addr)) this.options.listenAddresses.push(addr);
    }

    /** @param {string} uniqueHash - A unique 32 bytes hash to generate the private key from. */
    async start(uniqueHash, isRelayCandidate = true) {
        if (this.options.bootstrapNodes.length === 0) throw new Error('No bootstrap nodes provided');
        const hash = uniqueHash ? uniqueHash : mining.generateRandomNonce(32).Hex;
        const hashUint8Array = convert.hex.toUint8Array(hash);
        const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hashUint8Array);
        //const dhtService = kadDHT({ enabled: true, randomWalk: true });
        //const peerDiscovery = [dhtService]; // mdns()
        //if (this.options.bootstrapNodes.length > 0) peerDiscovery.push( bootstrap({ list: this.options.bootstrapNodes }) );
        //const peerDiscovery = [bootstrap({ list: this.options.bootstrapNodes })];

        /*if (isRelayCandidate) listen.push('/p2p-circuit') // should already listen the open ports
        else listen.push('/ip4/0.0.0.0/tcp/0');*/

        // IN TESTING
        const listen = this.options.listenAddresses;
        if (!isRelayCandidate) listen.push('/p2p-circuit');
        //listen.push('/p2p-circuit');

        try {
            const p2pNode = await createLibp2p({
                privateKey: privateKeyObject,
                streamMuxers: [yamux()],
                connectionEncrypters: [noise()],
                //connectionGater: {denyDialMultiaddr: () => false},
                transports: [
                    tcp({
                        inboundSocketInactivityTimeout: 30_000,
                        outboundSocketInactivityTimeout: 30_000,
                        dialOpts: { keepAlive: true },
                        listenOpts: { keepAlive: true }
                    }),
                    circuitRelayTransport({ discoverRelays: isRelayCandidate ? 0 : 2, relayFilter: FILTERS.filterRelayAddrs })
                ], //webRTCDirect(),
                addresses: {
                    listen,
                    announceFilter: (addrs) => FILTERS.multiAddrs(addrs, 'PUBLIC', undefined, [27260, 27269]),
                },
                services: {
                    identify: identify(),
                    pubsub: gossipsub(),
                    //dht: dhtService,
                    dcutr: dcutr(),
                    autoNAT: autoNAT(),
                    nat: uPnPNAT({ description: 'contrast-node', ttl: 7200, keepAlive: true }),
                    ...(isRelayCandidate && {circuitRelay: circuitRelayServer({
                        reservations: {
                            maxReservations: 6,
                            applyDefaultLimit: false
                        }
                    })})
                },
                peerDiscovery: []
                //peerDiscovery // temporary
            });

            //TODO: probably useless because the emitter of this update handle a connection event
            const myPeerIdStr = p2pNode.peerId.toString();
            p2pNode.addEventListener('self:peer:update', async (evt) => {
                if (evt.detail.peer.addresses.length === 0) return;
                console.log(`\n -- selfPeerUpdate (${evt.detail.peer.addresses.length}):`);
                
                const now = this.timeSynchronizer?.getCurrentTime() || Date.now();
                const publicAddrs = FILTERS.multiAddrs(evt.detail.peer.addresses.map(obj => obj.multiaddr), 'PUBLIC', undefined, [27260, 27269]);
                const peerAddrsStr = publicAddrs.map(addr => addr.toString());
                for (const addrStr of peerAddrsStr) { // search for new addresses
                    if (this.addresses.includes(addrStr)) continue;
                    this.peersManager.digestSelfUpdateAddEvent(myPeerIdStr, addrStr, now);
                    this.broadcast('self:pub:update:add', { addrStr, timestamp: now });
                }

                for (const addrStr of this.addresses) { // search for removed addresses
                    if (peerAddrsStr.includes(addrStr)) continue;
                    this.peersManager.digestSelfUpdateRemoveEvent(myPeerIdStr, addrStr, now);
                    this.broadcast('self:pub:update:remove', { addrStr, timestamp: now });
                }

                this.addresses = peerAddrsStr; // local update
            });
            
            p2pNode.addEventListener('peer:connect', this.#handlePeerConnect);
            p2pNode.addEventListener('peer:disconnect', this.#handlePeerDisconnect);
            p2pNode.addEventListener('peer:discovery', this.#handlePeerDiscovery);
            p2pNode.addEventListener('transport:listening', this.#handleListening);

            p2pNode.services.pubsub.addEventListener('message', this.#handlePubsubMessage);
            p2pNode.services.pubsub.subscribe('self:pub:update:add');
            p2pNode.services.pubsub.subscribe('self:pub:update:remove');
            p2pNode.services.pubsub.subscribe('pub:connect');
            p2pNode.services.pubsub.subscribe('pub:disconnect');

            p2pNode.handle(PROTOCOLS.RELAY_SHARE, this.#handleRelayShare);
            console.log(p2pNode.getProtocols())

            this.peersManager.idStr = myPeerIdStr;
            this.miniLogger.log(`P2P network started. PeerId ${readableId(myPeerIdStr)} - ${isRelayCandidate ? 'RELAY ENABLED' : 'RELAY DISABLED'}`, (m) => console.info(m));
            this.p2pNode = p2pNode;
        } catch (error) {
            this.miniLogger.log('Failed to start P2P network', (m) => { console.error(m); });
            this.miniLogger.log(error.stack, (m) => { console.error(m); });
            throw error;
        }

        //this.#tryConnectMorePeersLoop();
        this.#enhanceConnectionLoop();
        this.#peerUpdateOnDirectConnectionUpgrade(); // SHOULD BE REMOVED IF CONNECT/DISCOVERY EVENTS ARE ENOUGH
        this.#bootstrapsConnectionsLoop();
    }
    
    async #tryConnectMorePeersLoop(delay = 10_000) { // DEPRECATED -> usage replaced by enhanceConnectionLoop
        const myPeerIdStr = this.p2pNode.peerId.toString();
        while(true) {
            await new Promise(resolve => setTimeout(resolve, delay));
            
            const allPeers = await this.p2pNode.peerStore.all();
            for (const peer of allPeers) {
                if (Object.keys(this.peers).length >= this.options.maxPeers) break;
                const peerIdStr = peer.id.toString();
                if (peerIdStr === myPeerIdStr) continue;
                if (this.peers[peerIdStr]) continue;

                try {
                    await this.p2pNode.dial(peer.id, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                    this.#updatePeer(peerIdStr, { dialable: false, id: peer.id }, 'initFromStore');
                } catch (error) {}
            }
        }
    }
    /** @param {Multiaddr[]} multiAddrs */
    async #dialSharedPeersFromRelay(multiAddrs) { // DEPRECATED -> usage replaced by pub:connect
        /** @type {string[]} */
        let sharedPeerIdsStr;

        try {
            const stream = await this.p2pNode.dialProtocol(multiAddrs, PROTOCOLS.RELAY_SHARE, { signal: AbortSignal.timeout(this.options.dialTimeout) });
            const readResult = await STREAM.READ(stream);
            sharedPeerIdsStr = serializer.deserialize.rawData(readResult.data);
            // expect array of strings
            if (!sharedPeerIdsStr || typeof sharedPeerIdsStr !== 'object') return;
            if (sharedPeerIdsStr.length === 0 || sharedPeerIdsStr.some(id => typeof id !== 'string')) return;
        } catch (error) { this.miniLogger.log(`Failed to get peersShared: ${error.message}`, (m) => { console.error(m); }); }

        const relayAddrsStr = multiAddrs.map(addr => addr.toString());
        for (const sharedPeerIdStr of sharedPeerIdsStr) {
            if (sharedPeerIdStr === this.p2pNode.peerId.toString()) continue; // not myself
            
            const sharedPeerId = peerIdFromString(sharedPeerIdStr);
            if (this.p2pNode.getConnections(sharedPeerId).length > 0) continue; // already connected
    
            const relayedMultiAddrs = []; // all possibles relayed addresses to reach the shared peer
            for (const addrStr of relayAddrsStr) relayedMultiAddrs.push(multiaddr(`${addrStr}/p2p-circuit/p2p/${sharedPeerIdStr}`));

            try {
                await this.p2pNode.dial(relayedMultiAddrs, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                console.log('DIALED FROM RELAY');
            } catch (error) {
                console.error('FAILED DIAL FROM RELAY', error.message);
            }
        }
    }
    async #enhanceConnectionLoop(delay = 10_000) { // CAN BE SIMPLIFIED
        // this one is based on this.peerManager.store
        while(true) {
            await new Promise(resolve => setTimeout(resolve, delay));
            if (this.myIpAddr) break; // bootstrap nodes don't need enhance connections

            const connectedPeersConType = {}; // peerId.toString()
            const cons = this.p2pNode.getConnections();
            for (const con of cons) {
                const peerIdStr = con.remotePeer.toString();
                const existingConType = connectedPeersConType[peerIdStr];
                if (con.limits && existingConType !== 'direct') connectedPeersConType[peerIdStr] = 'relayed';
                if (!con.limits) connectedPeersConType[peerIdStr] = 'direct';
            }

            const missingPeers = this.options.maxPeers - Object.keys(connectedPeersConType).length;
            if (missingPeers <= 0) continue; // enough peers
            //TODO: remove a bootstrap and try to connect another peer, for now we just avoid more connections

            const resume = { neighboursIds: [], relayedIds: [] };
            for (const peerIdStr in connectedPeersConType) {
                if (connectedPeersConType[peerIdStr] === 'direct') resume.neighboursIds.push(peerIdStr);
                if (connectedPeersConType[peerIdStr] === 'relayed') resume.relayedIds.push(peerIdStr);
            }

            // now we have the resume, we can try to init new connections if needed
            for (let i = 0; i < missingPeers; i++) {
                const nextConnectablePeer = this.peersManager.getNextConnectablePeer();
                if (!nextConnectablePeer) break; // no more connectable peers

                const { peerIdStr, peer } = nextConnectablePeer;
                if (!peerIdStr || !peer) continue;
                if (peerIdStr === this.peersManager.idStr) continue; // not myself
                if (connectedPeersConType[peerIdStr]) continue; // already connected
                
                const multiAddrs = this.peersManager.buildMultiAddrs(peerIdStr, this.p2pNode);
                if (multiAddrs.length === 0) continue; // no address to dial

                const direct = multiAddrs.find(addr => !addr.toString().includes('p2p-circuit'));
                if (!direct && this.options.maxRelayedPeers <= resume.relayedIds.length) continue; // too much relayed peers

                const streamOptions = direct ? STREAM.NEW_DIRECT_STREAM_OPTIONS() : STREAM.NEW_RELAYED_STREAM_OPTIONS();
                try {
                    await this.p2pNode.dialProtocol(multiAddrs, PROTOCOLS.SYNC, streamOptions);
                    this.#updatePeer(peerIdStr, { dialable: true, id: peer.id }, 'initFromStore');
                    connectedPeersConType[peerIdStr] = direct ? 'direct' : 'relayed';
                } catch (error) {
                    console.error('FAILED DIAL FROM STORE', error.message);
                }
            }
        }
    }
    #handleListening = async (event) => {
        const myPeerIdStr = this.peersManager.idStr;
        const relayPeerIdStr = event.detail.relay?.toString();
        if (!relayPeerIdStr) return;
    
        /** @type {string[]} */
        const relayAddrsStr = FILTERS.multiAddrs(event.detail.listeningAddrs, 'PUBLIC', 'CIRCUIT', [27260, 27269]).map(addr => addr.toString());

        // probably only one address... or none if relay disabled
        let addrStr = relayAddrsStr[0] || this.myRelayCircuitAddrs[relayPeerIdStr];
        if (!addrStr || !addrStr.endsWith('p2p-circuit')) return; // should not append

        const now = this.timeSynchronizer?.getCurrentTime() || Date.now();
        if (relayAddrsStr.length === 0) { // relay reservation closed
            delete this.myRelayCircuitAddrs[relayPeerIdStr];
            this.peersManager.digestSelfUpdateRemoveEvent(myPeerIdStr, addrStr, now);
            this.broadcast('self:pub:update:remove', { addrStr, timestamp: now });
        } else {
            this.myRelayCircuitAddrs[relayPeerIdStr] = addrStr;
            this.peersManager.digestSelfUpdateAddEvent(myPeerIdStr, addrStr, now);
            this.broadcast('self:pub:update:add', { addrStr, timestamp: now });
        }
    }
    #handleRelayShare = async ({ stream, connection }) => { // DEPRECATED -> usage replaced by pub:connect
        console.log('RELAY SHARE');
        if (!stream) { return; }
        await stream.closeRead(); // nothing to read

        const sharedPeerIdsStr = [];
        const cons = this.p2pNode.getConnections();
        for (const con of cons) {
			if (sharedPeerIdsStr.includes(con.remotePeer.toString())) continue; // Skip already shared peers
            if (con.remoteAddr.toString().includes('p2p-circuit')) continue; // Skip relayed connections
			sharedPeerIdsStr.push(con.remotePeer.toString());
        }

        this.miniLogger.log(`(relay:share) ${sharedPeerIdsStr.length} peers shared`, (m) => console.debug(m));
        await STREAM.WRITE(stream, serializer.serialize.rawData(sharedPeerIdsStr));
    }
    #handlePeerDiscovery = async (event) => {
        this.miniLogger.log(`(peer:discovery) ${event.detail.id.toString()}`, (m) => console.debug(m));

        //const directAddrs = FILTERS.multiAddrs(event.detail.multiaddrs, 'PUBLIC', 'NO_CIRCUIT');
        //if (directAddrs.length > 0) { await this.#dialSharedPeersFromRelay(directAddrs); return; }
    }
    #handlePeerConnect = async (event) => {
        const peerIdStr = event.detail.toString();
        const cons = this.p2pNode.getConnections(event.detail);
        const authorized = this.peersManager.localEvent(peerIdStr, 'CONNECT');
        if (!authorized) { for (const con of cons) con.close(); return; } // con denied

        const unlimitedCon = this.p2pNode.getConnections(event.detail).find(con => !con.limits);
		this.miniLogger.log(`peer:connect ${peerIdStr} (direct: ${unlimitedCon ? 'yes' : 'no'})`, (m) => console.debug(m));
        this.#updatePeer(peerIdStr, { dialable: unlimitedCon, id: event.detail }, unlimitedCon ? 'direct connection' : 'relayed connection');

        const now = this.timeSynchronizer?.getCurrentTime() || Date.now();
        if (unlimitedCon) this.peersManager.setNeighbours(this.peersManager.idStr, peerIdStr, now);
        else this.peersManager.addRelayedTrough(this.peersManager.idStr, peerIdStr, now);

        // Probably only one address or none
        const addresses = cons.map(con => con.remoteAddr);
        for (const addr of FILTERS.multiAddrs(addresses, 'PUBLIC', undefined, [27260, 27269])) {
            this.peersManager.digestConnectEvent(this.peersManager.idStr, addr.toString(), now);
            this.broadcast('pub:connect', { addrStr: addr.toString(), timestamp: now });
        }

        await this.#updateConnexionResume();
    }
    #handlePeerDisconnect = async (event) => {
        const peerIdStr = event.detail.toString();
        const authorized = this.peersManager.isLocalEventAuthorized(peerIdStr, 'CONNECT');
        if (!authorized) return; // con denied, no need to update or log
        
        this.miniLogger.log(`--------> Peer ${readableId(peerIdStr)} disconnected`, (m) => console.debug(m));

        if (this.peers[peerIdStr]) delete this.peers[peerIdStr];
        if (this.connectedBootstrapNodes[peerIdStr]) delete this.connectedBootstrapNodes[peerIdStr];

        const now = this.timeSynchronizer?.getCurrentTime() || Date.now();
        this.peersManager.digestDisconnectEvent(this.peersManager.idStr, peerIdStr, now);
        this.broadcast('pub:disconnect', { peerIdStr, timestamp: now });
        await this.#updateConnexionResume();
    }

    /** @param {string} peerIdStr @param {Object} data @param {string} [reason] */
    #updatePeer(peerIdStr, data, reason) {
        const updatedPeer = this.peers[peerIdStr] || {};
        updatedPeer.id = data.id || updatedPeer.id;
        updatedPeer.lastSeen = this.timeSynchronizer.getCurrentTime();
        if (data.dialable !== undefined) { updatedPeer.dialable = data.dialable; }
        if (updatedPeer.dialable === undefined) { updatedPeer.dialable = false; }

        this.peers[peerIdStr] = updatedPeer;
        this.miniLogger.log(`--{ Peer } ${readableId(peerIdStr)} updated ${reason ? `for reason: ${reason}` : ''}`, (m) => { console.debug(m); });
    }
    async #updateConnexionResume() {
        const totalPeers = Object.keys(this.peers).length || 0;
        const dialablePeers = Object.values(this.peers).filter(peer => peer.dialable).length;
        // PeerMap {map: Map(0)}
        const peerMap = this.p2pNode.services.circuitRelay?.reservations;
        //const relayed
        const relayedPeers = peerMap ? peerMap.map.size : 0;

        this.connexionResume = {
            totalPeers,
            connectedBootstraps: this.#bootstrapConsInfo().connectedBootstrapsCount,
            totalBootstraps: this.myIpAddr ? this.options.bootstrapNodes.length - 1 : this.options.bootstrapNodes.length,
            relayedPeers
        };

        // new peers logs from peersManager
        const peers = this.peersManager.store;
        //return;

        const allPeers = await this.p2pNode.peerStore.all();
        allPeers.forEach(peer => { peer.id.toString(); }); //TODO REMOVE AFTER DEBUGING
        this.miniLogger.log(`Connected to ${totalPeers} peers | ${dialablePeers} dialables | ${allPeers.length} in peerStore (${this.#bootstrapConsInfo().connectedBootstrapsCount}/${this.connexionResume.totalBootstraps} bootstrap nodes)`, (m) => console.info(m));
    }
    async #peerUpdateOnDirectConnectionUpgrade(delay = 5_000) {
        while(true) {
            await new Promise(resolve => setTimeout(resolve, delay));
            const updatedPeers = [];
            for (const peerIdStr in this.peers) {
                // if at least one direct connection is established, set dialable to true
                if (this.peers[peerIdStr].dialable) continue;

                const unlimitedCon = this.p2pNode.getConnections(this.peers[peerIdStr].id).find(con => !con.limits);
                if (!unlimitedCon) continue;

                this.#updatePeer(peerIdStr, { dialable: true }, 'directConnectionUpgraded');
                updatedPeers.push(peerIdStr);
            }
            if (updatedPeers.length > 0) await this.#updateConnexionResume();
        }
    }

    #isBootstrapNodeAlreadyConnected(addr = '/dns4/..') {
        for (const peerIdStr in this.connectedBootstrapNodes) {
            if (this.connectedBootstrapNodes[peerIdStr] === addr.split('/p2p/').pop()) return true;
        }
    }
    #bootstrapConsInfo() {
        const connectedBootstrapsIpAddrs = Object.values(this.connectedBootstrapNodes).filter(addr => addr !== null)
        return {
            connectedBootstrapsCount: connectedBootstrapsIpAddrs.length,
            totalBootstrapsCount: this.options.bootstrapNodes.length,
            connectedBootstrapsIpAddrs,
            bootstrapConnexionsTargetReached: connectedBootstrapsIpAddrs.length >= this.targetBootstrapNodes,
        }
    }
    async #bootstrapsConnectionsLoop(delay = 10_000) {
        while(true) {
            //TODO: if enough direct peers, stop connecting to bootstraps
            if (!this.#bootstrapConsInfo().bootstrapConnexionsTargetReached) await this.#connectToBootstrapNodes();
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    async #connectToBootstrapNodes() {
        for (const addr of this.options.bootstrapNodes) {
            const ipAddr = addr.split('/p2p/').pop();
            if (this.myIpAddr === ipAddr) continue; // Skip if recognize as myself
            if (this.#isBootstrapNodeAlreadyConnected(addr)) { continue; } // Skip if already connected
            if (this.#bootstrapConsInfo().bootstrapConnexionsTargetReached) { break; } // Stop if reached the target

            try {
                const ma = multiaddr(addr);
                const con = await this.p2pNode.dial(ma, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                this.connectedBootstrapNodes[con.remotePeer.toString()] = ipAddr;
            } catch (err) { // DETECT IF THE BOOTSTRAP NODE IS MYSELF
                if (err.message === 'Can not dial self') {
                    this.myIpAddr = ipAddr;
                    //this.p2pNode.services.circuitRelay.reservations.maxReservations = 4; // Enable relay
                    //await this.p2pNode.services.dht.setMode('server'); // Ensure DHT is enabled as server
                    this.miniLogger.log(']]]]]]]]]]]]]]]]]]]]]|[[[[[[[[[[[[[[[[[[[[[', (m) => console.info(m));
                    this.miniLogger.log(`]]]]]]]]]]]]] I AM BOOTSTRAP! [[[[[[[[[[[[[`, (m) => console.info(m));
                    this.miniLogger.log(']]]]]]]]]]]]]]]]]]]]]|[[[[[[[[[[[[[[[[[[[[[', (m) => console.info(m));
                }
            }
        }

        await this.#updateConnexionResume();
    }

    // PUBSUB
    /** @param {string} topic @param {Function} [callback] */
    subscribe(topic, callback) {
        if (this.subscriptions.has(topic)) return;

        this.miniLogger.log(`Subscribing to topic ${topic}`, (m) => { console.debug(m); });
        this.p2pNode.services.pubsub.subscribe(topic);
        this.subscriptions.add(topic);
        if (callback) { this.on(topic, message => callback(topic, message)); }
    }
    /** Unsubscribes from a topic and removes any associated callback @param {string} topic */
    unsubscribe(topic) {
        if (!this.subscriptions.has(topic)) return;

        this.p2pNode.services.pubsub.unsubscribe(topic);
        this.p2pNode.services.pubsub.topics.delete(topic);
        this.subscriptions.delete(topic);
        this.miniLogger.log(`Unsubscribed from topic ${topic}`, (m) => console.debug(m));
    }
    /** @param {CustomEvent} event */
    #handlePubsubMessage = async (event) => {
        const { topic, data, from, type } = event.detail;
        if (!PUBSUB.VALIDATE(topic, data)) return;
        
        //? type = 'signed' | 'unsigned' | 'raw'
        const content = PUBSUB.DESERIALIZE(topic, data);
        switch (topic) {
            case 'self:pub:update:add':
                this.miniLogger.log(`SELF PUB UPDATE ADD =${from.toString()}=> ${content.addrStr}`, (m) => console.info(m));
                this.peersManager.digestSelfUpdateAddEvent(from.toString(), content.addrStr, content.timestamp);
                return; // no need to emit
            case 'self:pub:update:remove':
                this.miniLogger.log(`SELF PUB UPDATE REMOVE =${from.toString()}=> ${content.addrStr}`, (m) => console.info(m));
                this.peersManager.digestSelfUpdateRemoveEvent(from.toString(), content.addrStr, content.timestamp);
                return; // no need to emit
            case 'pub:connect':
                //this.miniLogger.log(`PUB CONNECT =${from.toString()}=> ${content.addrStr}`, (m) => console.info(m));
                this.peersManager.digestConnectEvent(from.toString(), content.addrStr, content.timestamp);
                return; // no need to emit
            case 'pub:disconnect':
                //this.miniLogger.log(`PUB DISCONNECT =${from.toString()}=> ${content.peerIdStr}`, (m) => console.info(m));
                this.peersManager.digestDisconnectEvent(from.toString(), content.peerIdStr, content.timestamp);
                return; // no need to emit
        }

        try { this.emit(topic, { content, from });
        } catch (error) { this.miniLogger.log(error, (m) => console.error(m)); }
    }
    /** @param {string} topic */
    async broadcast(topic, message) {
        if (Object.keys(this.peers).length === 0) return;

        if (PUBSUB.TOPIC_BROADCAST_DELAY[topic]) // delay the broadcast if needed
            await new Promise(resolve => setTimeout(resolve, PUBSUB.TOPIC_BROADCAST_DELAY[topic]));
        
        try {
            const serialized = PUBSUB.SERIALIZE(topic, message);
            await this.p2pNode.services.pubsub.publish(topic, serialized);
        } catch (error) {
            if (error.message === "PublishError.NoPeersSubscribedToTopic") return error;
            this.miniLogger.log(`Broadcast error on topic **${topic}**: ${error.message}`, (m) => console.error(m));
        }
    }
    /** @param {string} identifier - peerIdStr or ip */
    async disconnectPeer(identifier) {
        if (!this.p2pNode) return;

        for (const connection of this.p2pNode.getConnections()) {
            const peerIdStr = connection.remotePeer.toString();
            if (identifier !== peerIdStr && identifier !== connection.remoteAddr.nodeAddress().address) { continue; }

            this.miniLogger.log(`Disconnecting peer ${readableId(peerIdStr)}`, (m) => { console.info(m); });
            this.p2pNode.components.connectionManager.closeConnections(peerIdStr);
        }
    }
    /** @param {string} peerIdStr @param {string} reason */
    async closeConnection(peerIdStr, reason) {
        this.miniLogger.log(`Closing connection to ${readableId(peerIdStr)}${reason ? ` for reason: ${reason}` : ''}`, (m) => { console.debug(m); });
        this.p2pNode.components.connectionManager.closeConnections(peerIdStr);
    }

    getConnectedPeers() { return Object.keys(this.peers) }
    async stop() {
        if (this.p2pNode) await this.p2pNode.stop();
        this.miniLogger.log(`P2P network ${this.peersManager.idStr} stopped`, (m) => { console.info(m); });
    }
}

function readableId(peerIdStr) { return peerIdStr.replace('12D3KooW', '').slice(0, 12) }

export default P2PNetwork;
export { P2PNetwork, readableId, PROTOCOLS, STREAM, FILTERS, P2P_OPTIONS, PUBSUB };