// @ts-check
import { ADDRESS } from '../../types/address.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { ProgressLogger } from '../../utils/progress-logger.mjs';
import { HashFunctions, AsymetricFunctions } from './conCrypto.mjs';

/**
* @typedef {import("../../storage/storage.mjs").ContrastStorage} ContrastStorage
* @typedef {import("../../utils/front-storage.mjs").FrontStorage} FrontStorage
* @typedef {import("../../types/transaction.mjs").Transaction} Transaction
* @typedef {import("../../types/transaction.mjs").LedgerUtxo} LedgerUtxo */

class GeneratedAccount {
	/** @param {string} address @param {string} seedModifierHex */
	constructor(address, seedModifierHex) {
		this.address = address;
		this.seedModifierHex = seedModifierHex;
	};
}
class EncryptedGeneratedAccount extends GeneratedAccount {
	/** @param {string} address @param {string} seedModifierHex @param {string} iv */
	constructor(address, seedModifierHex, iv) {
		super(address, seedModifierHex);
		this.iv = iv;
	}
}

export class Account {
    #privKey;
	pubKey;
	prefix;		// e.g., 'C'
	b58;		// e.g., '123456'

	/** @type {LedgerUtxo[]} */				ledgerUtxos = [];
    /** @type {number} */ 					balance = 0;
	/** @type {number} */					totalSent = 0;
	/** @type {number} */					totalReceived = 0;
    /** @type {number} */					spendableBalance = 0;

	/** @param {string} pubKey @param {string} privKey @param {string} b58 @param {string} [prefix] default: 'C' */
    constructor(pubKey, privKey, b58, prefix = 'C') {
        this.pubKey = pubKey;
        this.#privKey = privKey;
        this.b58 = b58;
		this.prefix = prefix;
    }

	get address() { return `${this.prefix}${this.b58}`; }

    /** @param {Transaction} transaction */
    signTransaction(transaction) {
        if (typeof this.#privKey !== 'string') throw new Error('Invalid private key');
		if (!Array.isArray(transaction.witnesses)) throw new Error('Invalid witnesses');

		const toSign = Transaction_Builder.getTransactionSignableString(transaction);
        const { signatureHex } = AsymetricFunctions.signMessage(toSign, this.#privKey);
        if (transaction.witnesses.includes(`${signatureHex}:${this.pubKey}`)) throw new Error('Signature already included');
        transaction.witnesses.push(`${signatureHex}:${this.pubKey}`);
        return transaction;
    }
    /** @param {number} balance @param {LedgerUtxo[]} ledgerUtxos */
    setBalanceAndUTXOs(balance, ledgerUtxos, spendableBalance = 0) {
        if (typeof balance !== 'number') throw new Error('Invalid balance');
        if (!Array.isArray(ledgerUtxos)) throw new Error('Invalid LedgerUtxos');

        this.balance = balance;
        this.ledgerUtxos = ledgerUtxos;
        this.spendableBalance = spendableBalance;
    }
    /** @param {number} length - len of the hex hash */
    async getUniqueHash(length = 64) {
        const hash = await HashFunctions.SHA256(this.pubKey + this.#privKey);
        return hash.substring(0, length);
    }
}

export class Wallet {
    #masterHex = '';
	converter = serializer.converter;
    miniLogger = new MiniLogger('wallet');

    /** @type {Account[]} */			accounts = [];
    /** @type {GeneratedAccount[]} */	accountsGenerated = [];

	/** @param {string} masterHex - hex string of the master seed */
    constructor(masterHex) { this.#masterHex = masterHex; }

	// API
	static generateRandomMasterHex() {
		const randomBytes = new Uint8Array(32);
		crypto.getRandomValues(randomBytes);
		return serializer.converter.bytesToHex(randomBytes);
	}
	/** @param {ContrastStorage} contrastStorage */
	async loadAccountsFromStorage(contrastStorage) {
		/** @type {EncryptedGeneratedAccount[] | null} */
		const accountsGeneratedEncrypted = contrastStorage.loadJSON(`accounts-${contrastStorage.localIdentifier}`);
		if (!accountsGeneratedEncrypted) return false;
		await this.#loadAccounts(accountsGeneratedEncrypted);
	}
	/** @param {ContrastStorage} contrastStorage */
	async saveAccountsToStorage(contrastStorage) {
		const encryptedAccounts = await this.#encryptAccounts();
		contrastStorage.saveJSON(`accounts-${contrastStorage.localIdentifier}`, encryptedAccounts);
	}
	/** @param {FrontStorage} frontStorage */
	async loadAccountsFromFrontStorage(frontStorage) {
		/** @ts-ignore @type {EncryptedGeneratedAccount[] | null} */
		const accountsGeneratedEncrypted = await frontStorage.load(`accounts-${await this.#walletIdentifier()}`);
		if (!accountsGeneratedEncrypted) return false;
		await this.#loadAccounts(accountsGeneratedEncrypted);
	}
	/** @param {FrontStorage} frontStorage */
	async saveAccountsToFrontStorage(frontStorage) {
		const encryptedAccounts = await this.#encryptAccounts();
		await frontStorage.save(`accounts-${await this.#walletIdentifier()}`, encryptedAccounts);
	}

	/** Derive accounts from master seed. (If storage is provide: load and save accounts)
	 * @param {number} [nbOfAccounts] - default: 1 @param {string} [addressPrefix] - default: 'C' @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage] */
    async deriveAccounts(nbOfAccounts = 1, addressPrefix = 'C', contrastStorage, frontStorage) {
		if (contrastStorage) await this.loadAccountsFromStorage(contrastStorage);
		if (frontStorage) await this.loadAccountsFromFrontStorage(frontStorage);

        const nbOfExistingAccounts = this.accountsGenerated.length;
        const accountToLoad = Math.min(nbOfExistingAccounts, nbOfAccounts);
        for (let i = 0; i < accountToLoad; i++) {
			if (this.accounts[i]) continue; // already derived account
            if (!this.accountsGenerated[i]) continue; // no saved account
			
			// from saved account
			const { address, seedModifierHex } = this.accountsGenerated[i];
			const seedHex = await HashFunctions.SHA256(this.#masterHex + seedModifierHex);
			const keyPair = AsymetricFunctions.generateKeyPairFromHash(seedHex);
			if (!keyPair) throw new Error('Failed to generate key pair from saved account');
			
			this.accounts.push(new Account(keyPair.pubKeyHex, keyPair.privKeyHex, address.substring(1), addressPrefix));
        }
		
		let iterationsPerAccount = 0; // metrics
		const accountToGenerate = nbOfAccounts - nbOfExistingAccounts < 0 ? 0 : nbOfAccounts - nbOfExistingAccounts;
		const progressLogger = accountToGenerate ? new ProgressLogger(accountToGenerate, '[WALLET] deriving accounts') : null;
		if (accountToGenerate) this.miniLogger.log(`[WALLET] deriving ${accountToGenerate} account`, (m, c) => console.info(m, c));
        
		for (let i = nbOfExistingAccounts; i < nbOfAccounts; i++) {
            if (this.accounts[i]) continue; // already derived account (should not append here)
            
			const derivationResult = await this.#tryDerivationUntilValidAccount(i, addressPrefix);
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

		if (contrastStorage) await this.saveAccountsToStorage(contrastStorage);
		if (frontStorage) await this.saveAccountsToFrontStorage(frontStorage);
		
        return { derivedAccounts: this.accounts, avgIterations: avgIterations };
    }
	/** @param {string} [addressPrefix] - default: 'C' @param {ContrastStorage} [contrastStorage] @param {FrontStorage} [frontStorage] */
	async deriveOneAccount(addressPrefix = 'C', contrastStorage, frontStorage) {
		const accountsBefore = this.accounts.length;
		const result = await this.deriveAccounts(accountsBefore + 1, addressPrefix, contrastStorage, frontStorage);
		if (!result.derivedAccounts || result.derivedAccounts.length <= accountsBefore) return null;
		return result.derivedAccounts[accountsBefore];
	}

	// INTERNALS
	/** @param {number} accountIndex @param {string} [prefix] default 'C' */
    async #tryDerivationUntilValidAccount(accountIndex = 0, prefix = 'C') {
        // To be sure we have enough iterations, but avoid infinite loop
        const maxIterations = 65_536;
        const seedModifierStart = accountIndex * maxIterations;
        for (let i = 0; i < maxIterations; i++) {
            const seedModifier = seedModifierStart + i;
            const seedModifierHex = seedModifier.toString(16).padStart(12, '0'); // padStart(12, '0') => 48 bits (6 bytes), maxValue = 281 474 976 710 655
			const seedHex = await HashFunctions.SHA256(this.#masterHex + seedModifierHex);
			const keyPair = AsymetricFunctions.generateKeyPairFromHash(seedHex);
			if (!keyPair) throw new Error('Failed to generate key pair during account derivation');

			const b58 = ADDRESS.deriveB58(keyPair.pubKeyHex);
			if (!ADDRESS.checkConformity(`${prefix}${b58}`)) continue;

			const account = new Account(keyPair.pubKeyHex, keyPair.privKeyHex, b58, prefix);
			this.accountsGenerated.push({ address: account.address, seedModifierHex });
			return { account, iterations: i };
        }

		throw new Error('Max iterations reached during account derivation');
    }
    async #walletIdentifier() {
        const hash = await HashFunctions.SHA256(`${this.#masterHex}-wallet-identifier`);
        return hash.substring(0, 16);
    }
	/** @param {EncryptedGeneratedAccount[]} accountsGeneratedEncrypted */
    async #loadAccounts(accountsGeneratedEncrypted) {
		/** @type {GeneratedAccount[]} */
		const decryptedAccounts = [];
        const masterHexUint8 = this.converter.hexToBytes(this.#masterHex);
        const key = await crypto.subtle.importKey(
            "raw",
			masterHexUint8,
            { name: "AES-GCM" },
            false, // extractable
            ["encrypt", "decrypt"]
        );
		for (const account of accountsGeneratedEncrypted) {
			const iv = this.converter.hexToBytes(account.iv);
			const seedModifierDecrypted = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv },
				key,
				this.converter.hexToBytes(account.seedModifierHex)
			);
			const seedModifierHex = this.converter.bytesToHex(new Uint8Array(seedModifierDecrypted));
			const decryptedAccount = new GeneratedAccount(account.address, seedModifierHex);
			decryptedAccounts.push(decryptedAccount);
		}

        this.accountsGenerated = decryptedAccounts;
		if (!this.accountsGenerated.length) return;
		
		// Derive all loaded accounts (fast as they are saved)
		await this.deriveAccounts(this.accountsGenerated.length);
    }
    async #encryptAccounts() {
		/** @type {EncryptedGeneratedAccount[]} */
		const encryptedAccounts = [];
		const masterHexUint8 = this.converter.hexToBytes(this.#masterHex);
        const key = await crypto.subtle.importKey(
            "raw",
			masterHexUint8,
            { name: "AES-GCM" },
            false, // extractable
            ["encrypt", "decrypt"]
        );
		
		for (const account of this.accountsGenerated) {
			const iv = new Uint8Array(12);
			crypto.getRandomValues(iv);
			const seedModifierEncrypted = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv },
				key,
				this.converter.hexToBytes(account.seedModifierHex)
			);

			const seedModifierHex = this.converter.bytesToHex(new Uint8Array(seedModifierEncrypted));
			const encryptedAccount = new EncryptedGeneratedAccount(account.address, seedModifierHex, this.converter.bytesToHex(iv));
			encryptedAccounts.push(encryptedAccount);
		}

		return encryptedAccounts;
    }
}