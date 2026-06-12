// @ts-check
// THIS FILE IS USED TO TEST SYNC PROCESS DURING HORRIBLE NETWORK/VALIDATION CONDITIONS
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain = args.includes('--local') ? 'localhost' : '0.0.0.0';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const clearOnStart = true;		// RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!

import { Wallet } from '../../node/src/wallet.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { createContrastNode } from '../../node/src/node.mjs';

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { HIVE_P2P_CONFIG } from '../../config/hive-p2p-config.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

// BOOTSTRAP NODE
const bootstrapSeed = '0000000000000000000000000000000000000000000000000000000000000000';
const bootstrapStorage = new ContrastStorage(bootstrapSeed);
if (clearOnStart) bootstrapStorage.clear(); // start fresh

const bootstrapWallet = await Wallet.initializedWallet(bootstrapStorage, undefined, bootstrapSeed);
const bootstrapCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, bootstrapSeed);
const bootstrapNode = await createContrastNode({
	cryptoCodex: bootstrapCodex,
	storage: bootstrapStorage,
	bootstraps: [],
	port: nodePort,
	domain,
});
await bootstrapNode.start(bootstrapWallet);
bootstrapNode.blockchain.simulateFailureRate = 0.1; // for testing purposes

// CLIENT NODES
const bootstraps = bootstrapNode.p2p.publicUrl ? [bootstrapNode.p2p.publicUrl] : [];
const clientSeeds = [
	'0000000000000000000000000000000000000000000000000000000000000003',
	'0000000000000000000000000000000000000000000000000000000000000004',
	'0000000000000000000000000000000000000000000000000000000000000005',
	'0000000000000000000000000000000000000000000000000000000000000006',
]
async function createClientNode(seed = 'toto') {
	const clientStorage = new ContrastStorage(seed);
	if (clearOnStart) clientStorage.clear(); // start fresh

	const clientWallet = await Wallet.initializedWallet(clientStorage, undefined, seed);
	const clientCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, seed);
	const clientNode = await createContrastNode({
		cryptoCodex: clientCodex,
		storage: clientStorage,
		controllerPort: false,
		bootstraps
	});
	await clientNode.start(clientWallet);
	clientNode.blockchain.simulateFailureRate = 0.1; // for testing purposes
	return clientNode;
}

const clientNodes = [];
for (const seed of clientSeeds) clientNodes.push(await createClientNode(seed));