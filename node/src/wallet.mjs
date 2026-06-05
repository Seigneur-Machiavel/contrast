// @ts-check
import { Account } from './account.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { HashFunctions, QsafeSigner, randomBytes } from './conCrypto.mjs';
import { ADDRESS } from '../../types/address.mjs';

/**
 * @typedef {Object} AccountInfo
 * @property {string | null} address - The account's address, or null if not available.
 * @property {'mayo1' | 'mayo2'} mayoVariant - The Mayo variant used for the account, or null if not available.
 * @property {string} qsafeSigVersion - The qsafe-sig version used for the account, or null if not available.
 * 
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../storage/storage.mjs").ContrastStorage} ContrastStorage
 * @typedef {import("../../utils/front-storage.mjs").FrontStorage} FrontStorage */

export class Wallet {
	#qsafeMasterHex; 	// qsafe-sig master key in hex
	#qsafeMaster; 		// qsafe-sig master key in bytes
	#mayoVariant;		// The Mayo variant to use for signature generation.
	#qsafeSigVersion;	// qsafe-sig version as string, e.g., '1'
																// @ts-ignore: assigned in init()
	/** @type {QsafeSigner} qsafe-sig instance */  	#signer;		// @ts-ignore: assigned in init()
	/** @type {Uint8Array} qsafe-sig */ 			hybridKey;	// @ts-ignore: assigned in init()
	/** @type {string} qsafe-sig pubKey. */			hybridKeyHex;

    /** @type {Account[]} */
	accounts = [];
    #masterHex = '';
	contrastStorage;
	frontStorage;
	converter = serializer.converter;
    miniLogger = new MiniLogger('wallet');
	get walletId() { return this.accounts[0]?.address }
	get walletIdentifier() { return HashFunctions.SHA512(this.#masterHex).hashHex.substring(0, 8); }
	get balance() { return this.accounts.reduce((sum, account) => sum + account.balance, 0); }
	get stakedBalance() { return this.accounts.reduce((sum, account) => sum + account.filteredBalance(Infinity, [], ['sigOrSlash']), 0); }
	get nbAccounts() { return this.accounts.length; }

	/** One storage option must be provided, either contrastStorage or frontStorage (not both)
	 * @param {string} masterHex - hex string of the master seed @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage]
	 * @param {'mayo1' | 'mayo2'} [mayoVariant] default: 'mayo1' @param {string} [qsafeSigVersion] default: '1' */
    constructor(masterHex, contrastStorage, frontStorage, mayoVariant = 'mayo1', qsafeSigVersion = '1') {
		if (!contrastStorage && !frontStorage) throw new Error('Wallet constructor: at least one storage option must be provided');
		if (contrastStorage && frontStorage) throw new Error('Wallet constructor: only one storage option can be provided, not both');
		this.contrastStorage = contrastStorage;
		this.frontStorage = frontStorage;
		this.#masterHex = masterHex;
		this.#mayoVariant = mayoVariant;
		this.#qsafeSigVersion = qsafeSigVersion;

		const qsafeMaster = HashFunctions.SHA512(this.#masterHex);
		this.#qsafeMasterHex = qsafeMaster.hashHex;
		this.#qsafeMaster = qsafeMaster.hashBytes;
	}

	// API
	static generateRandomMasterHex(bytesLength = 24) {
		const bytes = randomBytes(bytesLength);
		const hex =  serializer.converter.bytesToHex(bytes);
		return { bytes, hex };
	}
	/** Factory method to create and initialize a Wallet instance.
	 * @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage]
	 * @param {string} [masterHex] - hex string of the master seed (generated randomly if not provided)
	 * @param {'mayo1' | 'mayo2'} [mayoVariant] default: 'mayo1' @param {string} [qsafeSigVersion] default: '1' */
	static async initializedWallet(contrastStorage, frontStorage, masterHex, mayoVariant = 'mayo1', qsafeSigVersion = '1') {
		const masterSeedHex = masterHex || Wallet.generateRandomMasterHex().hex;
		const wallet = new Wallet(masterSeedHex, contrastStorage, frontStorage, mayoVariant, qsafeSigVersion);
		await wallet.init();
		return wallet;
	}
	/** Load all saved account */
	async init() {
		this.#signer = await QsafeSigner.create(this.#mayoVariant, this.#qsafeSigVersion);
		const { hybridKey } = this.#signer.loadMasterKey(this.#qsafeMaster.slice(0, 32));
		this.hybridKey = hybridKey;
		this.hybridKeyHex = serializer.converter.bytesToHex(hybridKey);

		// TRY TO LOAD ROOT ADDRESS FROM STORAGE
		const key = `walletId-${this.walletIdentifier}`;
		
		/** @type {string | null} */ // @ts-ignore
		const walletId = this.contrastStorage ? this.contrastStorage.loadJSON(key) : await this.frontStorage.load(key);
		if (!walletId) return;

		// LOAD ACCOUNTS
		this.assignRootAddress(walletId, false);
	}
	/** @param {string} walletId - The root address to assign to the wallet (e.g., C111111) @param {boolean} [saveToStorage] default: true */
	assignRootAddress(walletId, saveToStorage = true) {
		if (walletId === this.walletId) return;
		if (this.accounts.length > 0) throw new Error('Root address already assigned');
		
		const addresses = ADDRESS.getAddressesFromWalletId(walletId);
		for (const address of addresses) this.accounts.push(new Account(this, address));
		if (saveToStorage) this.#saveRootAddressToStorage();
	}
	/** @param {Transaction} transaction @param {number | string} [accountIndexOrtempAddress] 0 = walletId */
	async signTransaction(transaction, accountIndexOrtempAddress = 0) {
		const address = typeof accountIndexOrtempAddress === 'number'
			? this.accounts[accountIndexOrtempAddress]?.address
			: accountIndexOrtempAddress;
			
		if (!ADDRESS.checkConformity(address)) throw new Error('Providing invalid address for signing');
		if (!this.hybridKeyHex) throw new Error('Account not initialized with hybridKeyHex');
		if (!Array.isArray(transaction.witnesses)) throw new Error('Invalid witnesses');
		if (!this.#signer) throw new Error('Account not initialized with signer');
		
		const walletId = ADDRESS.getAddressRoot(address).walletId;
		const hashBytes = Transaction_Builder.getTransactionSignable(transaction).hashBytes;
		const hybridSig = this.#signer.sign(hashBytes);
		const hybridSigHex = serializer.converter.bytesToHex(hybridSig);
		transaction.witnesses.push([walletId, hybridSigHex]);
		return transaction;
	}
	async #saveRootAddressToStorage() {
		const key = `walletId-${this.walletIdentifier}`;
		if (!this.accounts[0]?.address) throw new Error('No accounts available to save root address');
		if (this.contrastStorage) this.contrastStorage.saveJSON(key, this.accounts[0]?.address);
		else if (this.frontStorage) await this.frontStorage.save(key, this.accounts[0]?.address);
	}
	async removeAccountsFromStorage() {
		const key = `walletId-${this.walletIdentifier}`;
		if (this.contrastStorage) this.contrastStorage.deleteFile(`${key}.json`);
		else if (this.frontStorage) await this.frontStorage.remove(key);
	}
	async destroy() {
		this.#masterHex = '';
		this.accounts = [];
	}
}