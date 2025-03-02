import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { peerIdFromString } from '@libp2p/peer-id';

import { serializer } from '../../utils/serializer.mjs';
import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { mdns } from '@libp2p/mdns';
import { kadDHT } from '@libp2p/kad-dht';
import { autoNAT } from '@libp2p/autonat';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { webRTCDirect, webRTC } from '@libp2p/webrtc';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { dcutr } from '@libp2p/dcutr';
import { P2PNetwork } from './p2p.mjs';

//const bootAddr = '/dns4/contrast.observer/tcp/27260';
//const bootAddr = '/dns4/pinkparrot.science/tcp/27260'; // PINKPARROT
const bootAddr = '/ip4/192.168.4.22/tcp/27260' // PINKPARROT LOCAL
//const bootAddr = '/dns4/pinkparrot.science/tcp/27260/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B'; // PINKPARROT: DaPq...
if (!bootAddr) throw new Error('the bootAddr address needs to be specified as a parameter');

//const targetAddr = '/ip4/192.168.4.26/tcp/45521/p2p/12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7/p2p-circuit/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B'; // WOKRS
//const targetAddr = '/ip4/90.110.28.181/tcp/50913/p2p/12D3KooWJM29sadqienYmVvA7GyMLThkKdDKc63kCJ7zmHdFDsSp/p2p-circuit/webrtc';
const targetAddr = '/ip4/90.110.28.181/tcp/50913/p2p/12D3KooWJM29sadqienYmVvA7GyMLThkKdDKc63kCJ7zmHdFDsSp/p2p-circuit/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B';
//const targetAddr = '12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7';
//const targetAddr = '/ip4/88.182.31.209/tcp/8988/p2p/12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ/p2p-circuit/p2p/12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7'; // ZAYGA
if (!targetAddr) throw new Error('the target address needs to be specified as a parameter');

//process.env.DEBUG = 'libp2p:dcutr*';
process.env.DEBUG = 'libp2p:*,libp2p:identify*,libp2p:dcutr*';
const DIAL_THROUGH_RELAY = true;
const hash = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hash);
const dhtService = kadDHT({ enabled: true, randomWalk: true });
const node = await createLibp2p({
	connectionGater: { denyDialMultiaddr: () => false },
	privateKey: privateKeyObject,
	addresses: { listen: ['/p2p-circuit', '/ip4/0.0.0.0/tcp/0'] },
	transports: [circuitRelayTransport(), tcp()],
	connectionEncrypters: [noise()],
	streamMuxers: [yamux()],
	services: {
		identify: identify(),
		dht: dhtService,
		dcutr: dcutr(),
		autoNAT: autoNAT(),
		circuitRelay: circuitRelayServer({ reservations: { maxReservations: 6, reservationTtl: 60_000 } })
	},
	peerDiscovery: [mdns(), dhtService]
})
await node.start();
console.log(`Node started with id ${node.peerId.toString()}`)


node.handle(P2PNetwork.SYNC_PROTOCOL, async ({ stream }) => {
	await new Promise(resolve => setTimeout(resolve, 3000));
	console.log('Received a stream: SYNC_PROTOCOL')

	const read = await P2PNetwork.streamRead(stream);
	console.log('Received a message', read)
});
node.handle(P2PNetwork.RELAY_SHARE_PROTOCOL, async ({ stream }) => {
	await new Promise(resolve => setTimeout(resolve, 3000));
	console.log('Received a stream: RELAY_SHARE_PROTOCOL')
});
node.addEventListener('self:peer:update', (evt) => {
	//console.log('\n -- selfPeerUpdate:');
	//for (const addr of node.getMultiaddrs()) console.log(addr.toString());
});
node.addEventListener('peer:discovery', async (event) => {
	const peerId = event.detail.id;
	const multiaddrs = node.getConnections(peerId).map(con => con.remoteAddr);
	
	let routingPeer;
	try {
		routingPeer = await node.peerRouting.findPeer(peerId, { signal: AbortSignal.timeout(3_000) });
		console.log(`peer:discovery => ${peerId.toString()}`);
	} catch (error) {
		console.error(`peer:discovery => ${peerId.toString()} failed to find the peer`, error.message);
	}

	const discoveryMultiaddrs = event.detail.multiaddrs;
	if (discoveryMultiaddrs.length === 0) return;

	try {
		await node.dialProtocol(discoveryMultiaddrs, P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
		console.log(`peer:discovery => ${peerId.toString()} successfully dialed SYNC_PROTOCOL`);
	} catch (error) {
		console.error(`peer:discovery => ${peerId.toString()} failed to dial SYNC_PROTOCOL`, error.message);
	}
});
node.addEventListener('peer:connect', async (event) => {
	const peerId = event.detail;
	const peerIdStr = peerId.toString();
	//const multiaddrs = node.getConnections(peerId).map(con => con.remoteAddr);

	//await node.dialProtocol(peerId, P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
	console.log(`peer:connect => ${peerIdStr} (total: ${node.getConnections(peerId).length} connections)`);
});

const initCon = await node.dial(multiaddr(bootAddr));
await initCon.newStream(P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
//console.log(`Connected init -> ${initCon.remoteAddr.toString()}`);
//await node.dialProtocol(multiaddr(bootAddr), '/ipfs/id/1.0.0', { signal: AbortSignal.timeout(3_000) });
//await node.dialProtocol(multiaddr(bootAddr), '/libp2p/dcutr', { signal: AbortSignal.timeout(3_000) });
const stream = await initCon.newStream(P2PNetwork.RELAY_SHARE_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
initCon.streams.forEach(stream => console.log(`Active protocol: ${stream.protocol}`));

const readResult = await P2PNetwork.streamRead(stream);
/** @type {string[]} */
const sharedPeerIdsStr = serializer.deserialize.rawData(readResult.data);
console.log('Received a message', readResult);
//const bootCons = node.getConnections('12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B');
//let cons = node.getConnections();
//await new Promise(resolve => setTimeout(resolve, 10000));
// small test
//const allPeers = await node.peerStore.all();
//const relayAddr = '/dns4/pinkparrot.observer/tcp/27261' + '/p2p/' + initCon.remotePeer.toString();
//const relayCon = await node.dial(multiaddr(relayAddr));
//await relayCon.newStream(P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
//console.log(`Connected to the relay ${relayCon.remoteAddr.toString()}`);
//const allPeersUp = await node.peerStore.all();

//await node.dialProtocol(multiaddr(targetAddr), P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
//console.log(`Connected to the target 12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ`);

//await new Promise(resolve => setTimeout(resolve, 10000));
//cons = node.getConnections(peerIdFromString('12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ'));


//const targetPeerIdFromStr = peerIdFromString('12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ');
//const tpInfo = await node.peerRouting.findPeer(targetPeerIdFromStr, { signal: AbortSignal.timeout(10_000) });
//console.log('Found target peer:', tpInfo.id.toString());

// try init more peer connexions trough the relay
async function dialNewPeersThroughRelay() {
	const relayAddr = initCon.remoteAddr.toString();
	const myPeerIdStr = node.peerId.toString();
	for (const peerIdStr of sharedPeerIdsStr) {
		if (peerIdStr === myPeerIdStr) continue;

		// Can use this.peers in real case to check if the peer is already connected
		const peerId = peerIdFromString(peerIdStr); //TODO
		const existingCons = node.getConnections(peerId); //TODO
		if (existingCons.length > 0) continue; //TODO
		// if (enough peers) break //TODO

		// relay/p2p-circuit/p2p/target
		const relayedAddr = relayAddr + '/p2p-circuit/p2p/' + peerIdStr;
		const multiAddr = multiaddr(relayedAddr);

		try {
			await node.dial(multiAddr, { signal: AbortSignal.timeout(3_000) });
			console.log(`Dialed ${peerIdStr} trough the relay ${relayAddr}`);
			//await new Promise(resolve => setTimeout(resolve, 10000));
		} catch (error) {
			console.error(`Failed to dial ${peerIdStr} trough the relay ${relayAddr}`, error.message);
			continue;
		}
		
		try {
			const relayedPeer = await node.peerRouting.findPeer(peerId, { signal: AbortSignal.timeout(3_000) });
			console.log('Found peer:', relayedPeer.id.toString());
		} catch (error) {
			console.error(`Failed to find peer ${peerIdStr} trough the relay ${relayAddr}`, error.message);
		}
	}

	const allPeers = await node.peerStore.all();
	console.log('All peers:', allPeers.map(peer => peer.id.toString()));

	const allCons = node.getConnections();
	console.log('All relayed connections:', allCons.filter(con => con.remoteAddr.toString().includes('p2p-circuit')).map(con => con.remoteAddr.toString()));
	console.log('Direct connections:', allCons.filter(con => con.remoteAddr.toString().includes('p2p-circuit') === false).map(con => con.remoteAddr.toString()));
	return;
}

async function dialNewPeersThroughRelayOLD() { // DEPRECATED
	const allPeers = await node.peerStore.all();
	for (const peer of allPeers) {
		const relayPeerIdStr = peer.id.toString();

		const targetsMultiAddrs = {};
		for (const addrObj of peer.addresses) {
			if (!addrObj.isCertified) continue;
			const maStr = addrObj.multiaddr.toString();
			if (!maStr.split('p2p/')[1]) continue;
			const targetPeerIdStr = maStr.split('p2p/')[1].split('/')[0];
			if (relayPeerIdStr === targetPeerIdStr) continue;
			if (!targetsMultiAddrs[targetPeerIdStr]) targetsMultiAddrs[targetPeerIdStr] = [];

			if (maStr.split('/').pop() !== 'p2p-circuit') continue;

			const targetAddrTroughRelay = maStr + '/p2p/' + relayPeerIdStr;
			targetsMultiAddrs[targetPeerIdStr].push(multiaddr(targetAddrTroughRelay));
		}

		for (const targetPeerIdStr in targetsMultiAddrs) {
			try {
				const addrs = targetsMultiAddrs[targetPeerIdStr]; // [multiaddr(targetAddrTroughRelay)];
				if (!addrs) continue;

				const targetPeerId = peerIdFromString(targetPeerIdStr);
				const targetExistingCons = node.getConnections(targetPeerId);
				if (targetExistingCons.length > 0) continue;

				const targetCon = await node.dial(addrs, { signal: AbortSignal.timeout(30_000) });
				await targetCon.newStream(P2PNetwork.SYNC_PROTOCOL);
				console.log(`Connected to the target: ${targetPeerIdStr}
trough: ${targetCon.remoteAddr.toString()}`);

				const peerInfo = await node.peerRouting.findPeer(targetPeerId, { signal: AbortSignal.timeout(10_000) });
				console.log('Found peer:', peerInfo.id.toString());
				//knownPeersIdStr = (await node.peerStore.all()).map(peer => peer.id.toString());
			} catch (error) { console.error(error.message); }
		}
	}
}
(async () => {
	while (DIAL_THROUGH_RELAY) {
		await new Promise(resolve => setTimeout(resolve, 5000));
		await dialNewPeersThroughRelay();
		await new Promise(resolve => setTimeout(resolve, 30000));
	}
})();

// THIS IS THE WORKING PROCEDURE
//const peerId = peerIdFromString('12D3KooWJM29sadqienYmVvA7GyMLThkKdDKc63kCJ7zmHdFDsSp'); // ALEX
//const peerId = peerIdFromString('12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7'); // YOGA
//const peerId = peerIdFromString('12D3KooWJRAvHUPuQZ5GDPZgLJ9bFZ7jYWrR5R2hYudjA65eMqx1'); // JRAv ?
//const peerId = peerIdFromString('12D3KooWEAKsyqsmPqSd4k3jniBkuciJYhBvNs9BqA1449CxP3hN'); // EAKs ?
//const peerId = peerIdFromString('12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ'); // ZAYGA ?
//const peerInfo = await node.peerRouting.findPeer(peerId, { signal: AbortSignal.timeout(10_000) });
//console.log('Found peer:', peerInfo.id.toString());

//const con = await node.dial(peerId, { signal: AbortSignal.timeout(10_000) });
//console.log(`Connected to the target ${con.remoteAddr.toString()}`);
// ----------------------------

/*while (true) {
	const connections = node.getConnections();
  
	if (connections.find(conn => conn.limits == null)) {
	  console.info('have direct connection')
	  break
	} else {
	  console.info('have relayed connection')
  
	  // wait a few seconds to see if it's succeeded yet
	}
	await new Promise(resolve => setTimeout(resolve, 5000))
  }*/

(async () => {
	let peerStored = 0;
	while (true) {
		await new Promise(resolve => setTimeout(resolve, 1000));
		const allPeers = await node.peerStore.all();
		const allPeersIdStr = allPeers.map(peer => peer.id.toString());
		if (allPeersIdStr.length > peerStored) {
			console.log('New peers state:', allPeersIdStr);
			peerStored = allPeersIdStr.length;
		}
	}
})();