import { convert, FastConverter } from '../../utils/converters.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { EventEmitter } from 'events';
import { createLibp2p } from 'libp2p';
import { peerIdFromString } from '@libp2p/peer-id';

import { tcp } from '@libp2p/tcp';
import { webRTCDirect, webRTC } from '@libp2p/webrtc';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';

import { identify } from '@libp2p/identify';
import { uPnPNAT } from '@libp2p/upnp-nat';
import { mdns } from '@libp2p/mdns';
import { kadDHT } from '@libp2p/kad-dht';
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
    fastConverter = new FastConverter();
    subscriptions = new Set();
    miniLogger = new MiniLogger('P2PNetwork');
    timeSynchronizer;
    myAddr; // my ip address (only filled if I am a bootstrap node)
    connectedBootstrapNodes = {};
    connexionResume = { totalPeers: 0, connectedBootstraps: 0, totalBootstraps: 0, relayedPeers: 0 };
    targetBootstrapNodes = 3;
    options = {
        bootstrapNodes: [],
        maxPeers: 12,
        logLevel: 'info',
        logging: true,
        listenAddresses: [], // '/ip4/0.0.0.0/tcp/27260', '/ip4/0.0.0.0/tcp/0'
        dialTimeout: 3000
    };

    /** @type {Libp2p} */
    p2pNode;
    /** @type {Object<string, Peer>} */
    peers = {};
    /** @type {Object<string, boolean>} peerIdStr: active? | state of the relays I know */
    myRelays = {};
    
    /** @param {TimeSynchronizer} timeSynchronizer @param {string[]} [listenAddresses] */
    constructor(timeSynchronizer, listenAddresses = []) {
        super();
        this.timeSynchronizer = timeSynchronizer;
        for (const addr of listenAddresses)
            if (!this.options.listenAddresses.includes(addr)) this.options.listenAddresses.push(addr);
    }

    /** @param {string} uniqueHash - A unique 32 bytes hash to generate the private key from. */
    async start(uniqueHash, isRelayCandidate = true) {
        const hash = uniqueHash ? uniqueHash : mining.generateRandomNonce(32).Hex;
        const hashUint8Array = convert.hex.toUint8Array(hash);
        const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hashUint8Array);
        //const dhtService = kadDHT({ enabled: true, randomWalk: true });
        //const peerDiscovery = [dhtService]; // mdns()
        //if (this.options.bootstrapNodes.length > 0) peerDiscovery.push( bootstrap({ list: this.options.bootstrapNodes }) );
        
        const listen = this.options.listenAddresses;
        if (isRelayCandidate) listen.push('/p2p-circuit') // should already listen the open ports
        else listen.push('/ip4/0.0.0.0/tcp/0');
        const discoverRelays = isRelayCandidate ? 0 : 2;

        try {
            const p2pNode = await createLibp2p({
                privateKey: privateKeyObject,
                streamMuxers: [yamux()],
                connectionEncrypters: [noise()],
                //connectionGater: {denyDialMultiaddr: () => false},
                transports: [tcp(), circuitRelayTransport({ discoverRelays, relayFilter: FILTERS.filterRelayAddrs })], //webRTCDirect(),
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
                    ...(isRelayCandidate && { circuitRelay: circuitRelayServer({ reservations: { maxReservations: 4 } }) }),
                },
                peerDiscovery: []
            });

            p2pNode.addEventListener('self:peer:update', async (evt) => {
                console.log(`\n -- selfPeerUpdate (${evt.detail.peer.addresses.length}):`);
                for (const addr of evt.detail.peer.addresses) console.log(addr.multiaddr.toString());
                return true;
                /*for (const { multiaddr, isCertified } of evt.detail.peer.addresses) {
                    //if (!isCertified) continue; //? to early ?
                    const isCircuitRelay = multiaddr.toString().endsWith('p2p-circuit');
                    console.log(addr.toString());
                    }*/

                /*for (const myAddrStr of p2pNode.getMultiaddrs().map(addr => addr.toString())) {
                    if (!myAddrStr.endsWith('p2p-circuit')) continue;
                    const relayAddrStr = myAddrStr.split('/p2p-circuit/').shift().split('p2p/').pop();
                    this.myRelays[relayAddrStr] = true;
                }*/
                // p2pNode.services.circuitRelay.reservations.maxReservations = 4;
            });
            p2pNode.addEventListener('transport:listening', this.#handleRelayListening);
            p2pNode.addEventListener('peer:connect', this.#handlePeerConnect);
            p2pNode.addEventListener('peer:disconnect', this.#handlePeerDisconnect);
            p2pNode.addEventListener('peer:discovery', this.#handlePeerDiscovery);
            p2pNode.services.pubsub.addEventListener('message', this.#handlePubsubMessage);
            p2pNode.handle(PROTOCOLS.RELAY_SHARE, this.#handleRelayShare, { runOnLimitedConnection: true });

            this.miniLogger.log(`P2P network started. ${isRelayCandidate ? 'RELAY ENABLED' : 'RELAY DISABLED'} |
-- PeerId ${readableId(p2pNode.peerId.toString())}`, (m) => { console.info(m); });
            this.p2pNode = p2pNode;
        } catch (error) {
            this.miniLogger.log('Failed to start P2P network', (m) => { console.error(m); });
            this.miniLogger.log(error.stack, (m) => { console.error(m); });
            throw error;
        }

        //this.#tryConnectMorePeersLoop();
        this.#peerUpdateOnDirectConnectionUpgrade(); // SHOULD BE REMOVED IF CONNECT/DISCOVERY EVENTS ARE ENOUGH
        this.#bootstrapsConnectionsLoop();
    }
    
    async #tryConnectMorePeersLoop(delay = 10_000) {
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
    async #dialSharedPeersFromRelay(multiAddrs) {
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

    #handleRelayListening = async (event) => {
        const relayPeerIdStr = event.detail.relay?.toString();
        if (!relayPeerIdStr) return;

        const relayAddrsStr = FILTERS.multiAddrs(event.detail.listeningAddrs, 'PUBLIC').map(addr => addr.toString());
        if (relayAddrsStr.length === 0) { this.myRelays[relayPeerIdStr] = false; return } // not relayed anymore

        const myPeerIdStr = this.p2pNode.peerId.toString();
        for (const relayAddrStr of relayAddrsStr) { // probably only one addr
            if (!relayAddrStr.endsWith('p2p-circuit')) continue;
            const relayedAddrStr = `${relayAddrStr}/p2p/${myPeerIdStr}`;
            console.log(`Listening from relay: ${relayedAddrStr}`);
            this.myRelays[relayPeerIdStr] = true; // relayed by this peer
        }

        // log
        for (const relayPeerIdStr in this.myRelays) {
            console.log(`Relay ${relayPeerIdStr} is ${this.myRelays[relayPeerIdStr] ? 'active' : 'inactive'}`);
        }
        return true;
    }
    #handleRelayShare = async ({ stream, connection }) => {
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

        console.info('SENDING RELAY SHARE RESPONSE:');
        console.info(sharedPeerIdsStr);
        await STREAM.WRITE(stream, serializer.serialize.rawData(sharedPeerIdsStr));
    }
    #handlePeerDiscovery = async (event) => {
        this.miniLogger.log(`(peer:discovery) ${event.detail.id.toString()}`, (m) => console.debug(m));

        //const directAddrs = FILTERS.multiAddrs(event.detail.multiaddrs, 'PUBLIC', 'NO_CIRCUIT');
        //if (directAddrs.length > 0) { await this.#dialSharedPeersFromRelay(directAddrs); return; }
    }
    #handlePeerConnect = async (event) => {
        const peerIdStr = event.detail.toString();
        const unlimitedCon = this.p2pNode.getConnections(event.detail).find(con => !con.limits);
		this.miniLogger.log(`peer:connect ${peerIdStr} (direct: ${unlimitedCon ? 'yes' : 'no'})`, (m) => console.debug(m));
        this.#updatePeer(peerIdStr, { dialable: unlimitedCon, id: event.detail }, unlimitedCon ? 'direct connection' : 'relayed connection');

        await this.#updateConnexionResume();
    }
    #handlePeerDisconnect = async (event) => {
        const peerIdStr = event.detail.toString();
        this.miniLogger.log(`--------> Peer ${readableId(peerIdStr)} disconnected`, (m) => console.debug(m));
        if (this.peers[peerIdStr]) delete this.peers[peerIdStr];
        if (this.connectedBootstrapNodes[peerIdStr]) delete this.connectedBootstrapNodes[peerIdStr];
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
            totalBootstraps: this.myAddr ? this.options.bootstrapNodes.length - 1 : this.options.bootstrapNodes.length,
            relayedPeers
        };

        const allPeers = await this.p2pNode.peerStore.all();
        allPeers.forEach(peer => { peer.id.toString(); }); //TODO REMOVE AFTER DEBUGING
        this.miniLogger.log(`Connected to ${totalPeers} peers | ${dialablePeers} dialables | ${allPeers.length} in peerStore (${this.#bootstrapConsInfo().connectedBootstrapsCount}/${this.connexionResume.totalBootstraps} bootstrap nodes)`, (m) => { console.info(m); });
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
            if (this.myAddr === ipAddr) continue; // Skip if recognize as myself
            if (this.#isBootstrapNodeAlreadyConnected(addr)) { continue; } // Skip if already connected
            if (this.#bootstrapConsInfo().bootstrapConnexionsTargetReached) { break; } // Stop if reached the target

            try {
                const ma = multiaddr(addr);
                const con = await this.p2pNode.dial(ma, { signal: AbortSignal.timeout(this.options.dialTimeout) });
                this.connectedBootstrapNodes[con.remotePeer.toString()] = ipAddr;
            } catch (err) { // DETECT IF THE BOOTSTRAP NODE IS MYSELF
                if (err.message === 'Can not dial self') {
                    this.myAddr = ipAddr;
                    //this.p2pNode.services.circuitRelay.reservations.maxReservations = 4; // Enable relay
                    //await this.p2pNode.services.dht.setMode('server'); // Ensure DHT is enabled as server
                    this.miniLogger.log(']]]]]]]]]]]]]]]]]]]]][[[[[[[[[[[[[[[[[[[[[', (m) => { console.info(m); });
                    this.miniLogger.log(`]]] I AM BOOTSTRAP! DHT SERVER ENABLED [[[`, (m) => { console.info(m); });
                    this.miniLogger.log(']]]]]]]]]]]]]]]]]]]]][[[[[[[[[[[[[[[[[[[[[', (m) => { console.info(m); });
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
        const { topic, data, from } = event.detail;
        if (!PUBSUB.VALIDATE(topic, data)) return;

        try { this.emit(topic, { content: PUBSUB.DESERIALIZE(topic, data), from, byteLength: data.byteLength });
        } catch (error) { this.miniLogger.log(error, (m) => console.error(m)); }
    }
    /** @param {string} topic */
    async broadcast(topic, message) {
        if (Object.keys(this.peers).length === 0) return;
        
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
        this.miniLogger.log(`P2P network ${this.p2pNode.peerId.toString()} stopped`, (m) => { console.info(m); });
    }
}

function readableId(peerIdStr) { return peerIdStr.replace('12D3KooW', '').slice(0, 12) }

export default P2PNetwork;
export { P2PNetwork, readableId, PROTOCOLS, STREAM, FILTERS, P2P_OPTIONS, PUBSUB };