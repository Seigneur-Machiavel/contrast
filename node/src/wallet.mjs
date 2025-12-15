import { Converter } from 'hive-p2p';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { HashFunctions, AsymetricFunctions } from './conCrypto.mjs';
import { ProgressLogger } from '../../utils/progress-logger.mjs';
import { addressUtils } from '../../utils/addressUtils.mjs';
import { AccountDerivationWorker } from '../workers/workers-classes.mjs';
import { Transaction_Builder } from './transaction.mjs';

/**
* @typedef {import("../../types/transaction.mjs").Transaction} Transaction
* @typedef {import("../../types/transaction.mjs").UTXO} UTXO
* @typedef {Object} generatedAccount
* @property {string} address
* @property {string} seedModifierHex
*/

export class AddressTypeInfo { // TYPEDEF
    name = '';
    description = '';
    zeroBits = 0;
    nbOfSigners = 1;
}
export class Account {
    #privKey;
	#pubKey;
	address;

	/** @type {UTXO[]} */					UTXOs = [];
    /** @type {number} */ 					balance = 0;
    /** @type {number} */					spendableBalance = 0;
    /** @type {Object.<string, UTXO>} */	spentUTXOByAnchors = {};

	/** @param {string} pubKey @param {string} privKey @param {string} address */
    constructor(pubKey, privKey, address) {
        this.#pubKey = pubKey;
        this.#privKey = privKey;
        this.address = address;
    }

    /** @param {Transaction} transaction */
    signTransaction(transaction) {
        if (typeof this.#privKey !== 'string') throw new Error('Invalid private key');
		if (!Array.isArray(transaction.witnesses)) throw new Error('Invalid witnesses');

		const toSign = Transaction_Builder.getTransactionSignableString(transaction);
        const { signatureHex } = AsymetricFunctions.signMessage(toSign, this.#privKey, this.#pubKey);
        if (transaction.witnesses.includes(`${signatureHex}:${this.#pubKey}`)) throw new Error('Signature already included');
        transaction.witnesses.push(`${signatureHex}:${this.#pubKey}`);
        return transaction;
    }
    /** @param {number} balance @param {UTXO[]} UTXOs */
    setBalanceAndUTXOs(balance, UTXOs, spendableBalance = 0) {
        if (typeof balance !== 'number') throw new Error('Invalid balance');
        if (!Array.isArray(UTXOs)) throw new Error('Invalid UTXOs');

        this.balance = balance;
        this.UTXOs = UTXOs;
        this.spendableBalance = spendableBalance;
    }
    /** @param {number} length - len of the hex hash */
    async getUniqueHash(length = 64) {
        const hash = await HashFunctions.SHA256(this.#pubKey + this.#privKey);
        return hash.substring(0, length);
    }
}
export class Wallet {
    #masterHex = '';
	converter = new Converter();
    miniLogger = new MiniLogger('wallet');
    nbOfWorkers = 4; // default: 4

    /** @type {AccountDerivationWorker[]} */
    workers = [];
    /** @type {Object<string, Account[]>} */
    accounts = { W: [], C: [], P: [], U: [] }; // max accounts per type = 65 536
    /** @type {Object<string, generatedAccount[]>} */
    accountsGenerated = { W: [], C: [], P: [], U: [] };

	/** @param {string} masterHex - hex string of the master seed */
    constructor(masterHex) { this.#masterHex = masterHex; }

	// API
	/** @param {import("../../utils/storage.mjs").ContrastStorage} contrastStorage */
    async loadAccounts(contrastStorage) {
        const accountsGeneratedEncrypted = contrastStorage.loadJSON(`accounts-${contrastStorage.localIdentifier}`);
        if (!accountsGeneratedEncrypted) return false;
		
		this.accountsGenerated = await this.#decryptAccountsGenerated(accountsGeneratedEncrypted);
		
		// Derive all loaded accounts (fast as they are saved)
		for (const prefix in this.accountsGenerated)
			if (!this.accountsGenerated[prefix].length) continue;
			else await this.deriveAccounts(this.accountsGenerated[prefix].length, prefix);
    }
	/** Derive accounts from master seed corresponding to the desired address prefix. (If storage is provide: load and save accounts)
	 * @param {number} [nbOfAccounts] - default: 1
	 * @param {string} [addressPrefix] - default: "C"
	 * @param {import("../../utils/storage.mjs").ContrastStorage} [contrastStorage] */
    async deriveAccounts(nbOfAccounts = 1, addressPrefix = "C", contrastStorage) {
		if (contrastStorage) await this.loadAccounts(contrastStorage);

        const startTime = performance.now();
        const nbOfExistingAccounts = this.accountsGenerated[addressPrefix].length;
        const accountToGenerate = nbOfAccounts - nbOfExistingAccounts < 0 ? 0 : nbOfAccounts - nbOfExistingAccounts;
        this.miniLogger.log(`[WALLET] deriving ${accountToGenerate} accounts with prefix: ${addressPrefix} | nbWorkers: ${this.nbOfWorkers}`, (m, c) => console.info(m, c));
        //console.log(`[WALLET] deriving ${accountToGenerate} accounts with prefix: ${addressPrefix}`);

        const progressLogger = new ProgressLogger(accountToGenerate, '[WALLET] deriving accounts');
        let iterationsPerAccount = 0;

        const accountToLoad = Math.min(nbOfExistingAccounts, nbOfAccounts);
        for (let i = 0; i < accountToLoad; i++) {
            if (this.accounts[addressPrefix][i]) continue; // already derived account
            if (!this.accountsGenerated[addressPrefix][i]) continue; // no saved account
			// from saved account
			const { address, seedModifierHex } = this.accountsGenerated[addressPrefix][i];
			const keyPair = await this.#deriveKeyPair(seedModifierHex);
			const account = new Account(keyPair.pubKeyHex, keyPair.privKeyHex, address);
			this.accounts[addressPrefix].push(account);
        }

        for (let i = nbOfExistingAccounts; i < nbOfAccounts; i++) {
            if (this.accounts[addressPrefix][i]) continue; // already derived account (should not append here)
            
			let derivationResult;
            if (this.nbOfWorkers === 0) { // USUALLY UNUSED
                derivationResult = await this.#tryDerivationUntilValidAccount(i, addressPrefix);
            } else {
                for (let i = this.workers.length; i < this.nbOfWorkers; i++)
					this.workers.push(new AccountDerivationWorker(i));

                await new Promise(r => setTimeout(r, 10)); // avoid spamming the CPU/workers
                derivationResult = await this.#tryDerivationUntilValidAccountUsingWorkers(i, addressPrefix);
				
				// DESTROY WORKERS AFTER USE (to free resources) - not necessary anymore.
				//for (const worker of this.workers) await worker.terminateAsync();
				//this.workers = [];
			}

            if (!derivationResult) {
                const derivedAccounts = this.accounts[addressPrefix].slice(nbOfExistingAccounts).length;
                this.miniLogger.log(`Failed to derive account (derived: ${derivedAccounts})`, (m, c) => console.info(m, c));
                //console.log(`Failed to derive account (derived: ${derivedAccounts})`);
                return {};
            }

            const account = derivationResult.account;
            const iterations = derivationResult.iterations;
            if (!account) { this.miniLogger.log('deriveAccounts interrupted!', (m, c) => console.info(m, c)); return {}; }
            //if (!account) { console.log('deriveAccounts interrupted!'); return {}; }

            iterationsPerAccount += iterations;
            this.accounts[addressPrefix].push(account);
            progressLogger.logProgress(this.accounts[addressPrefix].length - nbOfExistingAccounts, (m, c) => this.miniLogger.log(m, c));
        }

        if (this.accounts[addressPrefix].length !== nbOfAccounts) {
            this.miniLogger.log(`Failed to derive all accounts: ${this.accounts[addressPrefix].length}/${nbOfAccounts}`, (m, c) => console.info(m, c));
            return {};
        }
        
        const endTime = performance.now();
        const derivedAccounts = this.accounts[addressPrefix].slice(nbOfExistingAccounts);
        const avgIterations = derivedAccounts.length > 0 ? Math.round(iterationsPerAccount / derivedAccounts.length) : 0;
        this.miniLogger.log(`[WALLET] ${derivedAccounts.length} accounts derived with prefix: ${addressPrefix}
avgIterations/account: ${avgIterations} | time: ${(endTime - startTime).toFixed(3)}ms`, (m, c) => console.info(m, c));
		if (contrastStorage) await this.saveAccounts(contrastStorage);

        return { derivedAccounts: this.accounts[addressPrefix], avgIterations: avgIterations };
    }
	/** @param {import("../../utils/storage.mjs").ContrastStorage} contrastStorage */
    async saveAccounts(contrastStorage) {
        const encryptedAccounts = await this.#encryptAccountsGenerated();
        contrastStorage.saveJSON(`accounts-${contrastStorage.localIdentifier}`, encryptedAccounts);
    }

	// INTERNALS
    async #tryDerivationUntilValidAccountUsingWorkers(accountIndex = 0, desiredPrefix = "C") {
        /** @type {AddressTypeInfo} */
        const addressTypeInfo = addressUtils.glossary[desiredPrefix];
        if (addressTypeInfo === undefined) throw new Error(`Invalid desiredPrefix: ${desiredPrefix}`);

        // To be sure we have enough iterations, but avoid infinite loop
        const maxIterations = 65_536 * (2 ** addressTypeInfo.zeroBits); // max with zeroBits(16): 65 536 * (2^16) => 4 294 967 296
        const seedModifierStart = accountIndex * maxIterations; // max with accountIndex: 65 535 * 4 294 967 296 => 281 470 681 743 360 
        const workerMaxIterations = Math.floor(maxIterations / this.nbOfWorkers);
        const promises = {}; // split the job between workers
        for (let i = 0; i < this.nbOfWorkers; i++) {
            const worker = this.workers[i];
            const workerSeedModifierStart = seedModifierStart + (i * workerMaxIterations);
            promises[i] = worker.derivationUntilValidAccount(
                workerSeedModifierStart,
                workerMaxIterations,
                this.#masterHex,
                desiredPrefix
            );
        }

        const firstResult = await Promise.race(Object.values(promises));
        this.accountsGenerated[desiredPrefix].push({
            address: firstResult.addressBase58,
            seedModifierHex: firstResult.seedModifierHex
        });
		
        // abort the running workers
        for (const worker of this.workers) worker.abortOperation();
		for (const p in promises) await promises[p];
        
        let iterations = 0;
		for (const p in promises) {
			const result = await promises[p];
            iterations += result.iterations || 0;
        }
		
		const account = new Account(firstResult.pubKeyHex, firstResult.privKeyHex, firstResult.addressBase58);
        return { account, iterations };
    }
    async #tryDerivationUntilValidAccount(accountIndex = 0, desiredPrefix = "C") { // SINGLE THREAD
        /** @type {AddressTypeInfo} */
        const addressTypeInfo = addressUtils.glossary[desiredPrefix];
        if (addressTypeInfo === undefined) throw new Error(`Invalid desiredPrefix: ${desiredPrefix}`);

        // To be sure we have enough iterations, but avoid infinite loop
        console.log(`[WALLET] #tryDerivationUntilValidAccount: ai: ${accountIndex} | prefix: ${desiredPrefix} | zeroBits: ${addressTypeInfo.zeroBits}`);
        const maxIterations = 65_536 * (2 ** addressTypeInfo.zeroBits); // max with zeroBits(16): 65 536 * (2^16) => 4 294 967 296
        const seedModifierStart = accountIndex * maxIterations; // max with accountIndex: 65 535 * 4 294 967 296 => 281 470 681 743 360 
        for (let i = 0; i < maxIterations; i++) {
            const seedModifier = seedModifierStart + i;
            const seedModifierHex = seedModifier.toString(16).padStart(12, '0'); // padStart(12, '0') => 48 bits (6 bytes), maxValue = 281 474 976 710 655

            try {
                //const kpStart = performance.now();
                const keyPair = await this.#deriveKeyPair(seedModifierHex);
                //console.log(`[WALLET] keyPair derived in: ${(performance.now() - kpStart).toFixed(3)}ms`);
                //const aStart = performance.now();
                const addressBase58 = await this.#deriveAccount(keyPair.pubKeyHex, desiredPrefix);
                //console.log(`[WALLET] account derived in: ${(performance.now() - aStart).toFixed(3)}ms`);
                if (addressBase58) {
                    const account = new Account(keyPair.pubKeyHex, keyPair.privKeyHex, addressBase58);
                    this.accountsGenerated[desiredPrefix].push({ address: account.address, seedModifierHex });
                    return { account, iterations: i };
                }
            } catch (/**@type {any}*/ error) {
                const errorSkippingLog = ['Address does not meet the security level'];
                if (!errorSkippingLog.includes(error.message.slice(0, 40))) this.miniLogger.log(error.stack, (m, c) => console.info(m, c));
            }
        }

        return false;
    }
    async #deriveKeyPair(seedModifierHex) {
        const seedHex = await HashFunctions.SHA256(this.#masterHex + seedModifierHex);
        const keyPair = AsymetricFunctions.generateKeyPairFromHash(seedHex);
        if (keyPair) return keyPair;
		throw new Error('Failed to generate key pair');
    }
    async #deriveAccount(pubKeyHex, desiredPrefix = "C") {
        const addressBase58 = await addressUtils.deriveAddress(HashFunctions.Argon2, pubKeyHex);
        if (!addressBase58) throw new Error('Failed to derive address');
        if (addressBase58.substring(0, 1) !== desiredPrefix) return false;

        addressUtils.conformityCheck(addressBase58);
        await addressUtils.securityCheck(addressBase58, pubKeyHex);
        return addressBase58;
    }
	async #encryptAccountsGenerated() {
        const encryptedAccounts = { W: [], C: [], P: [], U: [] };
		const masterHexUint8 = this.converter.hexToBytes(this.#masterHex);
        const key = await crypto.subtle.importKey(
            "raw",
            Buffer.from(masterHexUint8),
            { name: "AES-GCM" },
            false, // extractable
            ["encrypt", "decrypt"]
        );
        for (const prefix in this.accountsGenerated)
            for (const account of this.accountsGenerated[prefix]) {
		        const iv = new Uint8Array(12);
        		crypto.getRandomValues(iv);
                const encryptedAccount = { address: account.address, seedModifierHex: '', iv: this.converter.bytesToHex(iv) };
                const seedModifierEncrypted = await crypto.subtle.encrypt(
                    { name: "AES-GCM", iv },
                    key,
                    Buffer.from(this.converter.hexToBytes(account.seedModifierHex))
                );
                encryptedAccount.seedModifierHex = this.converter.bytesToHex(new Uint8Array(seedModifierEncrypted));
                encryptedAccounts[prefix].push(encryptedAccount);
            }

        return encryptedAccounts;
    }
    async #decryptAccountsGenerated(encryptedAccounts) {
        const decryptedAccounts = { W: [], C: [], P: [], U: [] };
        const masterHexUint8 = this.converter.hexToBytes(this.#masterHex);
        const key = await crypto.subtle.importKey(
            "raw",
            Buffer.from(masterHexUint8),
            { name: "AES-GCM" },
            false, // extractable
            ["encrypt", "decrypt"]
        );
        for (const prefix in encryptedAccounts)
            for (const account of encryptedAccounts[prefix]) {
				const iv = this.converter.hexToBytes(account.iv);
                const decryptedAccount = { address: account.address, seedModifierHex: '' };
                const seedModifierDecrypted = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv },
                    key,
                    Buffer.from(this.converter.hexToBytes(account.seedModifierHex))
                );
                decryptedAccount.seedModifierHex = this.converter.bytesToHex(new Uint8Array(seedModifierDecrypted));
                decryptedAccounts[prefix].push(decryptedAccount);
            }

        return decryptedAccounts;
    }
}