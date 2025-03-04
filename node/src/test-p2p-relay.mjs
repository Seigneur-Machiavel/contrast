import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { peerIdFromString } from '@libp2p/peer-id';

import { serializer } from '../../utils/serializer.mjs';
import { webSockets } from '@libp2p/websockets';
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
import { P2PNetwork } from './p2p.mjs';

const bootAddr = '/dns4/contrast.observer/tcp/27260';
//const bootAddr = '/dns4/pinkparrot.science/tcp/27260'; // PINKPARROT
//const bootAddr = '/ip4/192.168.4.22/tcp/27260' // PINKPARROT LOCAL
//const bootAddr = '/dns4/pinkparrot.science/tcp/27260/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B'; // PINKPARROT: DaPq...
if (!bootAddr) throw new Error('the bootAddr address needs to be specified as a parameter');

//const targetAddr = '/ip4/192.168.4.26/tcp/45521/p2p/12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7/p2p-circuit/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B'; // WOKRS
//const targetAddr = '/ip4/90.110.28.181/tcp/50913/p2p/12D3KooWJM29sadqienYmVvA7GyMLThkKdDKc63kCJ7zmHdFDsSp/p2p-circuit/webrtc';
const targetAddr = '/ip4/90.110.28.181/tcp/50913/p2p/12D3KooWJM29sadqienYmVvA7GyMLThkKdDKc63kCJ7zmHdFDsSp/p2p-circuit/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B';
//const targetAddr = '12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7';
//const targetAddr = '/ip4/88.182.31.209/tcp/8988/p2p/12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ/p2p-circuit/p2p/12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7'; // ZAYGA
if (!targetAddr) throw new Error('the target address needs to be specified as a parameter');

//process.env.DEBUG = 'libp2p:dcutr*';
const hash = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hash);
const dhtService = kadDHT({ enabled: true, randomWalk: true });
const node = await createLibp2p({
	connectionGater: { denyDialMultiaddr: () => false },
	privateKey: privateKeyObject,
	addresses: { listen: ['/p2p-circuit', '/ip4/0.0.0.0/tcp/0/ws', '/ip4/0.0.0.0/tcp/0'] }, // '/webrtc-direct'
	transports: [tcp()], // circuitRelayTransport({ discoverRelays: 3 }), webRTCDirect(), 
	connectionEncrypters: [noise()],
	streamMuxers: [yamux()],
	services: {
		uPnPNAT: uPnPNAT(),
		identify: identify(),
		dht: dhtService,
		dcutr: dcutr(),
		autoNAT: autoNAT(),
		//circuitRelay: circuitRelayServer({ reservations: { maxReservations: 24, reservationTtl: 60_000 } })
	},
	/*config: {
		peerDiscovery:
			{ autoDial: true, mdns: { enabled: true, interval: 10_000 } },
		relay: {
			enabled: true,
			hop: { enabled: true, active: true },
			autoRelay: { enabled: true, maxListeners: 20 },
		},
	},*/
	peerDiscovery: [mdns(), dhtService]
})
await node.start();
console.log(`Node started with id ${node.peerId.toString()}`)


node.handle(P2PNetwork.SYNC_PROTOCOL, async ({ stream }) => {
	console.log('####--- Received a stream: SYNC_PROTOCOL')
	await new Promise(resolve => setTimeout(resolve, 3000));

	const read = await P2PNetwork.streamRead(stream);
	console.log('Received a message', read)
});
node.handle(P2PNetwork.RELAY_SHARE_PROTOCOL, async ({ stream }) => {
	console.log('####--- Received a stream: RELAY_SHARE_PROTOCOL')
	await new Promise(resolve => setTimeout(resolve, 3000));
});
node.addEventListener('self:peer:update', (evt) => {
	//console.log('\n -- selfPeerUpdate:');
	//for (const addr of node.getMultiaddrs()) console.log(addr.toString());
});

async function askRelayShare(multiAddrs) {
	if (!multiAddrs || multiAddrs.length === 0) return;
	try {
		const stream = await node.dialProtocol(multiAddrs, P2PNetwork.RELAY_SHARE_PROTOCOL, { signal: AbortSignal.timeout(3000) });
		const readResult = await P2PNetwork.streamRead(stream);
		/** @type {string[]} */
		const sharedPeerIdsStr = serializer.deserialize.rawData(readResult.data);
		return sharedPeerIdsStr;
	} catch (error) { console.log(`Failed to get peersShared`) }
}
/** @param {multiaddr[]} relayAddrs @param {string[]} peerIdsStr */
async function tryToDialPeerIdsStr(relayAddrs, peerIdsStr) {
	if (!peerIdsStr || peerIdsStr.length === 0) return;
	let result = { success: 0, failed: 0, peersDialed: [] };
	const allCons = node.getConnections();
	const connectedPeerIdsStr = allCons.map(con => con.remotePeer.toString());
	for (const sharedPeerIdStr of peerIdsStr) {
		if (sharedPeerIdStr === node.peerId.toString()) continue; // not myself
		if (connectedPeerIdsStr.includes(sharedPeerIdStr)) continue;

		// relayAddrs[0] is the one that discovered the peer
		const relaydMultiAddrs = [];
		for (const addr of relayAddrs) {
			const relaydAddr = `${addr.toString()}/p2p-circuit/p2p/${sharedPeerIdStr}`;
			relaydMultiAddrs.push(multiaddr(relaydAddr));
		}
		try {
			const sharedPeerId = peerIdFromString(sharedPeerIdStr);
			await node.dial(relaydMultiAddrs, { signal: AbortSignal.timeout(3_000) });
			await node.peerRouting.findPeer(sharedPeerId, { signal: AbortSignal.timeout(3_000) }); // not necessary
			//await node.dialProtocol(sharedPeerId, P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
			result.success++;
			result.peersDialed.push(sharedPeerIdStr);
		} catch (error) { result.failed++ }
	}

	console.log(`--- Dialed ${result.success} peers, failed ${result.failed} ---`);
	if (result.peersDialed.length) console.log(result.peersDialed);
}
node.addEventListener('peer:discovery', async (event) => {
	console.log(`peer:discovery => ${event.detail.id.toString()}`);

	//await new Promise(resolve => setTimeout(resolve, 10000)); //? useless
	
	const notRelayedAddrs = event.detail.multiaddrs.filter(addr => addr.toString().includes('p2p-circuit') === false);
	const sharedPeerIdsStr = await askRelayShare(notRelayedAddrs);
	//const sharedPeerIdsStr = await askRelayShare(event.detail.multiaddrs);
	await tryToDialPeerIdsStr(notRelayedAddrs, sharedPeerIdsStr);
});
node.addEventListener('peer:disconnect', async (event) => {
	console.log(`peer:disconnect => ${event.detail.toString()}`);
});
node.addEventListener('peer:connect', async (event) => {
	const peerId = event.detail;
	const peerIdStr = peerId.toString();
	const cons = node.getConnections(peerId);
	const multiaddrs = cons.map(con => con.remoteAddr);
	const directCons = cons.filter(con => con.remoteAddr.toString().includes('p2p-circuit') === false);
	console.log(`peer:connect => ${peerIdStr} (total: ${cons.length} connections, direct: ${directCons.length})`);
	return;
	try { // const has = await node.peerStore.has(sharedPeerId);
		const has = await node.peerStore.has(peerId);
		const peerFromStore = has ? await node.peerStore.get(peerId) : null;
		if (peerFromStore) peerFromStore.toString();

		const connectionPeerInfo = await node.peerRouting.findPeer(peerId, { signal: AbortSignal.timeout(3_000) });
		//await node.dialProtocol(peerId, P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
		console.log(`peer:connect => ${peerIdStr} (peerFound)`);
	} catch (error) {
		console.error(`peer:connect => ${peerIdStr} =>`, error.message);
	}
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
				await node.dial(peerId, { signal: AbortSignal.timeout(3000) });
				const updatedCons = node.getConnections(peerId);
				newlyDialed++;
			} catch (error) {}
		}
		if (newlyDialed > 0) console.log(`Dialed ${newlyDialed} more peers using tryConnectMorePeersLoop()`);
	}
}
async function initBootConnectionLight() {
	try {
		const con = await node.dial(multiaddr(bootAddr), { signal: AbortSignal.timeout(3000) });
		const peerId = con.remotePeer;
        const peerIdStr = peerId.toString();
	} catch (error) {
		console.error('Failed to dial the boot node', error.message);
	}
}

tryConnectMorePeersLoop();
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
		const relayedCons = allCons.filter(con => con.remoteAddr.toString().includes('p2p-circuit')).map(con => con.remoteAddr.toString());
		const directCons = allCons.filter(con => con.remoteAddr.toString().includes('p2p-circuit') === false).map(con => con.remoteAddr.toString());

		if (allPeersIdStr.length !== peerStored
		|| allCons.length !== connectionsCount
		|| relayedCons.length !== relayedConsCount
		|| directCons.length !== directConsCount) {
			console.log('New peers state:', allPeersIdStr);

			console.log('All relayed connections:', relayedCons);
			console.log('Direct connections:', directCons);
			peerStored = allPeersIdStr.length;
			connectionsCount = allCons.length;
			relayedConsCount = relayedCons.length;
			directConsCount = directCons.length;
		}
	}
})();