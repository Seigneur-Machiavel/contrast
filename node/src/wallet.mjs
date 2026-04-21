// @ts-check
import { Account } from './account.mjs';
import { ADDRESS } from '../../types/address.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { ProgressLogger } from '../../utils/progress-logger.mjs';
import { HashFunctions, AsymetricFunctions, randomBytes } from './conCrypto.mjs';

/**
* @typedef {import("../../storage/storage.mjs").ContrastStorage} ContrastStorage
* @typedef {import("../../utils/front-storage.mjs").FrontStorage} FrontStorage */

class GeneratedAccount {
	/** @param {string} address @param {string} seedModifierHex @param {'mayo1' | 'mayo2'} [mayoVariant] default: 'mayo1' @param {string} [qsafeSigVersion] default: '1' */
	constructor(address, seedModifierHex, mayoVariant = 'mayo1', qsafeSigVersion = '1') {
		this.address = address;
		this.mayoVariant = mayoVariant;
		this.qsafeSigVersion = qsafeSigVersion;
		this.seedModifierHex = seedModifierHex;
	};
}

export class Wallet {
    #masterHex = '';
	converter = serializer.converter;
    miniLogger = new MiniLogger('wallet');
	get walletIdentifier() { return HashFunctions.SHA512(this.#masterHex).hashHex.substring(0, 8); }
	get balance() { return this.accounts.reduce((sum, account) => sum + account.balance, 0); }
	get stakedBalance() { return this.accounts.reduce((sum, account) => sum + account.filteredBalance(Infinity, [], ['sigOrSlash']), 0); }

    /** @type {Account[]} */			accounts = [];
    /** @type {GeneratedAccount[]} */	accountsGenerated = [];

	/** @param {string} masterHex - hex string of the master seed */
    constructor(masterHex) { this.#masterHex = masterHex; }

	// API
	static generateRandomMasterHex(bytesLength = 24) {
		const bytes = randomBytes(bytesLength);
		const hex =  serializer.converter.bytesToHex(bytes);
		return { bytes, hex };
	}
	/** @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage] */
	async loadAccountsFromStorage(contrastStorage, frontStorage) {
		const key = `accounts-${this.walletIdentifier}`;
		if (!contrastStorage && !frontStorage) throw new Error('No storage provided');

		/** @type {GeneratedAccount[] | null} */ // @ts-ignore
		const accountsGenerated = contrastStorage ? contrastStorage.loadJSON(key) : await frontStorage.load(key);
		if (!accountsGenerated?.length) return false;

		// Derive all loaded accounts (fast as they are saved)
		this.accountsGenerated = accountsGenerated;
		await this.deriveAccounts(this.accountsGenerated.length, 'C', 'mayo1', '1', contrastStorage, frontStorage);
	}
	/** @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage] */
	async removeAccountsFromStorage(contrastStorage, frontStorage) {
		const key = `accounts-${this.walletIdentifier}`;
		if (!contrastStorage && !frontStorage) throw new Error('No storage provided');
		if (contrastStorage) contrastStorage.deleteFile(`${key}.json`);
		else if (frontStorage) await frontStorage.remove(key);
	}
	/** Derive accounts from master seed. (If storage is provide: load and save accounts)
	 * @param {number} [nbOfAccounts] - default: 1 @param {string} [addressPrefix] - default: 'C' @param {'mayo1' | 'mayo2'} [mayoVariant] default: 'mayo1' @param {string} [qsafeSigVersion] default: '1' @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage] */
    async deriveAccounts(nbOfAccounts = 1, addressPrefix = 'C', mayoVariant = 'mayo1', qsafeSigVersion = '1', contrastStorage, frontStorage) {
		if (!this.accountsGenerated) await this.loadAccountsFromStorage(contrastStorage, frontStorage);

        const nbOfExistingAccounts = this.accountsGenerated.length;
        const accountToLoad = Math.min(nbOfExistingAccounts, nbOfAccounts);
        for (let i = 0; i < accountToLoad; i++) {
			if (this.accounts[i]) continue; // already derived account
            if (!this.accountsGenerated[i]) continue; // no saved account
			
			// from saved account
			const { address, seedModifierHex } = this.accountsGenerated[i];
			const qsafeMasterHex = HashFunctions.SHA512(this.#masterHex + seedModifierHex).hashHex;
			const account = await Account.initializedAccount(qsafeMasterHex, addressPrefix, mayoVariant, qsafeSigVersion);
			if (address !== account.address) throw new Error('Loaded account address does not match derived address');
			this.accounts.push(account);
        }
		
		let iterationsPerAccount = 0; // metrics
		const accountToGenerate = nbOfAccounts - nbOfExistingAccounts < 0 ? 0 : nbOfAccounts - nbOfExistingAccounts;
		const progressLogger = accountToGenerate ? new ProgressLogger(accountToGenerate, '[WALLET] deriving accounts') : null;
		if (accountToGenerate) this.miniLogger.log(`[WALLET] deriving ${accountToGenerate} account`, (m, c) => console.info(m, c));
        
		for (let i = nbOfExistingAccounts; i < nbOfAccounts; i++) {
            if (this.accounts[i]) continue; // already derived account (should not append here)
            
			const derivationResult = await this.#tryDerivationUntilValidAccount(i, addressPrefix, mayoVariant, qsafeSigVersion);
            if (!derivationResult) {
                const derivedAccounts = this.accounts.slice(nbOfExistingAccounts).length;
                this.miniLogger.log(`Failed to derive account (derived: ${derivedAccounts})`, (m, c) => console.info(m, c));
                return {};
            }

            iterationsPerAccount += derivationResult.iterations;
            this.accounts.push(derivationResult.account);
            progressLogger?.logProgress(this.accounts.length - nbOfExistingAccounts, (m, c) => this.miniLogger.log(m, c));
        }

        if (this.accounts.length !== nbOfAccounts) {
            this.miniLogger.log(`Failed to derive all accounts: ${this.accounts.length}/${nbOfAccounts}`, (m, c) => console.info(m, c));
            return {};
        }
        
        const derivedAccounts = this.accounts.slice(nbOfExistingAccounts);
        const avgIterations = derivedAccounts.length > 0 ? Math.round(iterationsPerAccount / derivedAccounts.length) : 0;
        if (derivedAccounts.length) this.miniLogger.log(`[WALLET] ${derivedAccounts.length} accounts derived with prefix: ${addressPrefix}
avgIterations/account: ${avgIterations}`, (m, c) => console.info(m, c));

		await this.#saveAccountsToStorage(contrastStorage, frontStorage);
        return { derivedAccounts: this.accounts, avgIterations: avgIterations };
    }
	/** @param {string} [addressPrefix] - default: 'C' @param {'mayo1' | 'mayo2'} [mayoVariant] default: 'mayo1' @param {string} [qsafeSigVersion] default: '1' @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage] */
	async deriveOneAccount(addressPrefix = 'C', mayoVariant = 'mayo1', qsafeSigVersion = '1', contrastStorage, frontStorage) {
		const accountsBefore = this.accounts.length;
		const result = await this.deriveAccounts(accountsBefore + 1, addressPrefix, mayoVariant, qsafeSigVersion, contrastStorage, frontStorage);
		if (!result.derivedAccounts || result.derivedAccounts.length <= accountsBefore) return null;
		return result.derivedAccounts[accountsBefore];
	}
	async destroy() {
		this.#masterHex = '';
		this.accounts = [];
		this.accountsGenerated = [];
	}

	// INTERNALS
	/** @param {number} accountIndex @param {string} [prefix] default 'C' @param {'mayo1' | 'mayo2'} [mayoVariant] default: 'mayo1' @param {string} [qsafeSigVersion] default: '1' */
    async #tryDerivationUntilValidAccount(accountIndex = 0, prefix = 'C', mayoVariant = 'mayo1', qsafeSigVersion = '1') {
        // To be sure we have enough iterations, but avoid infinite loop
        const maxIterations = 65_536;
        const seedModifierStart = accountIndex * maxIterations;
        for (let i = 0; i < maxIterations; i++) {
            const seedModifier = seedModifierStart + i;
            const seedModifierHex = seedModifier.toString(16).padStart(12, '0'); // padStart(12, '0') => 48 bits (6 bytes), maxValue = 281 474 976 710 655
			const qsafeMasterHex = HashFunctions.SHA512(this.#masterHex + seedModifierHex).hashHex;
			const account = await Account.initializedAccount(qsafeMasterHex, prefix, mayoVariant, qsafeSigVersion);
			this.accountsGenerated.push({ address: account.address, seedModifierHex, mayoVariant, qsafeSigVersion });
			return { account, iterations: i };
        }

		throw new Error('Max iterations reached during account derivation');
    }
	/** @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage] */
	async #saveAccountsToStorage(contrastStorage, frontStorage) {
		const key = `accounts-${this.walletIdentifier}`;
		if (!contrastStorage && !frontStorage) throw new Error('No storage provided');

		if (contrastStorage) contrastStorage.saveJSON(key, this.accountsGenerated);
		else if (frontStorage) await frontStorage.save(key, this.accountsGenerated);
	}
}