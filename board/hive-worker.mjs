//<script src="/hive-p2p.min.js" type="module"></script>
console.log('HiveP2P worker script loaded');

if (typeof RTCPeerConnection === 'undefined') console.log('RTCPeerConnection === undefined');
else console.log('RTCPeerConnection is available');

/** @type {typeof import('hive-p2p')} */
const HiveP2P = await import('./hive-p2p.min.js');
import { HIVE_P2P_CONFIG } from '../../utils/hive-p2p-config.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

const bootstraps = ['ws://127.0.0.1:27260'];
await HiveP2P.createNode({ bootstraps });
await new Promise(resolve => setTimeout(resolve, 1000));

self.postMessage({ type: 'worker-ready' });
self.onmessage = (e) => console.log('Message received in worker:', e.data);