import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { peerIdFromString } from '@libp2p/peer-id';

import { kadDHT } from '@libp2p/kad-dht';
import { uPnPNAT } from '@libp2p/upnp-nat';
import { mdns } from '@libp2p/mdns';
import { autoNAT } from '@libp2p/autonat';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { webRTCDirect, webRTC } from '@libp2p/webrtc';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { dcutr } from '@libp2p/dcutr';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { tcp } from '@libp2p/tcp';
import { P2PNetwork, STREAM, PROTOCOLS, FILTERS } from '../src/p2p.mjs';

function filterLocalAddrs(ma) {
	let localAddrs = ma.filter(addr => addr.toString().includes('/192') === false);
	localAddrs = localAddrs.filter(addr => addr.toString().includes('/127') === false);
	localAddrs = localAddrs.filter(addr => addr.toString().includes('/10') === false);
	return localAddrs;
}

const hash = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hash);
const dhtService = kadDHT({ enabled: true, randomWalk: true });
const node = await createLibp2p({
	connectionGater: { denyDialMultiaddr: () => false },
	privateKey: privateKeyObject,
	addresses: {
		listen: ['/ip4/0.0.0.0/tcp/0'],
		announceFilter: (addrs) => FILTERS.multiAddrs(addrs, 'PUBLIC'),
		//announceFilter: (addrs) => filterLocalAddrs(addrs),
	},
	transports: [tcp(), circuitRelayTransport()],
	connectionEncrypters: [noise()],
	streamMuxers: [yamux()],
	services: {
		identify: identify(),
		//dht: dhtService,
		dcutr: dcutr(),
		upnp: uPnPNAT(),
		autoNAT: autoNAT(),
		circuitRelay: circuitRelayServer({ reservations: { maxReservations: 4 } }),
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
	peerDiscovery: []
	//peerDiscovery: [mdns(), dhtService]
})
await node.start();

//const target = '/ip4/158.178.213.171/tcp/63564/p2p/12D3KooWSpYvDZpJ6i4BG2pNZcMT5Lmv9E4cd4ubjCDP9G7m994i/p2p-circuit/p2p/12D3KooWEKjHKUrLW8o8EAL9wofj2LvWynFQZzx1kLPYicd4aEBX'; // SPY
//const target = '/dns4/contrast.observer/tcp/27260'; // contrast.observer direct IP
//const target = '/dns4/contrast.observer/tcp/27260'; // contrast.observer DNS
//const target = '/ip4/192.168.4.23/tcp/61121/ws/p2p/12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7';
//const target = '/ip4/141.8.119.6/tcp/46124'
//const target = '/ip4/193.43.70.41/tcp/1603/p2p/12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7' // YOGA

const bootAddrStr = '/dns4/contrast.observer/tcp/27260/p2p/12D3KooWEKjHKUrLW8o8EAL9wofj2LvWynFQZzx1kLPYicd4aEBX'; // VPS
//const bootAddrStr = '/dns4/pinkparrot.observer/tcp/27261/p2p/12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7'; // RASPI

const targetIdStr = '12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7'; // YOGA
//const targetIdStr = '12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ'; // ZAYGA
const targetAddr = multiaddr(`${bootAddrStr}/p2p-circuit/p2p/${targetIdStr}`);

// YOGA TO CON OBSERVER
//const bootAddrStr = '/ip4/141.8.119.6/tcp/61111/p2p/12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7';
//const targetIdStr = '12D3KooWEKjHKUrLW8o8EAL9wofj2LvWynFQZzx1kLPYicd4aEBX';
//const targetAddr = multiaddr(`${bootAddrStr}/p2p-circuit/p2p/${targetIdStr}`);

try {
	// Écouter les événements de connexion pour déboguer
	node.addEventListener('self:peer:update', async (evt) => {
		console.log(`\n -- selfPeerUpdate (${evt.detail.peer.addresses.length}):`);
		const myAddrs = node.getMultiaddrs();
		for (const addr of myAddrs) console.log(addr.toString());
	});
	node.addEventListener('peer:connect', async (evt) => {
		const unlimitedCon = node.getConnections(evt.detail).find(con => !con.limits);
		console.log(`peer:connect ${evt.detail.toString()} (direct: ${unlimitedCon ? 'yes' : 'no'})`);
	});

	// Établir la connexion relayée
	// Ouvrir un stream sur la connexion
	const connection = await node.dial(targetAddr, { signal: AbortSignal.timeout(3_000) });
	const stream = await connection.newStream(PROTOCOLS.RELAY_SHARE, { runOnLimitedConnection: true });
	//const stream = await node.dialProtocol(targetAddr, PROTOCOLS.RELAY_SHARE, {  runOnLimitedConnection: true, signal: AbortSignal.timeout(30_000) });
	console.log('Stream ouvert avec succès!');

	//await stream.closeWrite();
	//const read = await STREAM.READ(stream);
	//console.log('stream L:', read.data.length);
	while (true) {
		await new Promise(resolve => setTimeout(resolve, 1_000));
		const peerCons = node.getConnections(targetIdStr);
		const peerFromStore = await node.peerStore.get(peerIdFromString(targetIdStr));
		const peerIdStr = peerFromStore.id.toString();
		// if one connexio nidrect log
		if (peerCons.length > 1) {
			console.log('Connexion directe:', peerCons[0].remoteAddr.toString());

			//break;
		}
	}
} catch (error) {
	console.error('Erreur:', error);
}
/*
const bootAddrStr = '/dns4/contrast.observer/tcp/27260';
const bootIdStr = '/p2p/12D3KooWEKjHKUrLW8o8EAL9wofj2LvWynFQZzx1kLPYicd4aEBX';
const sep = '/p2p-circuit/p2p/';

try {
	const bootAddr = multiaddr(bootAddrStr + bootIdStr);
	const bootStream = await node.dialProtocol(bootAddr, PROTOCOLS.RELAY_SHARE, { signal: AbortSignal.timeout(30_000) });
	console.log('Dialed boot:', bootAddr.toString()); 
	await new Promise(resolve => setTimeout(resolve, 30_000));
	const mePeer = await node.peerStore.get(node.peerId);
	//console.log(mePeer);
	
	const targetIdStr = '12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7';
	const target = bootAddr.toString() + sep + targetIdStr;
	const targetAddr = multiaddr(target);

	// Vérifie si le peer est déjà connecté
    const existingConn = node.getConnections(targetIdStr)[0];
    if (existingConn) {
        console.log('Déjà connecté via:', existingConn.remoteAddr.toString());
    }
		
	//const tAdddr = bootAddr.encapsulate(targetIdStr); //TODO: learn that
	const stream = await node.dialProtocol(targetAddr, PROTOCOLS.RELAY_SHARE, { signal: AbortSignal.timeout(30_000) });
	await stream.closeWrite();
    console.log('Dialed:', target);
} catch (error) {
    console.error('Failed to dial:', error);
}*/
