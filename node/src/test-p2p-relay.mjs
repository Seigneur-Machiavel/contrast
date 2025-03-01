import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
//import { webSockets } from '@libp2p/websockets'
import { tcp } from '@libp2p/tcp';
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'
import { webRTCDirect } from '@libp2p/webrtc';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { P2PNetwork } from './p2p.mjs';

//const relayAddr = '/ip4/192.168.56.1/tcp/27260'
const relayAddr = '/ip4/62.72.22.165/udp/51617/webrtc-direct/certhash/uEiCg_AihbA_0jtnov1q3upeyeDGB0_lWedpcJ17MJlV5kQ'
if (!relayAddr) throw new Error('the relay address needs to be specified as a parameter');

//const webRtcDirectAddr = '/ip4/192.168.4.22/udp/27260/webrtc-direct/certhash/uEiBjpylsi3kVKQ9EfFQDDnfa22cKQZ6YueyQ4tMMAk-jcQ/p2p/12D3KooWDaPq8QDCnLmA1xCNFMKPpQtbwkTEid2jSsi5EoYneZ9B';
const targetAddr = '/ip4/127.0.0.1/udp/41651/webrtc-direct/certhash/uEiBbW-5kxow3sxnM8ToQ1uGsIovXEfRymrAm6xn7pJnyYg/p2p/12D3KooWEKjHKUrLW8o8EAL9wofj2LvWynFQZzx1kLPYicd4aEBX';
const multiAddr = multiaddr(targetAddr);

const hash = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hash);
const node = await createLibp2p({
    privateKey: privateKeyObject,
    transports: [ webRTCDirect() ],
    connectionEncrypters: [ noise() ],
    streamMuxers: [ yamux() ],
    services: { identify: identify() },
    //connectionGater: { denyDialMultiaddr: () => false },
})

console.log(`Node started with id ${node.peerId.toString()}`)

node.handle('/blockchain-sync/1.0.0', async ({ stream }) => {
    console.log('Received a stream')

    const read = await P2PNetwork.streamRead(stream);
    console.log('Received a message', read)
});
const conn = await node.dial(multiAddr);

console.log(`Connected to the relay ${conn.remotePeer.toString()}`)

// Wait for connection and relay to be bind for the example purpose
node.addEventListener('self:peer:update', (evt) => {
  // Updated self multiaddrs?
  console.log(`Advertising with a relay address of ${node.getMultiaddrs()[0].toString()}`)
})