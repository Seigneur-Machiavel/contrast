// @ts-check
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

// IN THIS FILE WE CAN TEST SPAMMING IMPACT WITH TWO TYPES OF WORST CASE TRANSACTIONS FOR VALIDATION:
// 1) LOT OF SINGLE OUTPUT TRANSACTIONS (HIGH VALIDATION COST FOR THE NUMBER OF TXS IN BLOCK)
// 2) ONE MULTI OUTPUT TRANSACTION WITH LOT OF OUTPUTS (HIGH VALIDATION COST FOR ONE SINGLE TX IN BLOCK)

function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain = args.includes('--local') ? 'localhost' : '0.0.0.0';
const nodePort = args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const clearOnStart = true; // RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!

import { Wallet } from '../../node/src/wallet.mjs';
import { createContrastNode } from '../../node/src/node.mjs';
import { Transfer } from "../../types/transaction.mjs";
import { serializer } from '../../utils/serializer.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { Transaction_Builder } from '../../node/src/transaction.mjs';

// IMPORT HIVE_P2P & PATCH CONFIG
import HiveP2P from "hive-p2p";
import { HIVE_P2P_CONFIG } from '../../config/hive-p2p-config.mjs';
HiveP2P.mergeConfig(HiveP2P.CONFIG, HIVE_P2P_CONFIG);

// TEST CONFIG
const nor = args.includes('-nor') ? parseInt(nextArg('-nor')) : null;
const nos = args.includes('-nos') ? parseInt(nextArg('-nos')) : null;
const nbReceipients = nor || 4600;	// Number of receipient addresses in multi output transaction
const nbOfSenders = nos || 800; 	// Number of single output transactions to send (should be higher than nbReceipients)
// NOTE:
// NEEDS NEW MEASURE! - 2500 outputs Tx: ~30KB => max around ~4800 outputs in one tx: 57726 bytes (64KB limit)

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
/** @param {import("../../node/src/blockchain.mjs").BlockFinalized} block */
const onBlockConfirmed = async (block) => {
	const { identityStore } = bootstrapNode.blockchain;
	
	// TEST: SEND TRANSACTION WITH MULTI OUTPUTS
	if (block.index % 2 === 1) { // ONLY ON ODD BLOCKS
		const account = bootstrapWallet.accounts[0];
		const ledger = await bootstrapNode.blockchain.ledgersStorage.getAddressLedger(account.address);
		if (!ledger || !ledger.ledgerUtxos) throw new Error('Ledger or ledgerUtxos not found for the account');
		if (ledger.totalReceived - ledger.totalSent !== ledger.balance) throw new Error('Inconsistent balance calculation!');

		account.setBalanceAndUTXOs(ledger.balance, ledger.ledgerUtxos);

		/** @type {Uint8Array | undefined} */
		let data;
		const transfers = [];
		for (let i = 2; i < 2 + nbReceipients; i++) {
			const a = bootstrapWallet.accounts[i].address;
			const pk = bootstrapWallet.accounts[i].pubKey;
			const d = identityStore.buildIdentityEntry(a, [pk]);
			
			// VERIFY IDENTITY CORRESPONDANCE => IF NOT IDENTIFY => CREATE IDENTITY
			const r = identityStore.resolveIdentity(a, [pk]);
			if (r === 'MISMATCH') throw new Error('Validator reward address known but pubkey(s) mismatch in identity store');
			
			try { // create TX to check size, if too big it will throw, then we stop adding outputs
				const mergedData = r === 'UNKNOWN' ? Transaction_Builder.mergeIdentityData(d, data) : data;
				transfers.push(new Transfer(bootstrapWallet.accounts[i].address, 1_000));
				Transaction_Builder.createTransaction(account, transfers, 1, mergedData); // test if transaction can be created with current data size, if not stop adding outputs
				data = mergedData; // only update data if merge was successful (didn't exceed max size)
			} catch (/** @type {any} */ error) {
				transfers.pop(); // remove last transfer that caused failure
				break; // stop adding outputs if failed (most likely because of size limit)
			}
		}

		const { tx } = Transaction_Builder.createTransaction(account, transfers, 1, data);
		const signedTx = account.signTransaction(tx);
		if (!signedTx) return; // failed to create tx
	
		try {
			const s = serializer.serialize.transaction(signedTx);
			bootstrapNode.memPool.pushTransaction(bootstrapNode, s);
			console.log(`Sent 1 multi output transaction with ${tx.outputs.length} outputs.`);
		} catch (/** @type {any} */ error) { console.error('Failed to push transaction to mempool:', error.stack); }
		
		return; // only one multi output tx every 2 blocks
	}

	// TEST: SEND LOT OF SINGLE OUTPUT TRANSACTIONS (ONLY ON EVEN BLOCKS)
	let txs = [];
	for (let i = 2; i < nbOfSenders; i++) {
		const sender = bootstrapWallet.accounts[i];
		const ledger = await bootstrapNode.blockchain.ledgersStorage.getAddressLedger(sender.address);
		if (ledger && ledger.ledgerUtxos) sender.ledgerUtxos = ledger.ledgerUtxos;
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
		} catch (/** @type {any} */ error) { console.error('Failed to push transaction to mempool:', error.stack); }
	}

	if (nbSent > 0) console.log(`Sent ${nbSent}/${nbOfSenders} single output transactions.`);
}
bootstrapNode.on('onBlockConfirmed', onBlockConfirmed);