import { mining } from '../../utils/mining-functions.mjs';
import { convert } from '../../utils/converters.mjs';
import { createLibp2p } from 'libp2p';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';

import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';

import { kadDHT } from '@libp2p/kad-dht';
import { webRTCDirect } from '@libp2p/webrtc';


const hash = mining.generateRandomNonce(32).Hex;
const hashUint8Array = convert.hex.toUint8Array(hash);
const privateKeyObject = await generateKeyPairFromSeed("Ed25519", hashUint8Array);
//const star = webRTCStar({ wrtc });
let p2pNode;
try {
    p2pNode = await createLibp2p({
        privateKey: privateKeyObject,
        //streamMuxers: [yamux()],
        //connectionEncrypters: [noise()],
        transports: [ webRTCDirect() ],
        addresses: { listen: [ '/ip4/0.0.0.0/udp/0/webrtc-direct' ] },
        connectionGater: { denyDialMultiaddr: () => false },
        //services: { pubsub: gossipsub(), identify: identify() }
    });

    await p2pNode.start();
    console.log('P2P Node started:');
    console.log(`ListenAddresses:`);
    for (const addr of p2pNode.getMultiaddrs()) console.log(addr.toString());
} catch (error) {
    console.error('Failed to create libp2p node:', error);
    throw error;
}

// TEST DIAL
setTimeout(async () => {
    const testHash = mining.generateRandomNonce(32).Hex;
    const testHashUint8Array = convert.hex.toUint8Array(testHash);
    const testPrivateKeyObject = await generateKeyPairFromSeed("Ed25519", testHashUint8Array);
    for (let i = 0; i < 10; i++) {
        try {
            const ma = p2pNode.getMultiaddrs()[i];
            if (!ma) { throw new Error('None of the multiaddrs are available'); }
            console.log('----  -- - Dialing', ma.toString())

            const dialer = await createLibp2p({
                privateKey: testPrivateKeyObject,
                //streamMuxers: [yamux()],
                //connectionEncrypters: [noise()],
                transports: [ webRTCDirect() ],
                //services: { pubsub: gossipsub(), identify: identify() },
                //connectionGater: { denyDialMultiaddr: () => false }
            })

            await dialer.start()
            
            //const stream = await dialer.dialProtocol(ma, [P2PNetwork.SYNC_PROTOCOL])
            const con = await dialer.dial(ma, { signal: AbortSignal.timeout(10_000) })
            const stream = await con.newStream(P2PNetwork.SYNC_PROTOCOL);
            console.log('Dialer connected to listener')
            console.log('Dialer stream', stream)
        } catch (error) {
            if (error.message === 'None of the multiaddrs are available') { console.error(error.message); break; }
            console.error(error)
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}, 5000);