// @ts-check
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

// IN THIS FILE WE CAN TEST SPAMMING IMPACT WITH TWO TYPES OF WORST CASE TRANSACTIONS FOR VALIDATION:
// 1) LOT OF SINGLE OUTPUT TRANSACTIONS (HIGH VALIDATION COST FOR THE NUMBER OF TXS IN BLOCK)
// 2) ONE MULTI OUTPUT TRANSACTION WITH LOT OF OUTPUTS (HIGH VALIDATION COST FOR ONE SINGLE TX IN BLOCK)

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

// CONFIG
function nextArg(arg = '') { return args[args.indexOf(arg) + 1]; }
const args = process.argv.slice(2); // digest the start args
const domain = 'localhost'; // args.includes('--local') ? 'localhost' : '0.0.0.0';
const nodePort = 27260; 	// args.includes('-np') ? parseInt(nextArg('-np')) : 27260;
const clearOnStart = false; // RESET STORAGE ON STARTUP - FOR TEST PURPOSES ONLY!
const mayoVariant = args.includes('--mayo2') ? 'mayo2' : 'mayo1'; // MAYO VARIANT TO USE FOR TESTING (AFFECTS SIGNATURE SIZE, AND THEREFORE MAX NUMBER OF OUTPUTS IN MULTI OUTPUT TRANSACTION)
const nor = args.includes('-nor') ? parseInt(nextArg('-nor')) : null;
const nos = args.includes('-nos') ? parseInt(nextArg('-nos')) : null;
const nbReceipients = nor || 2000;	// Number of receipient addresses in multi output transaction (The max tested is 7140 outputs)
const nbOfSenders = nos || 660; 	// Number of single output transactions to send (should be higher than nbReceipients)
// NOTE:
// NEEDS NEW MEASURE! - 2500 outputs Tx: ~30KB => max around ~4800 outputs in one tx: 57726 bytes (64KB limit)

// BOOTSTRAP NODE
const seed = '0000000000000000000000000000000000000000000000000000000000000011';
const storage = new ContrastStorage(seed);
if (clearOnStart) storage.clear(); // start fresh

const wallet = new Wallet(seed);
await wallet.deriveAccounts(2 + nbReceipients, 'C', mayoVariant, '1', storage); // derive all accounts we will need for the test (main account + senders + receipients)

const bootstraps = ['ws://localhost:27260']; // bootstrap node URL(s) to connect to
const cryptoCodex = await HiveP2P.CryptoCodex.createCryptoCodex(true, seed);
// @ts-ignore
const node = await createContrastNode({ cryptoCodex, bootstraps, storage, domain, port: nodePort });
if (node.controller) node.controller.enableUnsafeServePubKey(); // ENABLE UNSAFE MODE FOR TESTING
await node.start(wallet);

// -------------------------------------------------------------------------------------
// TESTS
// -------------------------------------------------------------------------------------
/** @param {import("../../node/src/blockchain.mjs").BlockFinalized} block */
const onBlockConfirmed = async (block) => {
	const { identityStore } = node.blockchain;
	
	// TEST: SEND TRANSACTION WITH MULTI OUTPUTS
	if (block.index % 2 === 1) { // ONLY ON ODD BLOCKS
		const account = wallet.accounts[1]; // Solver account as sender
		const ledger = await node.blockchain.ledgersStorage.getAddressLedger(account.address);
		if (!ledger || !ledger.ledgerUtxos) throw new Error('Ledger or ledgerUtxos not found for the account');
		if (ledger.totalReceived - ledger.totalSent !== ledger.balance) throw new Error('Inconsistent balance calculation!');

		account.setBalanceAndUTXOs(ledger.balance, ledger.ledgerUtxos);

		const identityEntries = [];
		const transfers = [];
		for (let i = 2; i < 2 + nbReceipients; i++) {
			const a = wallet.accounts[i].address;
			const pk = wallet.accounts[i].pubKey;
			if (!pk) throw new Error('Pubkey not found for receipient account');
			
			// VERIFY IDENTITY CORRESPONDANCE => IF NOT IDENTIFY => CREATE IDENTITY
			const identityCountBefore = identityEntries.length;
			const r = identityStore.resolveIdentity(a, [pk]);
			if (r === 'MISMATCH') throw new Error('Validator reward address known but pubkey(s) mismatch in identity store');
			if (r === 'UNKNOWN') identityEntries.push(identityStore.buildEntry(a, [pk])); // if identity is unknown, we need to create it and attach it to the coinbase transaction for it to be valid (if not, the block will be rejected because of unknown identity)

			try { // create TX to check size, if too big it will throw, then we stop adding outputs
				transfers.push(new Transfer(wallet.accounts[i].address, 1_000));
				//Transaction_Builder.
				Transaction_Builder.createTransaction(account, transfers, 1, identityEntries); // test if transaction can be created with current data size, if not stop adding outputs
			} catch (/** @type {any} */ error) {
				transfers.pop(); // remove last transfer that caused failure
				if (identityCountBefore < identityEntries.length) identityEntries.pop(); // if we added an identity entry for this receipient, we need to remove it as well
				break; // stop adding outputs if failed (most likely because of size limit)
			}
		}

		const { tx } = Transaction_Builder.createTransaction(account, transfers, 1, identityEntries);
		const signedTx = await account.signTransaction(tx);
		if (!signedTx) return; // failed to create tx
	
		try {
			const s = serializer.serialize.transaction(signedTx);
			node.p2p.broadcast(s, { topic: 'transaction' });
			await node.memPool.pushTransaction(node, s);
			console.log(`Sent 1 multi output transaction with ${tx.outputs.length} outputs. (${identityEntries.length} identity entries)`);
		} catch (/** @type {any} */ error) { console.error('Failed to push transaction to mempool:', error.stack); }
		
		return; // only one multi output tx every 2 blocks
	}

	// TEST: SEND LOT OF SINGLE OUTPUT TRANSACTIONS (ONLY ON EVEN BLOCKS)
	let txs = [];
	for (let i = 2; i < nbOfSenders + 2; i++) {
		const sender = wallet.accounts[i];
		const ledger = await node.blockchain.ledgersStorage.getAddressLedger(sender.address);
		if (ledger && ledger.ledgerUtxos) sender.ledgerUtxos = ledger.ledgerUtxos;
		const receipient = wallet.accounts[1].address; // send back to main account
		const signedTx2 = (await Transaction_Builder.createAndSignTransaction(sender, 'max', receipient, 1))?.signedTx;
		if (signedTx2) txs.push(signedTx2);
	}

	if (txs.length === 0) return; // no tx to send
	else console.log(`Prepared ${txs.length} single output transactions to send.`);

	// SPEND EVERYTHING AT ONCE
	node.p2p.broadcast(serializer.serialize.transactions(txs), { topic: 'transactions' });
	for (const tx of txs) // if no peer to broadcast to, push them one by one to mempool
		await node.memPool.pushTransaction(node, serializer.serialize.transaction(tx));
}
node.on('onBlockConfirmed', onBlockConfirmed);