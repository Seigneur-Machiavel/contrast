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
import { Transaction_Builder } from "../src/transaction.mjs";

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
const bootstraps = [bootstrapNode.p2p.publicUrl];
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
// TESTS
// -------------------------------------------------------------------------------------
let lastHeight = -1;
while(true) {
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	if (bootstrapNode.blockchain.currentHeight < 2) continue;
	if (lastHeight === bootstrapNode.blockchain.currentHeight) continue;
	lastHeight = bootstrapNode.blockchain.currentHeight;

	// TEST: getBlock time
	const getBlockStart = performance.now();
	const block = bootstrapNode.blockchain.getBlock(0);
	const getBlockTime = performance.now() - getBlockStart;
	console.log(`Genesis block (served in ${getBlockTime.toFixed(5)} ms):`, block);

	// TEST: get utxos time
	//const anchors = ['0:0:0', '0:1:0', '1:0:0', '1:1:0', '2:0:0', '2:1:0', '3:0:0', '3:1:0', '4:0:0', '4:1:0'];
	const anchors = [];
	for (let i = 0; i < bootstrapNode.blockchain.currentHeight + 1; i++) anchors.push(`${i}:1:0`);
	const getUtxosStart = performance.now();
	const utxos = bootstrapNode.blockchain.getUtxos(anchors, false);
	const getUtxosTime = performance.now() - getUtxosStart;
	console.log(`${anchors.length} Utxos served in ${getUtxosTime.toFixed(5)} ms`);

	// TEST: create transaction
	if (!utxos) continue; // wait for utxos

	const a = bootstrapWallet.accounts.C[0];
	const receipient = bootstrapWallet.accounts.C[1].address;
	a.UTXOs = [];
	for (const anchor in utxos)
		if (!utxos[anchor].spent) a.UTXOs.push(utxos[anchor]);
	const tx = Transaction_Builder.createAndSignTransfer(a, 10, receipient)?.signedTx;
	if (!tx) continue; // failed to create tx

	// TEST: push transaction
	console.log(`Pushing transaction spending: ${tx.inputs.join(', ')}`);
	try { await bootstrapNode.memPool.pushTransaction(tx); }
	catch (error) { console.error('Failed to push transaction to mempool:', error.message); }
}