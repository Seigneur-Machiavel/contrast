// @ts-check
// THIS FILE IS USED TO TEST SYNC PROCESS DURING HORRIBLE NETWORK/VALIDATION CONDITIONS
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain = args.includes('-local') ? 'localhost' : '0.0.0.0';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const observerPort = args.includes('-op') ? parseInt(nextArg('-op')) : 27270;
const dashboardPort = args.includes('-dp') ? parseInt(nextArg('-dp')) : 27271;
const clearOnStart = true;		// RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!
const transactionTest = false; 	// ENABLE TRANSACTION TESTING MODE - FOR TEST PURPOSES ONLY!

import { Wallet } from '../src/wallet.mjs';
import { createContrastNode } from '../src/node.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { Transaction_Builder } from "../src/transaction.mjs";

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { HIVE_P2P_CONFIG } from '../../utils/hive-p2p-config.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

// BOOTSTRAP NODE
const bootstrapSeed = '0000000000000000000000000000000000000000000000000000000000000000';
const bootstrapStorage = new ContrastStorage(bootstrapSeed);
if (clearOnStart) bootstrapStorage.clear(); // start fresh
const bootstrapWallet = new Wallet(bootstrapSeed);
await bootstrapWallet.deriveAccounts(2, 'C', bootstrapStorage);

const bootstrapCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, bootstrapSeed);
// @ts-ignore
const bootstrapNode = await createContrastNode({ cryptoCodex: bootstrapCodex, storage: bootstrapStorage, domain, port: nodePort });
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
	const clientWallet = new Wallet(seed);
	await clientWallet.deriveAccounts(2, 'C', clientStorage);

	const clientCodex = await HiveP2P.CryptoCodex.createCryptoCodex(false, seed);
	const clientNode = await createContrastNode({ cryptoCodex: clientCodex, storage: clientStorage, bootstraps });
	await clientNode.start(clientWallet);
	clientNode.blockchain.simulateFailureRate = 0.1; // for testing purposes
	return clientNode;
}

const clientNodes = [];
for (const seed of clientSeeds) clientNodes.push(await createClientNode(seed));

// -------------------------------------------------------------------------------------
// TESTS
// -------------------------------------------------------------------------------------
/** @param {import("../src/blockchain.mjs").BlockFinalized} block */
const onBlockConfirmed = (block) => {
	if (!transactionTest) return;

	// TEST: create transaction
	const a = bootstrapWallet.accounts[0];
	const receipient = bootstrapWallet.accounts[1].address;
	const ledger = bootstrapNode.blockchain.ledgersStorage.getAddressLedger(a.address);
	if (!ledger.ledgerUtxos) return;
	a.ledgerUtxos = ledger.ledgerUtxos;
	const tx = Transaction_Builder.createAndSignTransaction(a, 10, receipient)?.signedTx;
	if (!tx) return; // failed to create tx

	// TEST: push transaction
	console.log(`Pushing transaction spending: ${tx.inputs.join(', ')}`);
	try { bootstrapNode.memPool.pushTransaction(bootstrapNode,tx); }
	catch (/** @type {any} */ error) { console.error('Failed to push transaction to mempool:', error.message); }
}
bootstrapNode.on('onBlockConfirmed', onBlockConfirmed);