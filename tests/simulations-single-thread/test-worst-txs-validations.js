// @ts-check
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

// IN THIS FILE WE CAN TEST SPAMMING IMPACT WITH TWO TYPES OF WORST CASE TRANSACTIONS FOR VALIDATION:
// 1) LOT OF SINGLE OUTPUT TRANSACTIONS (HIGH VALIDATION COST FOR THE NUMBER OF TXS IN BLOCK)
// 2) ONE MULTI OUTPUT TRANSACTION WITH LOT OF OUTPUTS (HIGH VALIDATION COST FOR ONE SINGLE TX IN BLOCK)

import { Wallet } from '../../node/src/wallet.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { createContrastNode } from '../../node/src/node.mjs';
import { TestTransactionCreator } from '../test-transactions-creator.js';

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { HIVE_P2P_CONFIG } from '../../config/hive-p2p-config.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

// CONFIG
function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain = 'localhost'; // args.includes('--local') ? 'localhost' : '0.0.0.0';
const nodePort = 27260; 	// args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const clearOnStart = false; // RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!
const mayoVariant = args.includes('--mayo2') ? 'mayo2' : 'mayo1'; // MAYO VARIANT TO USE FOR TESTING (AFFECTS SIGNATURE SIZE, AND THEREFORE MAX NUMBER OF OUTPUTS IN MULTI OUTPUT TRANSACTION)
const nor = args.includes('-nor') ? parseInt(nextArg('-nor')) : null;
const nos = args.includes('-nos') ? parseInt(nextArg('-nos')) : null;
const nbReceipients = nor || 2000;	// Number of recipient addresses in multi output transaction (The max tested is 7140 outputs)
const nbOfSenders = nos || 660; 	// Number of single output transactions to send (should be lower than nbReceipients)
if (nbOfSenders > nbReceipients) throw new Error('nbOfSenders should be lower than nbReceipients!!');
// NOTE:
// NEEDS NEW MEASURE! - 2500 outputs Tx: ~30KB => max around ~4800 outputs in one tx: 57726 bytes (64KB limit)

// BOOTSTRAP NODE
const seed = '0000000000000000000000000000000000000000000000000000000000000011';
const storage = new ContrastStorage(seed);
if (clearOnStart) storage.clear(); // start fresh

const nodeWallet = await Wallet.initializedWallet(storage, undefined, seed, mayoVariant);
const bootstraps = ['ws://localhost:27260']; // bootstrap node URL(s) to connect to
const cryptoCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, seed);
const node = await createContrastNode({ cryptoCodex, bootstraps, storage, domain, port: nodePort });
if (node.controller) node.controller.enableUnsafeServePubKey(); // ENABLE UNSAFE MODE FOR TESTING
await node.start(nodeWallet);

// -------------------------------------------------------------------------------------
// TESTS
// ------------------------------------------------------------------------------------

const testTxsCreator = await TestTransactionCreator.newInstance(node, mayoVariant, nbOfSenders, nbReceipients);
testTxsCreator.updateAccountBalanceAndLedger(undefined, true); // update solver account

/** @param {import("../../node/src/blockchain.mjs").BlockFinalized} block */
const onBlockConfirmed = async (block) => {
	if (!testTxsCreator.mainAccountsReady()) return; // nodeWallet not ready yet!
	
	testTxsCreator.clearPreparedTxs();
	testTxsCreator.updateAccountBalanceAndLedger(undefined, true); // update solver account

	// TEST: CREATE MISSING IDENTITIES
	await testTxsCreator.createMissingIdentitiesTransactions(true);
	
	// TEST: CREATE TRANSACTIONS WITH MULTI OUTPUTS (ONLY ON ODD BLOCKS)
	if (testTxsCreator.txs.length === 0 && block.index % 2 === 1)
		await testTxsCreator.createMultiOutputsTransactions(true);

	// TEST: CREATE SINGLE OUTPUT TRANSACTIONS (ONLY ON EVEN BLOCKS)
	if (testTxsCreator.txs.length === 0 && block.index % 2 === 0)
		await testTxsCreator.createSingleOutputTransactions();

	// TEST: SEND ALL TXS
	await testTxsCreator.sendAllPreparedTxs(true);
}
node.on('onBlockConfirmed', onBlockConfirmed);