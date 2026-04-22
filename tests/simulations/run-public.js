// @ts-check
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const workerData 	= JSON.parse(process.env.NODE_WORKER_DATA || '{}');
const seed      	= workerData.seed;
const domain		= workerData.domain;
const nodePort		= workerData.nodePort;
const clearOnStart 	= workerData.clearOnStart;	// RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { Wallet } from '../../node/src/wallet.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { createContrastNode } from '../../node/src/node.mjs';
import { HIVE_P2P_CONFIG } from '../../config/hive-p2p-config.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);
//HiveP2P.CONFIG.SIMULATION.USE_TEST_TRANSPORTS = true;

// BOOTSTRAP NODE
const bootstrapStorage = new ContrastStorage(seed);
if (clearOnStart) bootstrapStorage.clear(); // start fresh
const bootstrapWallet = new Wallet(seed);
await bootstrapWallet.deriveAccounts(2, 'C', undefined, undefined, bootstrapStorage);

const bootstrapCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, seed); // @ts-ignore
const bootstrapNode = await createContrastNode({
	controllerPort: false,
	cryptoCodex: bootstrapCodex,
	storage: bootstrapStorage,
	domain, port: nodePort
});
await bootstrapNode.start(bootstrapWallet);

console.log('Bootstrap node public URL:', bootstrapNode.p2p.publicUrl);