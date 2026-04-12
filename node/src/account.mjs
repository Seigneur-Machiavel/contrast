// @ts-check
import { ADDRESS } from '../../types/address.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { UTXO_RULES_GLOSSARY, UTXO } from '../../types/transaction.mjs';
import { HashFunctions, AsymetricFunctions, QsafeSigner } from './conCrypto.mjs';

/**
* @typedef {import("../../types/transaction.mjs").Transaction} Transaction
* @typedef {import("../../types/transaction.mjs").TxId} TxId
* @typedef {import("../../types/transaction.mjs").LedgerUtxo} LedgerUtxo */

export class Account {
	#qsafeMasterHex; 	// qsafe-sig master key in hex
	#qsafeMaster; 		// qsafe-sig master key in bytes
	prefix;				// e.g., 'C'
	/** @type {Uint8Array | undefined} qsafe-sig */
	hybridKey;
	/** @type {string | undefined} qsafe-sig hybrid public key. */
	hybridKeyHex;
	/** @type {QsafeSigner | undefined} qsafe-sig signer instance */
	signer;
	/** @type {string | undefined} base58 encoded address e.g., '123456' */
	b58;

	/** @type {TxId[]} */					historyIds = [];
	/** @type {LedgerUtxo[]} */				ledgerUtxos = [];
	/** @type {number} */ 					balance = 0;
	/** @type {number} */					totalSent = 0;
	/** @type {number} */					totalReceived = 0;
	/** @type {number} */					spendableBalance = 0;

	/** @param {string} qsafeMasterHex @param {string} [prefix] default: 'C' */
	constructor(qsafeMasterHex, prefix = 'C') {
		this.#qsafeMasterHex = qsafeMasterHex;
		this.#qsafeMaster = serializer.converter.hexToBytes(qsafeMasterHex);
		this.prefix = prefix;
	}

	get address() { return `${this.prefix}${this.b58}`; }
	get nbHistory() { return this.historyIds.length; }
	get pubKey() { return this.hybridKeyHex; }

	/** Factory method to create and initialize an Account instance. @param {string} qsafeMasterHex @param {string} [prefix] default: 'C' */
	static async initializedAccount(qsafeMasterHex, prefix = 'C') {
		const account = new Account(qsafeMasterHex, prefix);
		await account.init();
		return account;
	}

	async init() {
		this.signer = await QsafeSigner.create();
		const { hybridKey } = this.signer.loadMasterKey(this.#qsafeMaster);
		this.hybridKey = hybridKey;
		this.hybridKeyHex = serializer.converter.bytesToHex(hybridKey);
		this.b58 = ADDRESS.deriveB58(this.hybridKeyHex);
		if (!ADDRESS.checkConformity(`${this.prefix}${this.b58}`)) throw new Error('Derived address does not conform to expected format');
	}

	/** @param {Transaction} transaction */
	signTransaction(transaction) {
		if (!this.signer) throw new Error('Account not initialized with signer');
		if (!this.hybridKeyHex) throw new Error('Account not initialized with hybridKeyHex');
		if (!Array.isArray(transaction.witnesses)) throw new Error('Invalid witnesses');

		const toSign = Transaction_Builder.getTransactionSignableString(transaction);
		const hybridSig = this.signer.sign(serializer.converter.hexToBytes(toSign));
		const hybridSigHex = serializer.converter.bytesToHex(hybridSig);
		transaction.witnesses.push(`${hybridSigHex}:${HashFunctions.xxHash32(this.hybridKeyHex, 8)}`);
		return transaction;
	}
	/** @param {number} balance @param {LedgerUtxo[]} ledgerUtxos */
	setBalanceAndUTXOs(balance, ledgerUtxos) {
		if (typeof balance !== 'number') throw new Error('Invalid balance');
		if (!Array.isArray(ledgerUtxos)) throw new Error('Invalid LedgerUtxos');

		this.balance = balance;
		this.ledgerUtxos = ledgerUtxos;
	}
	/** @param {TxId[]} history */
	setHistoryIds(history) {
		this.historyIds = history;
	}
	/** @param {string} anchor */
	markUTXOAsSpent(anchor) {
		const utxo = this.ledgerUtxos.find(utxo => utxo.anchor === anchor);
		const amount = utxo?.amount;
		if (typeof amount !== 'number') throw new Error('UTXO not found for anchor: ' + anchor);

		this.balance -= amount;
		this.totalSent += amount;
		this.ledgerUtxos = this.ledgerUtxos.filter(utxo => utxo.anchor !== anchor);
	}
	/** Return a list of UTXOs that are filtered based on the provided criteria. (excludeRules or includesRules, not both)
	 * @param {number} maxHeight default: Infinity @param {string[]} [excludeRules] ex: ['sigOrSlash'] @param {string[]} [includesRules] ex: ['sigOrSlash'] */
	filteredUtxos(maxHeight = Infinity, excludeRules = [], includesRules = []) {
		if (excludeRules.length > 0 && includesRules.length > 0) throw new Error('Cannot use both excludeRules and includesRules at the same time');
		
		const rulesCodesToExclude = excludeRules.map(r => UTXO_RULES_GLOSSARY[r]?.code).filter(c => c !== undefined);
		const ruleCodesToExclude = rulesCodesToExclude.length ? new Set(rulesCodesToExclude) : undefined;
		let utxo = UTXO.fromLedgerUtxos(this.address, this.ledgerUtxos, ruleCodesToExclude);
		if (includesRules.length > 0) utxo = utxo.filter(u => includesRules.some(r => r === u.rule));
		return utxo.filter(u => parseInt(u.anchor.split(':')[0], 10) <= maxHeight);
	}
	/** Calculate the balance based on the filtered UTXOs. (excludeRules or includesRules, not both)
	 * @param {number} maxHeight default: Infinity @param {string[]} [excludeRules] ex: ['sigOrSlash'] @param {string[]} [includesRules] ex: ['sigOrSlash'] */
	filteredBalance(maxHeight = Infinity, excludeRules = [], includesRules = []) {
		const filteredUtxos = this.filteredUtxos(maxHeight, excludeRules, includesRules);
		return filteredUtxos.reduce((sum, utxo) => sum + utxo.amount, 0);
	}
}