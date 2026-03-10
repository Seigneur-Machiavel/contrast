// @ts-check
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain = args.includes('-local') ? 'localhost' : '0.0.0.0';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const clearOnStart = true; // RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!

import { Wallet } from '../src/wallet.mjs';
import { createContrastNode } from '../src/node.mjs';
import { Transfer } from "../../types/transaction.mjs";
import { serializer } from '../../utils/serializer.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { Transaction_Builder } from "../src/transaction.mjs";

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { HIVE_P2P_CONFIG } from '../../utils/hive-p2p-config.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

// TEST CONFIG
const nor = args.includes('-nor') ? parseInt(nextArg('-nor')) : null;
const nos = args.includes('-nos') ? parseInt(nextArg('-nos')) : null;
const nbReceipients = nor || 4800;	// Number of receipient addresses in multi output transaction
const nbOfSenders = nos || 800; 	// Number of single output transactions to send (should be higher than nbReceipients)
// NOTE:
// - 2500 outputs Tx: ~30KB => max around ~4800 outputs in one tx: 57726 bytes (64KB limit)

// BOOTSTRAP NODE
const bootstrapSeed = '0000000000000000000000000000000000000000000000000000000000000000';
const bootstrapStorage = new ContrastStorage(bootstrapSeed);
if (clearOnStart) bootstrapStorage.clear(); // start fresh
const bootstrapWallet = new Wallet(bootstrapSeed);
await bootstrapWallet.deriveAccounts(2 + nbReceipients, 'C', bootstrapStorage);

const bootstrapCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, bootstrapSeed);
// @ts-ignore
const bootstrapNode = await createContrastNode({ cryptoCodex: bootstrapCodex, storage: bootstrapStorage, domain, port: nodePort });
if (bootstrapNode.controller) bootstrapNode.controller.enableUnsafeMode(); // ENABLE UNSAFE MODE FOR TESTING
await bootstrapNode.start(bootstrapWallet);

// -------------------------------------------------------------------------------------
// TESTS
// -------------------------------------------------------------------------------------
/** @param {import("../src/blockchain.mjs").BlockFinalized} block */
const onBlockConfirmed = (block) => {
	// TEST: SEND TRANSACTION WITH MULTI OUTPUTS
	if (block.index % 2 === 1) { // ONLY ON ODD BLOCKS
		const transfers = [];
		for (let i = 2; i < 2 + nbReceipients; i++)
			transfers.push(new Transfer(bootstrapWallet.accounts[i].address, 1_000));

		const a = bootstrapWallet.accounts[0];
		const ledger = bootstrapNode.blockchain.ledgersStorage.getAddressLedger(a.address);
		if (!ledger || !ledger.ledgerUtxos) throw new Error('Ledger or ledgerUtxos not found for the account');
		if (ledger.totalReceived - ledger.totalSent !== ledger.balance) throw new Error('Inconsistent balance calculation!');

		a.setBalanceAndUTXOs(a.balance, ledger.ledgerUtxos);
		const { tx } = Transaction_Builder.createTransaction(a, transfers, 1);
		const signedTx = a.signTransaction(tx);
		if (!signedTx) return; // failed to create tx
	
		//console.log(`Pushing transaction spending: ${signedTx.inputs.join(', ')}`);
		try {
			const s = serializer.serialize.transaction(signedTx);
			bootstrapNode.memPool.pushTransaction(bootstrapNode, s);
		} catch (/** @type {any} */ error) { console.error('Failed to push transaction to mempool:', error.message); }
	}

	// TEST: SEND LOT OF SINGLE OUTPUT TRANSACTIONS
	if (block.index % 2 === 0) { // ONLY ON EVEN BLOCKS
		let txs = [];
		for (let i = 2; i < nbOfSenders; i++) {
			const sender = bootstrapWallet.accounts[i];
			const senderLedgerUtxos = bootstrapNode.blockchain.ledgersStorage.getAddressLedger(sender.address).ledgerUtxos;
			if (senderLedgerUtxos) sender.ledgerUtxos = senderLedgerUtxos;
			const receipient = bootstrapWallet.accounts[0].address; // send back to main account
			const signedTx2 = Transaction_Builder.createAndSignTransaction(sender, 100, receipient, 1)?.signedTx;
			if (signedTx2) txs.push(signedTx2);
		}

		let nbSent = 0;
		for (const tx of txs) { // FLOOD!
			try {
				const s = serializer.serialize.transaction(tx);
				bootstrapNode.memPool.pushTransaction(bootstrapNode, s);
				nbSent++;
			} catch (/** @type {any} */ error) { console.error('Failed to push transaction to mempool:', error.message); }
		}

		console.log(`Sent ${nbSent}/${nbOfSenders} single output transactions.`);
	}
}
bootstrapNode.on('onBlockConfirmed', onBlockConfirmed);