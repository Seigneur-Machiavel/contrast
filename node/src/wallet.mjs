// @ts-check
import { Account } from './account.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { HashFunctions, AsymetricFunctions, randomBytes } from './conCrypto.mjs';

/**
 * @typedef {Object} AccountInfo
 * @property {string | null} address - The account's address, or null if not available.
 * @property {'mayo1' | 'mayo2'} mayoVariant - The Mayo variant used for the account, or null if not available.
 * @property {string} qsafeSigVersion - The qsafe-sig version used for the account, or null if not available.
 * 
* @typedef {import("../../storage/storage.mjs").ContrastStorage} ContrastStorage
* @typedef {import("../../utils/front-storage.mjs").FrontStorage} FrontStorage */

export class Wallet {
    /** @type {Account[]} */
	accounts = [];
	hasLoadedAccounts = false;
    #masterHex = '';
	contrastStorage;
	frontStorage;
	converter = serializer.converter;
    miniLogger = new MiniLogger('wallet');
	get walletIdentifier() { return HashFunctions.SHA512(this.#masterHex).hashHex.substring(0, 8); }
	get balance() { return this.accounts.reduce((sum, account) => sum + account.balance, 0); }
	get stakedBalance() { return this.accounts.reduce((sum, account) => sum + account.filteredBalance(Infinity, [], ['sigOrSlash']), 0); }
	get nbAccounts() { return this.accounts.length; }

	/** One storage option must be provided, either contrastStorage or frontStorage (not both)
	 * @param {string} masterHex - hex string of the master seed @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage] */
    constructor(masterHex, contrastStorage, frontStorage) {
		if (!contrastStorage && !frontStorage) throw new Error('Wallet constructor: at least one storage option must be provided');
		if (contrastStorage && frontStorage) throw new Error('Wallet constructor: only one storage option can be provided, not both');
		this.contrastStorage = contrastStorage;
		this.frontStorage = frontStorage;
		this.#masterHex = masterHex;
	}

	// API
	static generateRandomMasterHex(bytesLength = 24) {
		const bytes = randomBytes(bytesLength);
		const hex =  serializer.converter.bytesToHex(bytes);
		return { bytes, hex };
	}
	/** Load all saved account */
	async init() {
		if (this.hasLoadedAccounts) return; // prevent multiple loading
		if (!this.contrastStorage && !this.frontStorage) throw new Error('No storage provided');

		const key = `accounts-${this.walletIdentifier}`;
		
		/** @type {AccountInfo[] | null} */ // @ts-ignore
		const accountsInfo = this.contrastStorage ? this.contrastStorage.loadJSON(key) : await this.frontStorage.load(key);
		if (!accountsInfo?.length) return false;

		for (const info of accountsInfo)
			await this.deriveAccount(info.mayoVariant, info.qsafeSigVersion, false, info.address);

		this.hasLoadedAccounts = true;
		return true;
	}
	/** @param {'mayo1' | 'mayo2'} [mayoVariant] default: 'mayo1' @param {string} [qsafeSigVersion] default: '1' @param {boolean} [save] default: true @param {string | null} [address] default: null */
	async deriveAccount(mayoVariant = 'mayo1', qsafeSigVersion = '1', save = true, address = null) {
		const qsafeMasterHex = HashFunctions.SHA512(this.#masterHex + this.nbAccounts).hashHex;
		const account = await Account.initializedAccount(qsafeMasterHex, mayoVariant, qsafeSigVersion, address);
		this.accounts.push(account);
		if (save) await this.saveAccountsToStorage();
		return account;
	}
	/** Derive accounts from master seed. (If storage is provide: load and save accounts)
	 * @param {number} [nbOfAccounts] - default: 1 @param {'mayo1' | 'mayo2'} [mayoVariant] default: 'mayo1' @param {string} [qsafeSigVersion] default: '1' */
    async deriveAccounts(nbOfAccounts = 1, mayoVariant = 'mayo1', qsafeSigVersion = '1') {
		if (!this.hasLoadedAccounts) await this.init(); // load accounts if not already loaded
		
		for (let i = this.nbAccounts; i < nbOfAccounts; i++)
            if (this.accounts[i]) throw new Error(`Account at index ${i} already exists`);
			else await this.deriveAccount(mayoVariant, qsafeSigVersion, false);

		await this.saveAccountsToStorage();
    }
	async saveAccountsToStorage() {
		const key = `accounts-${this.walletIdentifier}`;
		if (!this.contrastStorage && !this.frontStorage) throw new Error('No storage provided');

		const accountsInfo = this.accounts.map(account => account.accountInfo);
		if (this.contrastStorage) this.contrastStorage.saveJSON(key, accountsInfo);
		else if (this.frontStorage) await this.frontStorage.save(key, accountsInfo);
	}
	async removeAccountsFromStorage() {
		const key = `accounts-${this.walletIdentifier}`;
		if (!this.contrastStorage && !this.frontStorage) throw new Error('No storage provided');
		if (this.contrastStorage) this.contrastStorage.deleteFile(`${key}.json`);
		else if (this.frontStorage) await this.frontStorage.remove(key);
	}
	async destroy() {
		this.#masterHex = '';
		this.accounts = [];
	}
}