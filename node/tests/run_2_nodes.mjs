// THIS FILE IS USED TO START NODE STANDALONE (WITHOUT ELECTRON APP WRAPPER)
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain = args.includes('-local') ? 'localhost' : '0.0.0.0';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const observerPort = args.includes('-op') ? parseInt(nextArg('-op')) : 27270;
const dashboardPort = args.includes('-dp') ? parseInt(nextArg('-dp')) : 27271;
const clearOnStart = false;

import HiveP2P from "hive-p2p";
import { Wallet } from '../src/wallet.mjs';
import { createContrastNode } from '../src/node.mjs';
import { ContrastStorage } from '../../utils/storage.mjs';

// BOOTSTRAP NODE
const bootstrapSeed = '0000000000000000000000000000000000000000000000000000000000000000';
const bootstrapStorage = new ContrastStorage(bootstrapSeed);
if (clearOnStart) bootstrapStorage.clear(); // start fresh
const bootstrapWallet = new Wallet(bootstrapSeed);
await bootstrapWallet.deriveAccounts(2, 'C', bootstrapStorage);

const bootstrapCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, bootstrapSeed);
const bootstrapNode = await createContrastNode({ cryptoCodex: bootstrapCodex, storage: bootstrapStorage, domain, port: nodePort });
await bootstrapNode.start(bootstrapWallet);

// CLIENT NODES
const bootstraps = [bootstrapNode.p2pNode.publicUrl];
const clientSeeds = [
	'0000000000000000000000000000000000000000000000000000000000000003',
]
async function createClientNode(seed) {
	const clientStorage = new ContrastStorage(seed);
	if (clearOnStart) clientStorage.clear(); // start fresh
	const clientWallet = new Wallet(seed);
	await clientWallet.deriveAccounts(2, 'C', clientStorage);

	const clientCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, seed);
	const clientNode = await createContrastNode({ cryptoCodex: clientCodex, storage: clientStorage, bootstraps });
	await clientNode.start(clientWallet);
	return clientNode;
}

const clientNodes = [];
for (const seed of clientSeeds) clientNodes.push(await createClientNode(seed));

// -------------------------------------------------------------------------------------