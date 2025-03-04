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
import { P2PNetwork } from './p2p.mjs';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';

const hash = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hash);
const dhtService = kadDHT({ enabled: true, randomWalk: true });
const node = await createLibp2p({
	connectionGater: { denyDialMultiaddr: () => false },
	privateKey: privateKeyObject,
	addresses: {
		listen: ['/p2p-circuit', '/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws'],
		//announce: ['/ip4/194.146.15.44/tcp/0'],
		appendAnnounce: ['/ip4/194.146.15.44/tcp/0']
	}, // '/webrtc-direct'
	transports: [circuitRelayTransport({ discoverRelays: 3 }), tcp(), webSockets(), webRTCDirect()],
	//transports: [tcp()],
	connectionEncrypters: [noise()],
	streamMuxers: [yamux()],
	services: {
		identify: identify(),
		dht: dhtService,
		dcutr: dcutr(),
		upnp: uPnPNAT(),
		autoNAT: autoNAT(),
		circuitRelay: circuitRelayServer({ reservations: { maxReservations: 24, reservationTtl: 60_000 } })
	},
	//peerDiscovery: [mdns(), dhtService]
})
await node.start();

//const target = '/ip4/158.178.213.171/tcp/63564/p2p/12D3KooWSpYvDZpJ6i4BG2pNZcMT5Lmv9E4cd4ubjCDP9G7m994i/p2p-circuit/p2p/12D3KooWEKjHKUrLW8o8EAL9wofj2LvWynFQZzx1kLPYicd4aEBX'; // SPY
//const target = '/dns4/contrast.observer/tcp/27260'; // contrast.observer direct IP
//const target = '/dns4/contrast.observer/tcp/27260'; // contrast.observer DNS
//const target = '/ip4/192.168.4.23/tcp/61121/ws/p2p/12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7';
//const target = '/ip4/141.8.119.6/tcp/46124'

const bootAddr = '/dns4/contrast.observer/tcp/27260';
const bootIdStr = '/p2p/12D3KooWEKjHKUrLW8o8EAL9wofj2LvWynFQZzx1kLPYicd4aEBX';
const sep = '/p2p-circuit/p2p/';
//const target = '/ip4/193.43.70.41/tcp/1603/p2p/12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7' // YOGA
const targetIdStr = '12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7';

try {
	await node.dial(multiaddr(bootAddr + bootIdStr), { signal: AbortSignal.timeout(3000) });
	console.log('Dialing to:', bootAddr + bootIdStr);

	const myAddrs = node.getMultiaddrs();
	for (const addr of myAddrs) {
		console.log('My address:', addr.toString());
	}

	const mePeer = await node.peerStore.get(node.peerId);
	console.log(mePeer);

	//const target = bootAddr + bootIdStr + sep + targetIdStr
    //const con = await node.dial(multiaddr(target), { signal: AbortSignal.timeout(3000) })
	//con.newStream(P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3000) });
    //await node.dialProtocol(multiAddr, P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3000) });
    //console.log('Dialed:', target);
} catch (error) {
    console.error('Failed to dial:', error);
}
