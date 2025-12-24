// @ts-check
// THIS FILE IS USED TO START NODE STANDALONE (WITHOUT ELECTRON APP WRAPPER)
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain = args.includes('-local') ? 'localhost' : '0.0.0.0';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const observerPort = args.includes('-op') ? parseInt(nextArg('-op')) : 27270;
const dashboardPort = args.includes('-dp') ? parseInt(nextArg('-dp')) : 27271;
const clearOnStart = false; // RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!

import HiveP2P from "hive-p2p";
import { Wallet } from '../src/wallet.mjs';
import { createContrastNode } from '../src/node.mjs';
import { Transfer } from "../../types/transaction.mjs";
import { serializer } from "../../utils/serializer.mjs";
import { ContrastStorage } from '../../storage/storage.mjs';
import { Transaction_Builder } from "../src/transaction.mjs";

// TEST CONFIG
const nbReceipients = 5000;	// Number of receipient addresses in multi output transaction
const nbOfSenders = 1000; 	// Number of single output transactions to send (should be higher than nbReceipients)

// BOOTSTRAP NODE
const bootstrapSeed = '0000000000000000000000000000000000000000000000000000000000000000';
const bootstrapStorage = new ContrastStorage(bootstrapSeed);
if (clearOnStart) bootstrapStorage.clear(); // start fresh
const bootstrapWallet = new Wallet(bootstrapSeed);
await bootstrapWallet.deriveAccounts(2 + nbReceipients, 'C', bootstrapStorage);

const bootstrapCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, bootstrapSeed);
// @ts-ignore
const bootstrapNode = await createContrastNode({ cryptoCodex: bootstrapCodex, storage: bootstrapStorage, domain, port: nodePort });
await bootstrapNode.start(bootstrapWallet);

// -------------------------------------------------------------------------------------
// TESTS
// -------------------------------------------------------------------------------------
let lastHeight = -1;
while(true) {
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	if (bootstrapNode.blockchain.currentHeight < 1) continue;
	if (lastHeight === bootstrapNode.blockchain.currentHeight) continue;
	lastHeight = bootstrapNode.blockchain.currentHeight;

	// TEST: GET BLOCK
	const getBlockStart = performance.now();
	const block = bootstrapNode.blockchain.getBlock();
	if (!block) continue;

	const getBlockTime = performance.now() - getBlockStart;
	console.log(`Block #${block.index} (served in ${getBlockTime.toFixed(5)} ms):`, block);

	// TEST: SEND TRANSACTION WITH MULTI OUTPUTS
	const transfers = [];
	for (let i = 2; i < 2 + nbReceipients; i++) {
		const receipient = bootstrapWallet.accounts[i].address;
		transfers.push(new Transfer(receipient, 1_000));
	}
	
	const a = bootstrapWallet.accounts[0];
	const ledger = bootstrapNode.blockchain.ledgersStorage.getAddressLedger(a.address);
	if (ledger.totalReceived - ledger.totalSent !== ledger.balance) throw new Error('Inconsistent balance calculation!');
	a.ledgerUtxos = ledger?.ledgerUtxos || [];

	// CONTROL UTXOs Anchor duplication
	const seen = new Set();
	for (const utxo of a.ledgerUtxos) {
		if (seen.has(utxo.anchor)) console.warn('Duplicate UTXO anchor detected in account UTXOs:', utxo.anchor);
		else seen.add(utxo.anchor);
	}
	//const u = bootstrapNode.blockchain.getUtxos(['713:1:0']);

	const tx = Transaction_Builder.createTransaction(a, transfers, 1);
	const signedTx = a.signTransaction(tx);
	if (!signedTx) continue; // failed to create tx

	console.log(`Pushing transaction spending: ${signedTx.inputs.join(', ')}`);
	try { bootstrapNode.memPool.pushTransaction(bootstrapNode, signedTx); }
	catch (/** @type {any} */ error) { console.error('Failed to push transaction to mempool:', error.message); }

	// TEST: SEND LOT OF SINGLE OUTPUT TRANSACTIONS
	let txs = [];
	for (let i = 2; i < nbOfSenders; i++) {
		await new Promise((resolve) => setTimeout(resolve, 10)); // avoid freeze
		
		const sender = bootstrapWallet.accounts[i];
		const senderLedgerUtxos = bootstrapNode.blockchain.ledgersStorage.getAddressLedger(sender.address).ledgerUtxos;
		if (senderLedgerUtxos) sender.ledgerUtxos = senderLedgerUtxos;
		const receipient = bootstrapWallet.accounts[0].address; // send back to main account
		const signedTx2 = Transaction_Builder.createAndSignTransaction(sender, 100, receipient, 1)?.signedTx;
		if (signedTx2) txs.push(signedTx2);
	}

	let nbSent = 0;
	for (const tx of txs) { // FLOOD!
		try { bootstrapNode.memPool.pushTransaction(bootstrapNode, tx); nbSent++; }
		catch (/** @type {any} */ error) { console.error('Failed to push transaction to mempool:', error.message); }
	}

	console.log(`Sent ${nbSent} single output transactions from ${nbOfSenders} accounts.`);
}