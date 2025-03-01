import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { peerIdFromString } from '@libp2p/peer-id';

import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { kadDHT } from '@libp2p/kad-dht';
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'
import { webRTCDirect, webRTC } from '@libp2p/webrtc';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { P2PNetwork } from './p2p.mjs';

//const relayAddr = '/ip4/192.168.56.1/tcp/27260'
//const relayAddr = '/ip4/62.72.22.165/udp/51617/webrtc-direct/certhash/uEiCg_AihbA_0jtnov1q3upeyeDGB0_lWedpcJ17MJlV5kQ'
const relayAddr = '/ip4/192.168.4.22/tcp/27260';
//const relayAddr = '/dns4/pinkparrot.science/tcp/27260';
if (!relayAddr) throw new Error('the relay address needs to be specified as a parameter');

//const webRtcDirectAddr = '/ip4/192.168.4.22/udp/27260/webrtc-direct/certhash/uEiBjpylsi3kVKQ9EfFQDDnfa22cKQZ6YueyQ4tMMAk-jcQ/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B';
const targetAddr = '/ip4/192.168.4.26/tcp/45521/p2p/12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7/p2p-circuit/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B';
if (!targetAddr) throw new Error('the target address needs to be specified as a parameter');

const hash = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hash);
const node = await createLibp2p({
    privateKey: privateKeyObject,
    transports: [ webSockets(), webRTC(), circuitRelayTransport(), tcp() ],
    connectionEncrypters: [ noise() ],
    streamMuxers: [ yamux() ],
    services: { identify: identify(), dht: kadDHT() },
    //connectionGater: { denyDialMultiaddr: () => false },
})

console.log(`Node started with id ${node.peerId.toString()}`)

node.handle('/blockchain-sync/1.0.0', async ({ stream }) => {
    console.log('Received a stream')

    const read = await P2PNetwork.streamRead(stream);
    console.log('Received a message', read)
});
/*node.addEventListener('self:peer:update', (evt) => {
  // Updated self multiaddrs?
  console.log(`Advertising with a relay address of ${node.getMultiaddrs()[0].toString()}`)
});*/

const relayCon = await node.dial(multiaddr(relayAddr));
console.log(`Connected to the relay ${relayCon.remotePeer.toString()}`)

const allPeers = await node.peerStore.all();
const allPeersIdStr = allPeers.map(peer => peer.id.toString());
console.log('All peers:', allPeersIdStr);

/*while(true) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
        //const peerId = peerIdFromString('12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7');
        //const peer = await node.peerStore.get(peerId);

        const peerInfo = await node.peerRouting.findPeer('12D3KooWP8KNmdnJKmXJ64bJVMvauSdrUVbmixe3zJzapp6oWZG7');
        if (!peerInfo) continue;
        console.info(peerInfo);
        break;
    } catch (error) {
        console.error(error.message);
    }
}*/

const conn = await node.dial(multiaddr(targetAddr));
console.log(`Connected to the target ${conn.remoteAddr.toString()}`)