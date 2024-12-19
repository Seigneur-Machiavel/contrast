import { HashFunctions, AsymetricFunctions } from './conCrypto.mjs';
import utils from './utils.mjs';
import { AccountDerivationWorker } from '../workers/workers-classes.mjs';

/**
* @typedef {import("../src/transaction.mjs").Transaction} Transaction
* @typedef {import("../src/transaction.mjs").UTXO} UTXO
*/

async function localStorage_v1Lib() {
    if (utils.isNode) {
        const l = await import("../storage/local-storage-management.mjs");
        return l.default;
    }
    return null;
};
const localStorage_v1 = await localStorage_v1Lib();

export class AddressTypeInfo {
    name = '';
    description = '';
    zeroBits = 0;
    nbOfSigners = 1;
}
export class Account {
    /** @type {string} */
    #privKey = '';
    /** @type {string} */
    #pubKey = '';

    constructor(pubKey = '', privKey = '', address = '') {
        this.#pubKey = pubKey;
        this.#privKey = privKey;

        /** @type {string} */
        this.address = address;
        /** @type {UTXO[]} */
        this.UTXOs = [];
        /** @type {number} */
        this.balance = 0;
        /** @type {number} */
        this.spendableBalance = 0;
        /** @type {Object.<string, UTXO>} */
        this.spentUTXOByAnchors = {};
    }

    /** @param {Transaction} transaction */
    async signTransaction(transaction) {
        if (typeof this.#privKey !== 'string') { throw new Error('Invalid private key'); }

        const { signatureHex } = await AsymetricFunctions.signMessage(transaction.id, this.#privKey, this.#pubKey);
        if (!Array.isArray(transaction.witnesses)) {
            throw new Error('Invalid witnesses');
        }
        if (transaction.witnesses.includes(`${signatureHex}:${this.#pubKey}`)) { throw new Error('Signature already included'); }

        transaction.witnesses.push(`${signatureHex}:${this.#pubKey}`);

        return transaction;
    }
    /** @param {number} balance @param {UTXO[]} UTXOs */
    setBalanceAndUTXOs(balance, UTXOs, spendableBalance = 0) {
        if (typeof balance !== 'number') { throw new Error('Invalid balance'); }
        if (!Array.isArray(UTXOs)) { throw new Error('Invalid UTXOs'); }

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
class generatedAccount {
    address = '';
    seedModifierHex = '';
}
export class Wallet {
    constructor(masterHex, useDevArgon2 = false) {
        /** @type {string} */
        this.masterHex = masterHex; // 30 bytes - 60 chars
        /** @type {Object<string, Account[]>} */
        this.accounts = { // max accounts per type = 65 536
            W: [],
            C: [],
            S: [],
            P: [],
            U: []
        };
        /** @type {Object<string, generatedAccount[]>} */
        this.accountsGenerated = {
            W: [],
            C: [],
            S: [],
            P: [],
            U: []
        };
        this.useDevArgon2 = useDevArgon2;
        /** @type {AccountDerivationWorker[]} */
        this.workers = [];
        this.nbOfWorkers = 4;
    }
    async restore(mnemonicHex = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") {
        const argon2HashResult = await HashFunctions.Argon2(mnemonicHex, "Contrast's Salt Isnt Pepper But It Is Tasty", 27, 1024, 1, 2, 26);
        return argon2HashResult;
    }
    saveAccounts() {
        const id = this.masterHex.slice(0, 6);
        const folder = this.useDevArgon2 ? `accounts(dev)/${id}_accounts` : `accounts/${id}_accounts`;
        localStorage_v1.saveJSON(folder, this.accountsGenerated);
    }
    loadAccounts() {
        const id = this.masterHex.slice(0, 6);
        const folder = this.useDevArgon2 ? `accounts(dev)/${id}_accounts` : `accounts/${id}_accounts`;
        const accountsGenerated = localStorage_v1.loadJSON(folder);
        if (!accountsGenerated) { return false; }

        this.accountsGenerated = accountsGenerated;
        return true;
    }
    async deriveAccounts(nbOfAccounts = 1, addressPrefix = "C") {
        //this.accounts[addressPrefix] = [];  // no reseting accounts anymore
        const startTime = performance.now();
        //const nbOfExistingAccounts = this.accounts[addressPrefix].length;
        const nbOfExistingAccounts = this.accountsGenerated[addressPrefix].length;
        const accountToGenerate = nbOfAccounts - nbOfExistingAccounts < 0 ? 0 : nbOfAccounts - nbOfExistingAccounts;
        console.log(`[WALLET] deriving ${accountToGenerate} accounts with prefix: ${addressPrefix}`);
        const progressLogger = new utils.ProgressLogger(accountToGenerate, '[WALLET] deriving accounts');
        let iterationsPerAccount = 0;

        const accountToLoad = Math.min(nbOfExistingAccounts, nbOfAccounts);
        for (let i = 0; i < accountToLoad; i++) {
            if (this.accounts[addressPrefix][i]) { continue; } // already derived account
            if (this.accountsGenerated[addressPrefix][i]) { // from saved account
                const { address, seedModifierHex } = this.accountsGenerated[addressPrefix][i];
                const keyPair = await this.#deriveKeyPair(seedModifierHex);
                const account = new Account(keyPair.pubKeyHex, keyPair.privKeyHex, address);

                this.accounts[addressPrefix].push(account);
                continue;
            }
        }

        for (let i = nbOfExistingAccounts; i < nbOfAccounts; i++) {
            if (this.accounts[addressPrefix][i]) { continue; } // already derived account (should not append here)
            let derivationResult;
            if (this.nbOfWorkers === 0) {
                derivationResult = await this.tryDerivationUntilValidAccount(i, addressPrefix);
            } else {
                for (let i = this.workers.length; i < this.nbOfWorkers; i++) {
                    this.workers.push(new AccountDerivationWorker(i));
                }
                await new Promise(r => setTimeout(r, 10)); // avoid spamming the CPU/workers
                derivationResult = await this.tryDerivationUntilValidAccountUsingWorkers(i, addressPrefix);
            }

            if (!derivationResult) {
                const derivedAccounts = this.accounts[addressPrefix].slice(nbOfExistingAccounts).length;
                console.error(`Failed to derive account (derived: ${derivedAccounts})`);
                return {};
            }

            const account = derivationResult.account;
            const iterations = derivationResult.iterations;
            if (!account) { console.error('deriveAccounts interrupted!'); return {}; }

            iterationsPerAccount += iterations;
            this.accounts[addressPrefix].push(account);
            progressLogger.logProgress(this.accounts[addressPrefix].length - nbOfExistingAccounts);
        }

        if (this.accounts[addressPrefix].length !== nbOfAccounts) {
            console.error(`Failed to derive all accounts: ${this.accounts[addressPrefix].length}/${nbOfAccounts}`);
            return {};
        }
        
        const endTime = performance.now();
        const derivedAccounts = this.accounts[addressPrefix].slice(nbOfExistingAccounts);
        const avgIterations = derivedAccounts.length > 0 ? Math.round(iterationsPerAccount / derivedAccounts.length) : 0;
        console.info(`[WALLET] ${derivedAccounts.length} accounts derived with prefix: ${addressPrefix}
avgIterations: ${avgIterations} | time: ${(endTime - startTime).toFixed(3)}ms`);
        return { derivedAccounts: this.accounts[addressPrefix], avgIterations: avgIterations };
    }
    async tryDerivationUntilValidAccountUsingWorkers(accountIndex = 0, desiredPrefix = "C") {
        /** @type {AddressTypeInfo} */
        const addressTypeInfo = utils.addressUtils.glossary[desiredPrefix];
        if (addressTypeInfo === undefined) { throw new Error(`Invalid desiredPrefix: ${desiredPrefix}`); }

        // To be sure we have enough iterations, but avoid infinite loop
        const maxIterations = 65_536 * (2 ** addressTypeInfo.zeroBits); // max with zeroBits(16): 65 536 * (2^16) => 4 294 967 296
        const seedModifierStart = accountIndex * maxIterations; // max with accountIndex: 65 535 * 4 294 967 296 => 281 470 681 743 360 
        const workerMaxIterations = Math.floor(maxIterations / this.nbOfWorkers);
        // split the job between workers
        const promises = {};
        for (let i = 0; i < this.nbOfWorkers; i++) {
            const worker = this.workers[i];
            const workerSeedModifierStart = seedModifierStart + (i * workerMaxIterations);
            promises[i] = worker.derivationUntilValidAccount(
                workerSeedModifierStart,
                workerMaxIterations,
                this.masterHex,
                desiredPrefix
            );
        }

        const firstResult = await Promise.race(Object.values(promises));
        this.accountsGenerated[desiredPrefix].push({
            address: firstResult.addressBase58,
            seedModifierHex: firstResult.seedModifierHex
        });
        const account = new Account(
            firstResult.pubKeyHex,
            firstResult.privKeyHex,
            firstResult.addressBase58
        );

        // abort the running workers
        for (const worker of this.workers) { worker.abortOperation(); }
        //await Promise.all(Object.values(promises));
        for (const promise of Object.values(promises)) { await promise; }
        
        let iterations = 0;
        for (const promise of Object.values(promises)) {
            const result = await promise;
            iterations += result.iterations || 0;
        }

        return { account, iterations };
    }
    async tryDerivationUntilValidAccount(accountIndex = 0, desiredPrefix = "C") { // SINGLE THREAD
        /** @type {AddressTypeInfo} */
        const addressTypeInfo = utils.addressUtils.glossary[desiredPrefix];
        if (addressTypeInfo === undefined) { throw new Error(`Invalid desiredPrefix: ${desiredPrefix}`); }

        // To be sure we have enough iterations, but avoid infinite loop
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
            } catch (error) {
                const errorSkippingLog = ['Address does not meet the security level'];
                if (!errorSkippingLog.includes(error.message.slice(0, 40))) { console.error(error.stack); }
            }
        }

        return false;
    }
    async #deriveKeyPair(seedModifierHex) {
        const seedHex = await HashFunctions.SHA256(this.masterHex + seedModifierHex);

        const keyPair = await AsymetricFunctions.generateKeyPairFromHash(seedHex);
        if (!keyPair) { throw new Error('Failed to generate key pair'); }

        return keyPair;
    }
    async #deriveAccount(pubKeyHex, desiredPrefix = "C") {
        const argon2Fnc = this.useDevArgon2 ? HashFunctions.devArgon2 : HashFunctions.Argon2;
        const addressBase58 = await utils.addressUtils.deriveAddress(argon2Fnc, pubKeyHex);
        if (!addressBase58) { throw new Error('Failed to derive address'); }

        if (addressBase58.substring(0, 1) !== desiredPrefix) { return false; }

        utils.addressUtils.conformityCheck(addressBase58);
        await utils.addressUtils.securityCheck(addressBase58, pubKeyHex);

        return addressBase58;
    }
}