// @ts-check

import { ADDRESS } from '../types/address.mjs';
import { Wallet } from '../node/src/wallet.mjs';
import { Account } from '../node/src/account.mjs';
import { Transfer } from '../types/transaction.mjs';
import { serializer } from '../utils/serializer.mjs';
import { Transaction_Builder } from '../node/src/transaction.mjs';
import { BLOCKCHAIN_SETTINGS } from '../config/blockchain-settings.mjs';

/**
 * @typedef {import('../types/transaction.mjs').Transaction} Transaction
 * @typedef {import('../node/src/node.mjs').ContrastNode} ContrastNode
 */

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

export class TestTransactionCreator {
	/** @type {Transaction[]} */
	txs = [];

	/** @type {Wallet[]} */
	wallets = [];
	node;
	nodeWallet;
	identityStore;
	ledgersStorage;
	ownershipStorage;
	nbOfSenders = 0;
	nbReceipients = 0;
	get validatorAccount() { return this.nodeWallet.accounts[0]; }
	get solverAccount() { return this.nodeWallet.accounts[1]; }
	clearPreparedTxs() { this.txs = []; }

	/** @param {ContrastNode} node */
	constructor(node) {
		if (!node.wallet) throw new Error("Node's wallet needs to be initialized!");

		this.node = node;
		this.nodeWallet = node.wallet;
		this.identityStore = node.blockchain.identityStore;
		this.ledgersStorage = node.blockchain.ledgersStorage;
		this.ownershipStorage = node.blockchain.ownershipStorage;
	}
	/** @param {ContrastNode} node @param {'mayo1' | 'mayo2'} [mayoVariant] default: 'mayo1' */
	static async newInstance(node, mayoVariant = 'mayo1', nbOfSenders = 0, nbReceipients = 0) {
		const ttc = new TestTransactionCreator(node);
		ttc.nbOfSenders = nbOfSenders;
		ttc.nbReceipients = nbReceipients;

		// INIT WALLETS...
		const nbWalletToGenerate = Math.ceil(nbReceipients / ADDRESS.CRITERIA.ADDRESSES_PER_ROOT);
		for (let i = 0; i < nbWalletToGenerate; i++)
			ttc.wallets.push(await Wallet.initializedWallet(node.mainStorage, undefined, undefined, mayoVariant));
		
		console.log(`${nbWalletToGenerate} wallets generated! (${nbWalletToGenerate * ADDRESS.CRITERIA.ADDRESSES_PER_ROOT} accounts)`);

		return ttc; // return the initialized instance.
	}

	/** Specify if the nodeWallet accounts are ready (known by consensus) */
	mainAccountsReady() { return this.validatorAccount && this.solverAccount ? true : false; }
	updateAccountBalanceAndLedger(account = this.solverAccount, logs = false) {
		const loadLedgerStart = performance.now();
		const ledger = this.ledgersStorage.getAddressLedger(account.address);
		if (logs) console.log(`Load solver ledger: ${(performance.now() - loadLedgerStart).toFixed(2)}ms | ${ledger.getNbUtxos} utxos | ${ledger.getNbHistory} history entries.`);
		account.setBalanceAndUTXOs(ledger.getBalance, ledger.getUtxos);
	}

	async createMissingIdentitiesTransactions(logs = false) {
		/** @type {Uint8Array[]} */
		let identityEntries = [];
		for (const wallet of this.wallets) {
			if (wallet.walletId) continue; // ready
	
			const rootAddress = this.ownershipStorage.getOwnedRootAddress([wallet.hybridKeyHex]);
			if (rootAddress) wallet.assignRootAddress(rootAddress); // newly attributed
			else { // or declare the wallet identity
				identityEntries.push(this.identityStore.buildEntry([wallet.hybridKeyHex]));
	
				// IF ABLE TO ADD ENTRY => DO NOTHTING
				if (createTransactionOrPopIdentityIfNotPossible(this.solverAccount, identityEntries)) continue;
				
				// IF FULLY FILLED => SIGN & PUSH TX
				const tx = createTransactionOrPopIdentityIfNotPossible(this.solverAccount, identityEntries, true);
				if (!tx) continue;
	
				this.txs.push(await this.nodeWallet.signTransaction(tx, 1));
				if (logs) console.log(`Prepared 1 tx with ${identityEntries.length} identities reservation.`);
				identityEntries = []; // CLEAR IDENTITIES ARRAY
			}
		}
		if (identityEntries.length) { // REMAINING JOB
			const tx = createTransactionOrPopIdentityIfNotPossible(this.solverAccount, identityEntries, true);
			if (!tx) throw new Error('UNABLE TO CREATE TX!!!');
	
			this.txs.push(await this.nodeWallet.signTransaction(tx, 1));
			if (logs) console.log(`Prepared 1 tx with ${identityEntries.length} identities reservation.`);
		}
	}

	/** Will send small amount to lot of accounts from solver account in a single tx */
	async createMultiOutputsTransactions(logs = false) {
		const totalTransfers = () => nbTransfersWrapInTx + transfers.length;
		let nbTransfersWrapInTx = 0;
		let transfers = [];
		for (const wallet of this.wallets) {
			if (totalTransfers() >= this.nbReceipients) break; // enough transfers
			
			for (const account of wallet.accounts) {
				if (totalTransfers() >= this.nbReceipients) break; // enough transfers
				transfers.push(new Transfer(account.address, 1_000));

				// IF ABLE TO ADD transfer => DO NOTHTING
				if (createTransactionOrPopTransferIfNotPossible(this.solverAccount, transfers)) continue;

				// IF FULLY FILLED => SIGN & PUSH TX
				const createTxStart = performance.now();
				const tx = createTransactionOrPopTransferIfNotPossible(this.solverAccount, transfers, true);
				if (!tx) continue;
				
				if (logs) console.log(`multi outputs tx: ${(performance.now() - createTxStart).toFixed(2)}ms`);
				this.txs.push(await this.nodeWallet.signTransaction(tx, 1));
				if (logs) console.log(`Prepared 1 tx with ${tx.outputs.length} outputs.`);
				nbTransfersWrapInTx += transfers.length;
				transfers = [];
			}
		}

		if (transfers.length) { // REMAINING JOB
			const tx = createTransactionOrPopTransferIfNotPossible(this.solverAccount, transfers, true);
			if (!tx) throw new Error('UNABLE TO CREATE TX!!!');
			this.txs.push(await this.nodeWallet.signTransaction(tx, 1));
			if (logs) console.log(`Prepared 1 tx with ${tx.outputs.length} outputs.`);
		}
	}

	/** Will send back all the available amounts back from accounts to the solver account */
	async createSingleOutputTransactions() {
		for (const wallet of this.wallets) {
			if (this.txs.length >= this.nbOfSenders) break; // enough txs
			
			for (const account of wallet.accounts) {
				if (this.txs.length >= this.nbOfSenders) break; // enough txs

				this.updateAccountBalanceAndLedger(account);
				const { signedTx, selectedUtxos } = await Transaction_Builder.createAndSignTransaction(account, 'max', this.solverAccount.address, 1);
				if (!signedTx || !selectedUtxos) continue;

				this.txs.push(signedTx);
				for (const utxo of selectedUtxos) account.markUTXOAsSpent(utxo.anchor);
			}
		}
	}

	async createStakingTransaction(logs = false) {
		const senderAccount = this.nodeWallet.accounts[0];
		if (!this.node.sync.isSynced.sameHeight) return; // only stake when synced to avoid staking on old blocks on every new peer connection

		const sigUtxos = senderAccount.filteredUtxos(undefined, undefined, ['sig']);
		const availableAmount = sigUtxos.reduce((a, b) => a + b.amount, 0);
		if (availableAmount < BLOCKCHAIN_SETTINGS.stakeAmount * 2) return; // not enough to stake
		
		// CREATE STAKING TRANSACTION
		const { tx } = Transaction_Builder.createStakingVss(senderAccount, 1);
		const signedTx = await senderAccount.parentWallet.signTransaction(tx);
		if (signedTx) this.txs.push(signedTx);
		else if (logs) console.log("Failed to create Staking tx...");
	}

	/** Will send all txs using network if possible, and also pushing them to self mempool */
	async sendAllPreparedTxs(logs = false) {
		if (this.txs.length === 0) return; // no tx to send
		else if (logs) console.log(`${this.txs.length} transactions to be sent...`);
	
		// SPEND EVERYTHING OVER NETWORK
		if (this.txs.length === 1) this.node.p2p.broadcast(serializer.serialize.transaction(this.txs[0]), { topic: 'transaction' });
		else this.node.p2p.broadcast(serializer.serialize.transactions(this.txs), { topic: 'transactions' });
	
		for (const tx of this.txs) // then push them one by one to self mempool
			await this.node.memPool.pushTransaction(this.node, serializer.serialize.transaction(tx));
	}
}