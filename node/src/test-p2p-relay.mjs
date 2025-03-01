import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { peerIdFromString } from '@libp2p/peer-id';

import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { kadDHT } from '@libp2p/kad-dht';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { webRTCDirect, webRTC } from '@libp2p/webrtc';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { dcutr } from '@libp2p/dcutr';
import { P2PNetwork } from './p2p.mjs';

//const relayAddr = '/ip4/192.168.56.1/tcp/27260'
//const relayAddr = '/ip4/62.72.22.165/udp/51617/webrtc-direct/certhash/uEiCg_AihbA_0jtnov1q3upeyeDGB0_lWedpcJ17MJlV5kQ'
const relayAddr = '/dns4/pinkparrot.observer/tcp/27261';
//const relayAddr = '/dns4/pinkparrot.science/tcp/27260';
if (!relayAddr) throw new Error('the relay address needs to be specified as a parameter');

//const webRtcDirectAddr = '/ip4/192.168.4.22/udp/27260/webrtc-direct/certhash/uEiBjpylsi3kVKQ9EfFQDDnfa22cKQZ6YueyQ4tMMAk-jcQ/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B';
//const targetAddr = '/ip4/192.168.4.26/tcp/45521/p2p/12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7/p2p-circuit/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B'; // WOKRS
//const targetAddr = '/ip4/90.110.28.181/tcp/50913/p2p/12D3KooWJM29sadqienYmVvA7GyMLThkKdDKc63kCJ7zmHdFDsSp/p2p-circuit/webrtc';
//const targetAddr = '/ip4/90.110.28.181/tcp/50913/p2p/12D3KooWJM29sadqienYmVvA7GyMLThkKdDKc63kCJ7zmHdFDsSp/p2p-circuit/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B';
//const targetAddr = '12D3KooWRwDMmqPkdxg2yPkuiW1gPCgcdHGJtyaGfxdgAuEpNzD7';
const targetAddr = '/ip4/88.182.31.209/tcp/8988/p2p/12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ/p2p-circuit/p2p/12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7';
if (!targetAddr) throw new Error('the target address needs to be specified as a parameter');

const hash = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hash);
const node = await createLibp2p({
  privateKey: privateKeyObject,
  transports: [webSockets(), webRTC(), circuitRelayTransport(), tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    identify: identify(),
    dht: kadDHT(),
    dcutr: dcutr()
  },
  //connectionGater: { denyDialMultiaddr: () => false },
})

console.log(`Node started with id ${node.peerId.toString()}`)

node.handle('/blockchain-sync/1.0.0', async ({ stream }) => {
  console.log('Received a stream')

  const read = await P2PNetwork.streamRead(stream);
  console.log('Received a message', read)
});
node.addEventListener('self:peer:update', (evt) => {
  for (const addr of node.getMultiaddrs()) console.log('selfPeerUpdate:', addr.toString());
  //console.log(`selfPeerUpdate: ${evt.detail.toString()}`);
});
node.addEventListener('peer:discovery', (event) => {
  const peerId = event.detail.id;
  const discoveryMultiaddrs = event.detail.multiaddrs;
  const multiaddrs = node.getConnections(peerId).map(con => con.remoteAddr);
  console.log('Discovered:', peerId.toString());
});
node.addEventListener('peer:connect', async (event) => {
	const peerId = event.detail;
	const peerIdStr = peerId.toString();

	const con = await node.dial(peerId, { signal: AbortSignal.timeout(3_000) });
	await con.newStream(P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
	console.log(`peer:connect: ${peerIdStr} with ${node.getConnections(peerId).length} connections`);
});

const relayCon = await node.dial(multiaddr(relayAddr));
await relayCon.newStream(P2PNetwork.SYNC_PROTOCOL, { signal: AbortSignal.timeout(3_000) });
console.log(`Connected to the relay ${relayCon.remotePeer.toString()}`);

const conn = await node.dial(multiaddr(targetAddr));
console.log(`Connected to the target 12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ`);

await new Promise(resolve => setTimeout(resolve, 10000));

//const targetPeerIdFromStr = peerIdFromString('12D3KooWPDErmALnzdFsWP72GQ7mf9dvjLsAv9eqQuyuX3UcaggJ');
//const tpInfo = await node.peerRouting.findPeer(targetPeerIdFromStr, { signal: AbortSignal.timeout(10_000) });
//console.log('Found target peer:', tpInfo.id.toString());

// try init more peer connexions trough the relay
async function dialNewPeersThroughRelay() {
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

			//const isWebRtc = maStr.split('/').pop() === 'webrtc';
			//if (isWebRtc) targetsMultiAddrs[targetPeerIdStr].push(addrObj.multiaddr);

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
				
				const targetCon = await node.dial(addrs, { signal: AbortSignal.timeout(3_000) });
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
    while (true) {
		await new Promise(resolve => setTimeout(resolve, 1000));
		await dialNewPeersThroughRelay();
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
      console.log('All peers:', allPeersIdStr);
      peerStored = allPeersIdStr.length;
    }
  }
})();