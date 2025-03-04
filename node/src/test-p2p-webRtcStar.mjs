//import { createLibp2pNode } from 'libp2p'
import { createLibp2p } from 'libp2p';
import { webRTCStar } from '@libp2p/webrtc-star'
import wrtc from 'wrtc'

const star = webRTCStar({ wrtc })
const node = await createLibp2p({
    addresses: {
      listen: [
        '/ip4/188.166.203.82/tcp/20000/wss/p2p-webrtc-star'
      ]
    },
    transports: [
      star.transport
    ],
    peerDiscovery: [
      star.discovery
    ]
  })
  await node.start()

  await node.dial('/ip4/188.166.203.82/tcp/20000/wss/p2p-webrtc-star/p2p/QmcgpsyWgH8Y8ajJz1Cu72KnS5uo2Aa2LpzU7kinSooo2a')