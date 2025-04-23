import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { peerIdFromString } from '@libp2p/peer-id';

import { serializer } from '../../utils/serializer.mjs';
import { tcp } from '@libp2p/tcp';
import { mdns } from '@libp2p/mdns';
import { uPnPNAT } from '@libp2p/upnp-nat';
import { kadDHT } from '@libp2p/kad-dht';
import { autoNAT } from '@libp2p/autonat';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { webRTCDirect, webRTC } from '@libp2p/webrtc';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { dcutr } from '@libp2p/dcutr';
import { P2PNetwork, PROTOCOLS, STREAM, FILTERS } from '../src/p2p.mjs';

/**
 * @typedef {import('@multiformats/multiaddr').Multiaddr} Multiaddr
 */


console.log('Test-p2p-relay.mjs');
const bootAddrStr = '/dns4/contrast.observer/tcp/27260';
//const bootAddrStr = '/dns4/pinkparrot.observer/tcp/27261'; // RASPI ANONYMOUS (NO DIFFERENCE)
//const bootAddrStr = '/dns4/pinkparrot.observer/tcp/27261/p2p/12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7'; // RASPI
//const bootAddrStr = '/dns4/pinkparrot.science/tcp/27260'; // PINKPARROT
//const bootAddrStr = '/ip4/192.168.4.22/tcp/27260' // PINKPARROT LOCAL
//const bootAddrStr = '/dns4/pinkparrot.science/tcp/27260/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B'; // PINKPARROT: DaPq...
if (!bootAddrStr) throw new Error('the bootAddrStr address needs to be specified as a parameter');

//process.env.DEBUG = 'libp2p:dcutr*';
const hash = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hash);
//const dhtService = kadDHT({ enabled: true, randomWalk: true });
const node = await createLibp2p({
	connectionGater: { denyDialMultiaddr: () => false },
	privateKey: privateKeyObject,
	addresses: {
		listen: ['/ip4/0.0.0.0/tcp/0'], // '/ip4/0.0.0.0/udp/0/webrtc-direct'],
		announceFilter: (addrs) => FILTERS.multiAddrs(addrs, 'PUBLIC'),
		//announceFilter: (addrs) => [], // anonymous
	},
	//transports: [tcp(), circuitRelayTransport({ discoverRelays: 3 })],
	transports: [tcp(), circuitRelayTransport({ discoverRelays: 3, relayFilter: FILTERS.filterRelayAddrs })], // webRTCDirect(), webSockets()
	connectionEncrypters: [noise()],
	streamMuxers: [yamux()],
	services: {
		nat: uPnPNAT({ description: 'contrast-node', ttl: 7200, keepAlive: true }),
		identify: identify(),
		//dht: dhtService,
		dcutr: dcutr(),
		autoNAT: autoNAT(),
		circuitRelay: circuitRelayServer({ reservations: { maxReservations: 24, reservationTtl: 60_000 } })
	},
	config: {
		/*peerDiscovery:
			{ autoDial: true },
		relay: {
			enabled: true,
			hop: { enabled: true, active: true },
			autoRelay: { enabled: true, maxListeners: 20 },
		},*/
	},
	peerDiscovery: []
})
await node.start();

console.log(`Node started with id ${node.peerId.toString()}`)

node.addEventListener('change:multiaddrs', ({ peerId, multiaddrs }) => {
	console.log(`Peer ${peerId.toString()} multiaddrs changed to:`, multiaddrs.map(addr => addr.toString()));
});
node.addEventListener('transport:listening', (evt) => {
	const relayPeerIdStr = evt.detail.relay?.toString();
	if (!relayPeerIdStr) return;

	/** @type {string[]} */
	const relayAddrsStr = evt.detail.listeningAddrs.map(addr => addr.toString());
	const myPeerIdStr = node.peerId.toString();
	for (const relayAddrStr of relayAddrsStr) {
		if (!relayAddrStr.endsWith('p2p-circuit')) continue;
		const relayedAddrStr = `${relayAddrStr}/p2p/${myPeerIdStr}`;
		console.log(`Listening from relay: ${relayedAddrStr}`);
	}
});
node.addEventListener('self:peer:update', async (evt) => {
	console.log(`\n -- selfPeerUpdate (${evt.detail.peer.addresses.length}):`);
	const myAddrs = node.getMultiaddrs();
	for (const addr of myAddrs) {
		console.log(addr.toString());
		const port = addr.nodeAddress().port;
		if (port < 27260 || port > 27269) continue;
		console.log('Valid relay:', addr.toString());
	}
});

node.handle(PROTOCOLS.SYNC, async ({ stream }) => {
	console.log('####--- Received a stream: SYNC_PROTOCOL')
	await new Promise(resolve => setTimeout(resolve, 3000));

	const read = await STREAM.READ(stream);
	console.log('Received a message', read)
});
node.handle(PROTOCOLS.RELAY_SHARE, async ({ stream }) => {
	console.log('####--- Received a stream: RELAY_SHARE_PROTOCOL')
	//await new Promise(resolve => setTimeout(resolve, 3000));
});
async function askRelayShare(multiAddrs) {
	if (!multiAddrs || multiAddrs.length === 0) return;
	try {
		const stream = await node.dialProtocol(multiAddrs, PROTOCOLS.RELAY_SHARE, STREAM.NEW_RELAYED_STREAM_OPTIONS);
		const readResult = await STREAM.READ(stream);
		/** @type {string[]} */
		const sharedPeerIdsStr = serializer.deserialize.rawData(readResult.data);
		return sharedPeerIdsStr;
	} catch (error) { console.log(`Failed to get peersShared`) }
}
/** @param {Multiaddr} relayAddr @param {string[]} peerIdsStr */
async function tryToDialPeerIdsStr(relayAddr, peerIdsStr) {
	if (!peerIdsStr || peerIdsStr.length === 0) return;
	let result = { success: 0, failed: 0, peersDialed: [] };
	const allCons = node.getConnections();
	const connectedPeerIdsStr = allCons.map(con => con.remotePeer.toString());
	for (const sharedPeerIdStr of peerIdsStr) {
		if (sharedPeerIdStr === node.peerId.toString()) continue; // not myself
		if (connectedPeerIdsStr.includes(sharedPeerIdStr)) continue;
		
		const relayAddrStr = relayAddr.toString();
		const relayedAddr = multiaddr(`${relayAddrStr}/p2p-circuit/p2p/${sharedPeerIdStr}`);

		try {
			const stream = await node.dialProtocol(relayedAddr, PROTOCOLS.RELAY_SHARE, STREAM.NEW_RELAYED_STREAM_OPTIONS);
			//const connection = await node.dial(relayedAddr, { signal: AbortSignal.timeout(3_000) });
			//const stream = await connection.newStream(PROTOCOLS.RELAY_SHARE, STREAM.NEW_RELAYED_STREAM_OPTIONS);
			const readResult = await STREAM.READ(stream);
			//const sharedPeerId = peerIdFromString(sharedPeerIdStr);
			//const peer = await node.peerRouting.findPeer(sharedPeerId, { signal: AbortSignal.timeout(3_000) }); // not necessary
			//if (peer.multiaddrs.length > 0) await node.dialProtocol(peer.multiaddrs, PROTOCOLS.SYNC, { signal: AbortSignal.timeout(3_000) });
			result.success++;
			result.peersDialed.push(sharedPeerIdStr);
		} catch (error) {
			console.error(`Failed to dial ${sharedPeerIdStr}:`, error.message);
			result.failed++
		}
	}

	console.log(`--- Dialed ${result.success} peers, failed ${result.failed} ---`);
	if (result.peersDialed.length) console.log(result.peersDialed);
}
node.addEventListener('peer:discovery', async (event) => {
	console.log(`peer:discovery => ${event.detail.id.toString()}`);

	//await new Promise(resolve => setTimeout(resolve, 10000)); //? useless
	
	//const notRelayedAddrs = event.detail.multiaddrs.filter(addr => addr.toString().includes('p2p-circuit') === false);
	//const sharedPeerIdsStr = await askRelayShare(notRelayedAddrs);
	//event.detail.

	//const sharedPeerIdsStr = await askRelayShare(event.detail.multiaddrs);
	//await tryToDialPeerIdsStr(event.detail.multiaddrs, sharedPeerIdsStr);
});
node.addEventListener('peer:connect', async (event) => {
	const peerId = event.detail;
	const peerIdStr = peerId.toString();
	const unlimitedCon = node.getConnections(peerId).find(con => !con.limits);
	//const directCons = allCons.filter(con => con.remoteAddr.toString().includes('p2p-circuit') === false);
	console.log(`peer:connect => ${peerIdStr} (direct: ${unlimitedCon ? 'yes' : 'no'})`);

	if (!unlimitedCon) return;

	const multiAddrs = unlimitedCon.remoteAddr;
	const sharedPeerIdsStr = await askRelayShare(multiAddrs);
	return;
	await tryToDialPeerIdsStr(multiAddrs, sharedPeerIdsStr);
	return;
});
node.addEventListener('peer:disconnect', async (event) => {
	console.log(`peer:disconnect => ${event.detail.toString()}`);
});

async function tryConnectMorePeersLoop() {
	while(true) {
		await new Promise(resolve => setTimeout(resolve, 10000));
		const allPeers = await node.peerStore.all();
		let newlyDialed = 0;
		for (const peerId of allPeers.map(peer => peer.id)) {
			//const peerIdStr = peerId.toString();
			const existingCons = node.getConnections(peerId);
			if (existingCons.length > 0) continue; // already connected

			try {
				//await node.peerRouting.findPeer(peerId, { signal: AbortSignal.timeout(3_000) });
				//await node.dial(peerId, { signal: AbortSignal.timeout(3000) });
				await node.dialProtocol(peerId, PROTOCOLS.RELAY_SHARE, STREAM.NEW_RELAYED_STREAM_OPTIONS);
				const updatedCons = node.getConnections(peerId);
				newlyDialed++;
			} catch (error) {}
		}
		if (newlyDialed > 0) console.log(`Dialed ${newlyDialed} more peers using tryConnectMorePeersLoop()`);
	}
}
async function initBootConnectionLight() {
	try {
		const con = await node.dial(multiaddr(bootAddrStr), { signal: AbortSignal.timeout(3000) });
		const peerId = con.remotePeer;
        const peerIdStr = peerId.toString();
	} catch (error) {
		console.error('Failed to dial the boot node', error.message);
	}
}

//tryConnectMorePeersLoop();
await initBootConnectionLight();

(async () => {
	let peerStored = 0;
	let connectionsCount = 0;
	let relayedConsCount = 0;
	let directConsCount = 0;
	while (true) {
		await new Promise(resolve => setTimeout(resolve, 1000));
		const allPeers = await node.peerStore.all();
		const allPeersIdStr = allPeers.map(peer => peer.id.toString());
		const allCons = node.getConnections();

		const unlimitedCons = allCons.filter(con => !con.limits);

		const relayedCons = allCons.filter(con => con.remoteAddr.toString().includes('p2p-circuit'));
		const relayedConsAddrs = relayedCons.map(con => con.remoteAddr.toString());
		
		const directCons = allCons.filter(con => con.remoteAddr.toString().includes('p2p-circuit') === false);
		const directConsAddrs = directCons.map(con => con.remoteAddr.toString());

		if (allPeersIdStr.length !== peerStored
		|| allCons.length !== connectionsCount
		|| relayedConsAddrs.length !== relayedConsCount
		|| directConsAddrs.length !== directConsCount) {
			console.log('New peers state:', allPeersIdStr);

			console.log('All relayed connections addrs:', relayedConsAddrs);
			console.log('Direct connections:', directConsAddrs);
			console.log('UnlimitedCons:', unlimitedCons.length);
			peerStored = allPeersIdStr.length;
			connectionsCount = allCons.length;
			relayedConsCount = relayedCons.length;
			directConsCount = directCons.length;
		}
	}
})();