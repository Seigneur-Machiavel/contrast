// @ts-check
//process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
//process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

// IN THIS FILE WE CAN TEST SPAMMING IMPACT WITH TWO TYPES OF WORST CASE TRANSACTIONS FOR VALIDATION:
// 1) LOT OF SINGLE OUTPUT TRANSACTIONS (HIGH VALIDATION COST FOR THE NUMBER OF TXS IN BLOCK)
// 2) ONE MULTI OUTPUT TRANSACTION WITH LOT OF OUTPUTS (HIGH VALIDATION COST FOR ONE SINGLE TX IN BLOCK)

import { ADDRESS } from '../../types/address.mjs';
import { Wallet } from '../../node/src/wallet.mjs';
import { Account } from '../../node/src/account.mjs';
import { Transfer } from "../../types/transaction.mjs";
import { serializer } from '../../utils/serializer.mjs';
import { ContrastStorage } from '../../storage/storage.mjs';
import { createContrastNode } from '../../node/src/node.mjs';
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
// -------------------------------------------------------------------------------------

/** @type {Wallet[]} */
const wallets = [];
const nbWalletToGenerate = Math.ceil(nbReceipients / ADDRESS.CRITERIA.ADDRESSES_PER_ROOT);
for (let i = 0; i < nbWalletToGenerate; i++)
	wallets.push(await Wallet.initializedWallet(storage, undefined, undefined, mayoVariant));

console.log(`${nbWalletToGenerate} wallets generated! (${nbWalletToGenerate * ADDRESS.CRITERIA.ADDRESSES_PER_ROOT} accounts)`);

/** create TX to check size, if too big it will throw, then we stop adding identityEntries
 * @param {Account} senderAccount @param {Uint8Array[]} identityEntries */
const createTransactionOrPopIdentityIfNotPossible = (senderAccount, identityEntries, removeSelectedUtxos = false) => {
	try {
		const { tx, selectedUtxos } = Transaction_Builder.createTransaction(senderAccount, [], undefined, 1, identityEntries);
		if (removeSelectedUtxos) for (const utxo of selectedUtxos) senderAccount.markUTXOAsSpent(utxo.anchor);
		return tx;
	} catch (/** @type {any} */ error) { identityEntries.pop(); } // we need to remove identity entry as well
}

/** create TX to check size, if too big it will throw, then we stop adding outputs
 * @param {Account} senderAccount @param {Transfer[]} transfers */
const createTransactionOrPopTransferIfNotPossible = (senderAccount, transfers, removeSelectedUtxos = false) => {
	try {
		const { tx, selectedUtxos } = Transaction_Builder.createTransaction(senderAccount, transfers, undefined, 1);
		if (removeSelectedUtxos) for (const utxo of selectedUtxos) senderAccount.markUTXOAsSpent(utxo.anchor);
		return tx;
	} catch (/** @type {any} */ error) { transfers.pop(); } // remove last transfer that caused failure
}

/** @param {import("../../node/src/blockchain.mjs").BlockFinalized} block */
const onBlockConfirmed = async (block) => {
	const [validatorAccount, solverAccount] = [nodeWallet.accounts[0], nodeWallet.accounts[1]];
	if (!validatorAccount || !solverAccount) return; // nodeWallet not ready yet!
	
	const txs = [];
	const { identityStore, ledgersStorage, ownershipStorage } = node.blockchain;
	const loadLedgerStart = performance.now();
	const solverLedger = ledgersStorage.getAddressLedger(solverAccount.address);
	console.log(`Load solver ledger: ${(performance.now() - loadLedgerStart).toFixed(2)}ms | ${solverLedger.getNbUtxos} utxos | ${solverLedger.getNbHistory} history entries.`);
	solverAccount.setBalanceAndUTXOs(solverLedger.getBalance, solverLedger.getUtxos);

	// TEST: CREATE MISSING IDENTITIES
	/** @type {Uint8Array[]} */
	let identityEntries = [];
	for (const wallet of wallets) {
		if (wallet.walletId) continue; // ready

		const rootAddress = ownershipStorage.getOwnedRootAddress([wallet.hybridKeyHex]);
		if (rootAddress) wallet.assignRootAddress(rootAddress); // newly attributed
		else { // or declare the wallet identity
			identityEntries.push(identityStore.buildEntry([wallet.hybridKeyHex]));

			// IF ABLE TO ADD ENTRY => DO NOTHTING
			if (createTransactionOrPopIdentityIfNotPossible(solverAccount, identityEntries)) continue;
			
			// IF FULLY FILLED => SIGN & PUSH TX
			const tx = createTransactionOrPopIdentityIfNotPossible(solverAccount, identityEntries, true);
			if (!tx) continue;

			txs.push(await nodeWallet.signTransaction(tx, 1));
			console.log(`Prepared 1 tx with ${identityEntries.length} identities reservation.`);
			identityEntries = []; // CLEAR IDENTITIES ARRAY
		}
	}
	if (identityEntries.length) { // REMAINING JOB
		const tx = createTransactionOrPopIdentityIfNotPossible(solverAccount, identityEntries, true);
		if (!tx) throw new Error('UNABLE TO CREATE TX!!!');

		txs.push(await nodeWallet.signTransaction(tx, 1));
		console.log(`Prepared 1 tx with ${identityEntries.length} identities reservation.`);
	}
	
	// TEST: CREATE TRANSACTIONS WITH MULTI OUTPUTS (ONLY ON ODD BLOCKS)
	if (txs.length === 0 && block.index % 2 === 1) {
		const totalTransfers = () => nbTransfersWrapInTx + transfers.length;
		let nbTransfersWrapInTx = 0;
		let transfers = [];
		for (const wallet of wallets) {
			if (totalTransfers() >= nbReceipients) break; // enough transfers
			
			for (const account of wallet.accounts) {
				if (totalTransfers() >= nbReceipients) break; // enough transfers
				transfers.push(new Transfer(account.address, 1_000));

				// IF ABLE TO ADD transfer => DO NOTHTING
				if (createTransactionOrPopTransferIfNotPossible(solverAccount, transfers)) continue;

				// IF FULLY FILLED => SIGN & PUSH TX
				const createTxStart = performance.now();
				const tx = createTransactionOrPopTransferIfNotPossible(solverAccount, transfers, true);
				if (!tx) continue;
				
				console.log(`multi outputs tx: ${(performance.now() - createTxStart).toFixed(2)}ms`);
				txs.push(await nodeWallet.signTransaction(tx, 1));
				console.log(`Prepared 1 tx with ${tx.outputs.length} outputs.`);
				nbTransfersWrapInTx += transfers.length;
				transfers = [];
			}
		}

		if (transfers.length) { // REMAINING JOB
			const tx = createTransactionOrPopTransferIfNotPossible(solverAccount, transfers, true);
			if (!tx) throw new Error('UNABLE TO CREATE TX!!!');
			txs.push(await nodeWallet.signTransaction(tx, 1));
			console.log(`Prepared 1 tx with ${tx.outputs.length} outputs.`);
		}
	}

	// TEST: CREATE SINGLE OUTPUT TRANSACTIONS (ONLY ON EVEN BLOCKS)
	if (txs.length === 0 && block.index % 2 === 0) {
		for (const wallet of wallets) {
			if (txs.length >= nbOfSenders) break; // enough txs
			
			for (const account of wallet.accounts) {
				if (txs.length >= nbOfSenders) break; // enough txs

				const ledger = ledgersStorage.getAddressLedger(account.address);
				account.setBalanceAndUTXOs(ledger.getBalance, ledger.getUtxos);
				const { signedTx, selectedUtxos } = await Transaction_Builder.createAndSignTransaction(account, 'max', solverAccount.address, 1);
				if (!signedTx || !selectedUtxos) continue;

				txs.push(signedTx);
				for (const utxo of selectedUtxos) account.markUTXOAsSpent(utxo.anchor);
			}
		}
	}

	if (txs.length === 0) return; // no tx to send
	else console.log(`${txs.length} transactions to be sent...`);

	// SPEND EVERYTHING
	if (txs.length === 1) node.p2p.broadcast(serializer.serialize.transaction(txs[0]), { topic: 'transaction' });
	else node.p2p.broadcast(serializer.serialize.transactions(txs), { topic: 'transactions' });

	for (const tx of txs) // if no peer to broadcast to, push them one by one to mempool
		await node.memPool.pushTransaction(node, serializer.serialize.transaction(tx));
}
node.on('onBlockConfirmed', onBlockConfirmed);