const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

//#region Libs imports and type definitions
import ed25519 from '../externalLibs/noble-ed25519-03-2024.mjs';
import { Transaction, UTXO } from './transaction.mjs';
import { xxHash32 } from '../externalLibs/xxhash32.mjs';
async function msgPackLib() {
    if (isNode) {
        const m = await import('../externalLibs/msgpack.min.js');
        return m.default;
    }
    return MessagePack;
};
const msgpack = await msgPackLib();
//import { BinarySerializer } from '../externalLibs/gpt-serializer.mjs';
//const msgpack = new BinarySerializer();

const cryptoLib = crypto;
async function getArgon2Lib() {
    if (isNode) {
        const a = await import('argon2');
        a.limits.timeCost.min = 1; // ByPass the minimum time cost
        return a;
    }

    try {
        if (argon2) { 
            console.log('Argon2 loaded as a global variable');
            return argon2; 
        }
    } catch (error) { }

    console.log('trying import argon2 ES6 and inject in window');
    const argon2Import = await import('../externalLibs/argon2-ES6.min.mjs');
    window.argon2 = argon2Import.default;
    return argon2Import.default;
};
const argon2Lib = await getArgon2Lib();

/**
* @typedef {import("./block-classes.mjs").Block} Block
* @typedef {import("./block-classes.mjs").BlockData} BlockData
* @typedef {import("./transaction.mjs").Transaction} Transaction
* @typedef {import("./transaction.mjs").UTXO} UTXO
* @typedef {import("./conCrypto.mjs").argon2Hash} HashFunctions
*/
//#endregion

/*async function getWorkerModule() {
    if (isNode) {
        return (await import('worker_threads')).Worker;
    }
    return Worker;
};
const WokerModule = await getWorkerModule();*/
const WorkerModule = isNode ? (await import('worker_threads')).Worker : Worker;

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function newWorker(scriptPath, workerCode) {
    if (isNode) {
        return new WorkerModule(new URL(scriptPath, import.meta.url));
    } else {
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        return new Worker(URL.createObjectURL(blob));
    }
}

const SETTINGS = { // The Fibonacci based distribution
    // BLOCK
    targetBlockTime: 120_000, // 120_000, // 2 min
    maxBlockSize: 200_000, // ~200KB
    maxTransactionSize: 200_000, // ~200KB
    // DISTRIBUTION
    rewardMagicNb1: 102_334_155, // Fibonacci n+2
    rewardMagicNb2: 63_245_986, // Fibonacci n+1
    blockReward: 102_334_155 - 63_245_986, // Fibonacci n = 39_088_169
    minBlockReward: 1,
    halvingInterval: 262_980, // 1 year at 2 min per block
    maxSupply: 27_000_000_000_000, // last 6 zeros are considered as decimals ( can be stored as 8 bytes )

    // TRANSACTION
    minTransactionFeePerByte: 1,
    unspendableUtxoAmount: 200
};
const UTXO_RULES_GLOSSARY = {
    sig: { code: 0, description: 'Simple signature verification' },
    sigOrSlash: { code: 1, description: "Open right to slash the UTXO if validator's fraud proof is provided", withdrawLockBlocks: 144 },
    lockUntilBlock: { code: 2, description: 'UTXO locked until block height', lockUntilBlock: 0 },
    multiSigCreate: { code: 3, description: 'Multi-signature creation' },
    p2pExchange: { code: 4, description: 'Peer-to-peer exchange' },
    lightHousePause: { code: 6, description: 'LightHouse pause' },
    lightHouseResume: { code: 7, description: 'LightHouse resume' },
};
const UTXO_RULESNAME_FROM_CODE = {
    0: 'sig',
    1: 'sigOrSlash',
    2: 'lockUntilBlock',
    3: 'multiSigCreate',
    4: 'p2pExchange'
};
const MINING_PARAMS = {
    // a difficulty incremented by 16 means 1 more zero in the hash - then 50% more difficult to find a valid hash
    // a difference of 1 difficulty means 3.125% harder to find a valid hash
    argon2: {
        time: 1,
        mem: 2 ** 20,
        parallelism: 1,
        type: 2,
        hashLen: 32,
    },
    nonceLength: 4,
    blocksBeforeAdjustment: 30, // ~120sec * 30 = ~3600 sec = ~1 hour
    thresholdPerDiffIncrement: 3.2, // meaning 3.4% threshold for 1 diff point
    maxDiffIncrementPerAdjustment: 32, // 32 diff points = 100% of diff
    diffAdjustPerLegitimacy: 16, // 16 diff points = 50% of diff
    maxTimeDifferenceAdjustment: 128, // in difficutly points, affect max penalty, but max bonus is infinite
};

class ProgressLogger {
    constructor(total, msgPrefix = '[LOADING] digestChain') {
        this.total = total;
        this.msgPrefix = msgPrefix;
        this.stepSizePercent = 10;
        this.lastLoggedStep = 0;
        this.startTime = Date.now();
        this.stepTime = Date.now();
    }

    logProgress(current) {
        const progress = current === this.total - 1 ? 100 : (current / this.total) * 100;
        const currentStep = Math.floor(progress / this.stepSizePercent);
        if (currentStep <= this.lastLoggedStep) { return; }

        const timeDiff = Date.now() - this.stepTime;
        this.lastLoggedStep = currentStep;
        this.stepTime = Date.now();
        console.log(`${this.msgPrefix} : ${progress.toFixed(1)}% (${current}/${this.total}) - step: ${timeDiff}ms`);

        if (current === this.total - 1) {
            const totalTime = Date.now() - this.startTime;
            const avgTime = totalTime / this.total;
            console.log(`[TASK COMPLETED] - Total time: ${totalTime}ms - Average time per step: ${avgTime.toFixed(2)}ms`);
        }
    }
};
class AddressTypeInfo {
    name = '';
    description = '';
    zeroBits = 0;
    nbOfSigners = 1;
};
export const addressUtils = {
    params: {
        argon2DerivationMemory: 2 ** 16, // 2**16 should be great
        addressDerivationBytes: 16, // the hex return will be double this value
        addressBase58Length: 20,
    },
    glossary: {
        W: { name: 'Weak', description: 'No condition', zeroBits: 0 },
        C: { name: 'Contrast', description: '16 times harder to generate', zeroBits: 4 },
        S: { name: 'Secure', description: '256 times harder to generate', zeroBits: 8 },
        P: { name: 'Powerful', description: '4096 times harder to generate', zeroBits: 12 },
        U: { name: 'Ultimate', description: '65536 times harder to generate', zeroBits: 16 },
        M: { name: 'MultiSig', description: 'Multi-signature address', zeroBits: 0 }
    },

    /**
     * This function uses an Argon2 hash function to perform a hashing operation.
     * @param {HashFunctions} argon2HashFunction
     * @param {string} pubKeyHex
     */
    deriveAddress: async (argon2HashFunction, pubKeyHex) => {
        const hex128 = pubKeyHex.substring(32, 64);
        const salt = pubKeyHex.substring(0, 32); // use first part as salt because entropy is lower

        const argon2hash = await argon2HashFunction(hex128, salt, 1, addressUtils.params.argon2DerivationMemory, 1, 2, addressUtils.params.addressDerivationBytes);
        if (!argon2hash) { console.error('Failed to hash the SHA-512 pubKeyHex'); return false; }

        const hex = argon2hash.hex;
        const addressBase58 = convert.hex.toBase58(hex).substring(0, 20);

        return addressBase58;
    },
    /** ==> First verification, low computation cost.
     *
     * - Control the length of the address and its first char
     * @param {string} addressBase58 - Address to validate
     */
    conformityCheck: (addressBase58) => {
        if (typeof addressBase58 !== 'string') { throw new Error('Invalid address type !== string'); }
        if (addressBase58.length !== 20) { 
            throw new Error('Invalid address length !== 20'); }

        const firstChar = addressBase58.substring(0, 1);
        /** @type {AddressTypeInfo} */
        const addressTypeInfo = addressUtils.glossary[firstChar];
        if (addressTypeInfo === undefined) { throw new Error(`Invalid address firstChar: ${firstChar}`); }

        return 'Address conforms to the standard';
    },
    /** ==> Second verification, low computation cost.
     *
     * ( ALWAYS use conformity check first )
     * - (address + pubKeyHex) are concatenated and hashed with SHA-256 -> condition: start with zeros
     * @param {string} addressBase58 - Address to validate
     * @param {string} pubKeyHex - Public key to derive the address from
     */
    securityCheck: async (addressBase58, pubKeyHex = '') => {
        if (pubKeyHex.length !== 64) { throw new Error('Invalid public key length !== 64'); }

        //const timeStart = performance.now();
        const firstChar = addressBase58.substring(0, 1);
        /** @type {AddressTypeInfo} */
        const addressTypeInfo = addressUtils.glossary[firstChar];
        if (addressTypeInfo === undefined) { throw new Error(`Invalid address firstChar: ${firstChar}`); }

        /*const addressBase58Hex = convert.base58.toHex(addressBase58);
        const concatUint8 = convert.hex.toUint8Array(`${addressBase58Hex}${pubKeyHex}`);
        const arrayBuffer = await cryptoLib.subtle.digest('SHA-256', concatUint8);
        const uint8Array = new Uint8Array(arrayBuffer);
        const mixedAddPubKeyHashHex = convert.uint8Array.toHex(uint8Array);*/

        // FASTER METHOD
        const addressBase58Uint8 = fastConverter.addressBase58ToUint8Array(addressBase58); // 16 bytes
        const addressBase58Hex = fastConverter.uint8ArrayToHex(addressBase58Uint8);
        let mixedAddPubKeyHashHex = '';
        for (let i = 0; i < 8; i++) {
            let mixedPart = '';
            mixedPart += pubKeyHex.slice(i * 8, i * 8 + 4);
            mixedPart += addressBase58Hex.slice(i * 4, i * 4 + 4);
            mixedPart += pubKeyHex.slice(i * 8 + 4, i * 8 + 8);
            
            const hashNumber = xxHash32(mixedPart)
            mixedAddPubKeyHashHex += hashNumber.toString(16).padStart(8, '0');
        }

        if (mixedAddPubKeyHashHex.length !== 64) { throw new Error('Failed to hash the address and the public key'); }
        
        const bitsArray = convert.hex.toBits(mixedAddPubKeyHashHex);
        if (!bitsArray) { throw new Error('Failed to convert the public key to bits'); }

        const condition = conditionnals.binaryStringStartsWithZeros(bitsArray.join(''), addressTypeInfo.zeroBits);
        if (!condition) { throw new Error(`Address does not meet the security level ${addressTypeInfo.zeroBits} requirements`); }

        //const timeEnd = performance.now();
        //console.log(`Security check time: ${(timeEnd - timeStart).toFixed(3)}ms`);
        return 'Address meets the security level requirements';
    },
    /** ==> Third verification, higher computation cost.
     *
     * ( ALWAYS use conformity check first )
     *
     * - This function uses an Argon2 hash function to perform a hashing operation.
     * @param {HashFunctions} argon2HashFunction
     * @param {string} addressBase58 - Address to validate
     * @param {string} pubKeyHex - Public key to derive the address from
     */
    derivationCheck: async (argon2HashFunction, addressBase58, pubKeyHex = '') => {
        const derivedAddressBase58 = await addressUtils.deriveAddress(argon2HashFunction, pubKeyHex);
        if (!derivedAddressBase58) { console.error('Failed to derive the address'); return false; }

        return addressBase58 === derivedAddressBase58;
    },

    formatAddress: (addressBase58, separator = ('.')) => {
        if (typeof addressBase58 !== 'string') { return false; }
        if (typeof separator !== 'string') { return false; }

        // WWRMJagpT6ZK95Mc2cqh => WWRM-Jagp-T6ZK-95Mc-2cqh or WWRM.Jagp.T6ZK.95Mc.2cqh
        const formated = addressBase58.match(/.{1,4}/g).join(separator);
        return formated;
    },
};
const utxoUtils = {
    /** @param {UTXO[]} UTXOs */
    extractBalances: (UTXOs) => {
        let totalBalance = 0;
        let spendableBalance = 0;
        let stakedBalance = 0;
        let lockedBalance = 0;
        let p2pExchangeBalance = 0;

        for (let i = 0; i < UTXOs.length; i++) {
            const rule = UTXOs[i].rule;
            const amount = UTXOs[i].amount;

            totalBalance += amount;
            switch (rule) {
                case 'sigOrSlash':
                    stakedBalance += amount;
                    break;
                case 'lockUntilBlock':
                    lockedBalance += amount;
                    break;
                case 'p2pExchange':
                    p2pExchangeBalance += amount;
                    break;
                default:
                    spendableBalance += amount;
                    break;
            }
        }

        return { totalBalance, stakedBalance, spendableBalance, lockedBalance, p2pExchangeBalance };
    },
    /** @param {UTXO[]} UTXOs */
    extractUTXOsByRules: (UTXOs) => {
        /** @type {Object<string, UTXO[]>} */
        const utxosByRule = {};
        for (let i = 0; i < UTXOs.length; i++) {
            const rule = UTXOs[i].rule;
            if (!utxosByRule[rule]) { utxosByRule[rule] = []; }
            utxosByRule[rule].push(UTXOs[i]);
        }
        return utxosByRule;
    },
};
const typeValidation = {
    /**
     * @param {string} base58 - Base58 string to validate
     * @returns {string|false}
     */
    base58(base58) {
        for (let i = 0; i < base58.length; i++) {
            const char = base58[i];
            if (base58Alphabet.indexOf(char) === -1) {
                return false;
            }
        }
        return base58;
    },
    /**
     * @param {string} hex - Hex string to validate
     * @returns {string|false}
     */
    hex(hex) {
        if (!hex) { return false; }
        if (!typeof hex === 'string') { return false; }
        if (hex.length === 0) { return false; }
        if (hex.length % 2 !== 0) {
            return false;
        }

        for (let i = 0; i < hex.length; i++) {
            const char = hex[i];
            if (isNaN(parseInt(char, 16))) {
                return false;
            }
        }

        return hex;
    },
    /**
     * @param {string} base64 - Base64 string to validate
     * @returns {string|false}
     */
    uint8Array(uint8Array) {
        if (uint8Array instanceof Uint8Array === false) {
            return false;
        }

        return uint8Array;
    },
    /** @param {number} number - Number to validate */
    numberIsPositiveInteger(number) {
        return typeof number === 'number' && !isNaN(number) && number > 0 && number % 1 === 0;
    }
};
const conditionnals = {
    /**
     * Check if the string starts with a certain amount of zeros
     * @param {string} string
     * @param {number} zeros
     */
    binaryStringStartsWithZeros: (string, zeros) => {
        if (typeof string !== 'string') { return false; }
        if (typeof zeros !== 'number') { return false; }
        if (zeros < 0) { return false; }

        const target = '0'.repeat(zeros);
        return string.startsWith(target);
    },

    /**
     * Check if the string as binary is superior or equal to the target
     * @param {string} string
     * @param {number} minValue
     */
    binaryStringSupOrEqual: (string = '', minValue = 0) => {
        if (typeof string !== 'string') { return false; }
        if (typeof minValue !== 'number') { return false; }
        if (minValue < 0) { return false; }

        const intValue = parseInt(string, 2);
        return intValue >= minValue;
    },
    /**
     * Check if the array contains duplicates
     * @param {Array} array
     */
    arrayIncludeDuplicates(array) {
        return (new Set(array)).size !== array.length;
    }
};
const types = {
    anchor: {
        /** @param {string} anchor - "height:TxID:vout" - ex: "8:7c5aec61:0" */
        isConform(anchor) {
            if (typeof anchor !== 'string') { return false; }
    
            const splitted = anchor.split(':');
            if (splitted.length !== 3) { return false; }
    
            // height
            const height = parseInt(splitted[0], 10);
            if (isNaN(height) || typeof height !== 'number') { return false; }
            if (height < 0 || height % 1 !== 0) { return false; }
    
            // TxID
            if (typeof splitted[1] !== 'string') { return false; }
            if (splitted[1].length !== 8) { return false; }
            if (typeValidation.hex(splitted[1]) === false) { return false; }
    
            // vout
            const vout = parseInt(splitted[2], 10);
            if (isNaN(vout) || typeof vout !== 'number') { return false; }
            if (vout < 0 || vout % 1 !== 0) { return false; }
    
            return true;
        }
    },
    txReference: {
        /** @param {string} txReference - "height:TxID" - ex: "8:7c5aec61" */
        isConform(txReference) {
            if (typeof txReference !== 'string') { return false; }
    
            const splitted = txReference.split(':');
            if (splitted.length !== 2) { return false; }
    
            // height
            const height = parseInt(splitted[0], 10);
            if (isNaN(height) || typeof height !== 'number') { return false; }
            if (height < 0 || height % 1 !== 0) { return false; }
    
            // TxID
            if (typeof splitted[1] !== 'string') { return false; }
            if (splitted[1].length !== 8) { return false; }
            if (typeValidation.hex(splitted[1]) === false) { return false; }
    
            return true;
        }
    }
};
const convert = {
    base58: {
        /** @param {string} base58 - Base58 string to convert to base64 */
        toBase64: (base58) => {
            const uint8Array = convert.base58.toUint8Array(base58);
            return convert.uint8Array.toBase64(uint8Array);
        },
        /** @param {string} base58 - Base58 string to convert to BigInt */
        toBigInt: (base58) => {
            let num = BigInt(0);
            const base = BigInt(58);

            for (let i = 0; i < base58.length; i++) {
                const char = base58[i];
                const index = base58Alphabet.indexOf(char);
                if (index === -1) {
                    throw new Error(`Invalid character: ${char}`);
                }

                num = num * base + BigInt(index);
            }

            return num;
        },
        /** @param {string} base58 - Base58 string to convert to hex */
        toHex: (base58) => {
            const num = convert.base58.toBigInt(base58);
            return convert.bigInt.toHex(num);
        },
        /** @param {string} base58 - Base58 string to convert to Uint8Array */
        toUint8Array: (base58) => {
            if (typeValidation.base58(base58) === false) { return false; }

            const hex = convert.base58.toHex(base58);
            return convert.hex.toUint8Array(hex);
        },
        /** @param {string} base58 - Base58 string to convert to hex */
        toHex: (base58) => {
            let num = BigInt(0);
            const base = BigInt(58);

            for (let i = 0; i < base58.length; i++) {
                const char = base58[i];
                const index = base58Alphabet.indexOf(char);
                if (index === -1) {
                    throw new Error(`Invalid character: ${char}`);
                }

                num = num * base + BigInt(index);
            }

            return convert.bigInt.toHex(num);
        }
    },
    base64: {
        /** @param {string} base64 - Base64 string to convert to base58 */
        toBase58: (base64) => {
            const uint8Array = convert.base64.toUint8Array(base64);
            return convert.uint8Array.toBase58(uint8Array);
        },
        /** @param {string} base64 - Base64 string to convert to BigInt */
        toBigInt: (base64) => {
            const uint8Array = convert.base64.toUint8Array(base64);
            return convert.uint8Array.toBigInt(uint8Array);
        },
        /** @param {string} base64 - Base64 string to convert to hex */
        toHex: (base64) => {
            const uint8Array = convert.base64.toUint8Array(base64);
            return convert.uint8Array.toHex(uint8Array);
        },
        /** @param {string} base64 - Base64 string to convert to Uint8Array */
        toUint8Array: (base64) => {
            if (isNode) {
                /** @type {Uint8Array} */
                const bytes = Buffer.from(base64, 'base64');
                return bytes;
            }

            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        },
        /** @param {string} base64 - Base64 string to convert to BigInt */
        toBits: (base64) => {
            const uint8Array = convert.base64.toUint8Array(base64);
            return convert.uint8Array.toBits(uint8Array);
        }
    },
    bigInt: {
        /** @param {BigInt} num - BigInt to convert to base58 */
        toBase58: (num) => {
            let base58 = '';
            let n = num;
            while (n > 0) {
                const remainder = n % BigInt(base58Alphabet.length);
                base58 = base58Alphabet.charAt(Number(remainder)) + base58;
                n = n / BigInt(base58Alphabet.length);
            }

            const bytes = isNode ? Buffer.from(base58) : new TextEncoder().encode(base58);

            for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
                base58 = '1' + base58;
            }

            return base58;
        },
        /** @param {BigInt} num - BigInt to convert to base64 */
        toBase64: (num) => {
            const hex = convert.bigInt.toHex(num);
            return convert.hex.toBase64(hex);
        },
        /** @param {BigInt} num - BigInt to convert to Uint8Array */
        toUint8Array: (num) => {
            const hex = convert.bigInt.toHex(num);
            return convert.hex.toUint8Array(hex);
        },
        /** @param {BigInt} num - BigInt to convert to hex */
        toHex: (num) => {
            let hex = num.toString(16);
            if (hex.length % 2 !== 0) {
                hex = '0' + hex;
            }
            return hex;
        },
        /** @param {BigInt} num - BigInt to convert to bits */
        toBits: (num) => {
            const hex = convert.bigInt.toHex(num);
            return convert.hex.toBits(hex);
        },
        /** @param {BigInt} num - BigInt to convert to number */
        toNumber: (num) => {
            return Number(num);
        }
    },
    number: {
        /** @param {number} num - Integer to convert to base58 */
        toBase58: (num) => {
            return convert.bigInt.toBase58(BigInt(num));
        },
        /** @param {number} num - Integer to convert to base64 */
        toBase64: (num) => {
            return convert.bigInt.toBase64(BigInt(num));
        },
        /** @param {number} num - Integer to convert to BigInt */
        toBigInt: (num) => {
            return BigInt(num);
        },
        /** @param {number} num - Integer to convert to Uint8Array */
        toUint8Array: (num) => {
            const hex = convert.number.toHex(num);
            return convert.hex.toUint8Array(hex);
        },
        /** @param {number} num - Integer to convert to Hex */
        toHex: (num) => {
            let hex = num.toString(16);
            if (hex.length % 2 !== 0) {
                hex = '0' + hex;
            }
            return hex;
        },
        /** @param {number} num - Integer to convert to readable */
        formatNumberAsCurrency: (num) => {
            // 1_000_000_000 -> 1,000.000000
            if (num < 1_000_000) { return `0.${num.toString().padStart(6, '0')}`; }
            const num2last6 = num.toString().slice(-6);
            const numRest = num.toString().slice(0, -6);
            const separedNum = numRest.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
            return `${separedNum}.${num2last6}`;
        },
        formatNumberAsCurrencyChange: (num) => {
            const prefix = num < 0 ? '-' : '+';
            if (prefix === '-') { num = Math.abs(num); }

            if (num < 1_000_000) { return `${prefix}0.${num.toString().padStart(6, '0')}`; }
            const num2last6 = num.toString().slice(-6);
            const numRest = num.toString().slice(0, -6);
            const separedNum = numRest.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
            return `${prefix}${separedNum}.${num2last6}`;
        },
        /** Number should be between 0 and 255
         * 
         * @param {number} num - Integer to convert to 1 byte Uint8Array
         */
        to1ByteUint8Array: (num) => {
            if (num < 0 || num > 255) { throw new Error('Number out of range'); }
            return new Uint8Array([num]);
        },
        /** Number should be between 0 and 65535
         * 
         * @param {number} num - Integer to convert to 2 bytes Uint8Array
         */
        to2BytesUint8Array: (num) => {
            if (num < 0 || num > 65535) { throw new Error('Number out of range'); }
            let buffer = new ArrayBuffer(2);
            let view = new DataView(buffer);
            view.setUint16(0, num, true); // true for little-endian
            return new Uint8Array(buffer);
        },
        /** Number should be between 0 and 4294967295
         * 
         * @param {number} num - Integer to convert to 4 bytes Uint8Array
         */
        to4BytesUint8Array: (num) => {
            if (num < 0 || num > 4294967295) { throw new Error('Number out of range'); }
            let buffer = new ArrayBuffer(4);
            let view = new DataView(buffer);
            view.setUint32(0, num, true); // true for little-endian
            return new Uint8Array(buffer);
        },
        /** Number should be between 0 and 2^48 - 1 (281474976710655).
         * 
         * @param {number} num - Integer to convert.
         */
        to6BytesUint8Array(num) {
            if (num < 0 || num > 281474976710655) {
                throw new Error('Number out of range. Must be between 0 and 281474976710655.');
            }

            const buffer = new ArrayBuffer(6);
            const view = new DataView(buffer);
            
            // JavaScript bitwise operations treat numbers as 32-bit integers.
            // We need to manually handle the 48-bit number by dividing it into parts.
            for (let i = 0; i < 6; ++i) {
                const byte = num & 0xff;
                view.setUint8(i, byte);
                num = (num - byte) / 256; // Shift right by 8 bits
            }

            return new Uint8Array(buffer);
        },
        /** Number should be between 0 and 281474976710655
         * 
         * @param {number} num - Integer to convert to the smallest Uint8Array possible
         */
        toUint8Array: (num) => {
            if (num > 281474976710655) { throw new Error('Number out of range: > 281474976710655'); }

            if (num > 4294967295) { return convert.number.to6BytesUint8Array(num); }
            if (num > 65535) { return convert.number.to4BytesUint8Array(num); }
            if (num > 255) { return convert.number.to2BytesUint8Array(num); }
            if (num >= 0) { return convert.number.to1ByteUint8Array(num); }
            
            throw new Error('Number out of range: < 0');
        }
    },
    uint8Array: {
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to base58 */
        toBase58: (uint8Array) => {
            const hex = convert.uint8Array.toHex(uint8Array);
            return convert.hex.toBase58(hex);
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to base64 */
        toBase64: (uint8Array) => {
            if (isNode) {
                return uint8Array.toString('base64');
            }

            const binaryString = String.fromCharCode.apply(null, uint8Array);
            return btoa(binaryString);
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to BigInt */
        toBigInt: (uint8Array) => {
            const hex = convert.uint8Array.toHex(uint8Array);
            return convert.hex.toBigInt(hex);
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to hex */
        toHex: (uint8Array) => {
            let hexStr = '';
            for (let i = 0; i < uint8Array.length; i++) {
                hexStr += uint8Array[i].toString(16).padStart(2, '0');
            }
            return hexStr;
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to bits */
        toBits: (uint8Array) => {
            const bitsArray = [];
            for (let i = 0; i < uint8Array.length; i++) {
                const bits = uint8Array[i].toString(2).padStart(8, '0');
                bitsArray.push(...bits.split('').map(bit => parseInt(bit, 10)));
            }

            return bitsArray;
        },
        /**
         * Converts a Uint8Array of 1, 2, 4, or 8 bytes to a number.
         * 
         * @param {Uint8Array} uint8Array
         */
        toNumber(uint8Array) {
            const dataView = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
            switch (uint8Array.byteLength) {
                case 1:
                    return dataView.getUint8(0);
                case 2:
                    return dataView.getUint16(0, true); // true for little-endian
                case 4:
                    return dataView.getUint32(0, true); // true for little-endian
                case 6:
                    // Combine the 6 bytes into one number
                    const lower = dataView.getUint32(0, true); // Read the lower 4 bytes
                    const upper = dataView.getUint16(4, true); // Read the upper 2 bytes
                    // Use bitwise OR to combine the two parts, shifting the upper part by 32 bits.
                    // Note: JavaScript bitwise operations automatically convert operands to 32-bit integers.
                    // We use multiplication and addition instead to avoid precision loss.
                    return upper * 0x100000000 + lower;
                default:
                    throw new Error("Unsupported Uint8Array length. Must be 1, 2, or 4 bytes.");
            }
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to string */
        toString(uint8Array) {
            return String.fromCharCode.apply(null, uint8Array);
        }
    },
    hex: {
        /** @param {string} hex - Hex string to convert to Uint8Array */
        toBase58: (hex) => {
            const num = convert.hex.toBigInt(hex);
            return convert.bigInt.toBase58(num);
        },
        /** @param {string} hex - Hex string to convert to base64 */
        toBase64: (hex) => {
            const uint8Array = convert.hex.toUint8Array(hex);
            return convert.uint8Array.toBase64(uint8Array);
        },
        /** @param {string} hex - Hex string to convert to BigInt */
        toBigInt: (hex) => {
            if (hex.length === 0) { console.error('Hex string is empty'); return false; }

            return BigInt('0x' + hex);
        },
        /** @param {string} hex - Hex string to convert to Uint8Array */
        toUint8Array: (hex) => {
            if (hex.length % 2 !== 0) { throw new Error("The length of the input is not a multiple of 2."); }

            const length = hex.length / 2;
            const uint8Array = new Uint8Array(length);

            for (let i = 0, j = 0; i < length; ++i, j += 2) { uint8Array[i] = parseInt(hex.substring(j, j + 2), 16); }

            return uint8Array;
        },
        /** @param {string} hex - Hex string to convert to bits */
        toBits: (hex = '') => {
            const expectedLength = hex.length / 2 * 8;
            if (hex.length % 2 !== 0) { console.info('The length of the input is not a multiple of 2.'); return false }

            let bitsArray = [];
            for (let i = 0; i < hex.length; i++) {
                const bits = parseInt(hex[i], 16).toString(2).padStart(4, '0');
                bitsArray = bitsArray.concat(bits.split(''));
            }

            const bitsArrayAsNumbers = bitsArray.map(bit => parseInt(bit, 10));
            if (bitsArrayAsNumbers.length !== expectedLength) {
                console.info('Expected length:', expectedLength, 'Actual length:', bitsArrayAsNumbers.length);
                console.info('Hex:', hex);
                console.info('Bits:', bitsArrayAsNumbers);
                return false;
            }

            return bitsArrayAsNumbers;
        },
    },
    string: {
        /** @param {string} str - String to convert to base58 */
        toBase58: (str) => {
            const uint8Array = new TextEncoder().encode(str);
            return convert.uint8Array.toBase58(uint8Array);
        },
        /** @param {string} str - String to convert to base64 */
        toBase64: (str) => {
            const uint8Array = new TextEncoder().encode(str);
            return convert.uint8Array.toBase64(uint8Array);
        },
        /** @param {string} str - String to convert to BigInt */
        toBigInt: (str) => {
            const uint8Array = new TextEncoder().encode(str);
            return convert.uint8Array.toBigInt(uint8Array);
        },
        /** @param {string} str - String to convert to Uint8Array */
        toUint8Array: (str) => {
            return new TextEncoder().encode(str);
        },
        /** @param {string} str - String to convert to hex */
        toHex: (str) => {
            const uint8Array = new TextEncoder().encode(str);
            return convert.uint8Array.toHex(uint8Array);
        },
    }
};
/**
 * This Class is used to convert data between different formats.
 * 
 * Faster than the convert object.
 * 
 * - functions do not check the input data. 
 * - Make sure to validate the data before using this class.
 */
class FastConverter {
    constructor() {
        this.buffer2 = new ArrayBuffer(2);
        this.view2 = new DataView(this.buffer2);
        this.buffer4 = new ArrayBuffer(4);
        this.view4 = new DataView(this.buffer4);
        this.buffer6 = new ArrayBuffer(6);
        this.view6 = new DataView(this.buffer6);
        this.buffer8 = new ArrayBuffer(8);
        this.view8 = new DataView(this.buffer8);
        this.hexMap = {
            '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
            '8': 8, '9': 9, 'A': 10, 'B': 11, 'C': 12, 'D': 13, 'E': 14, 'F': 15,
            'a': 10, 'b': 11, 'c': 12, 'd': 13, 'e': 14, 'f': 15
        };
        this.base58Alphabet = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8, 'A': 9, 'B': 10, 'C': 11, 'D': 12, 'E': 13, 'F': 14, 'G': 15, 'H': 16, 'J': 17, 'K': 18, 'L': 19, 'M': 20, 'N': 21, 'P': 22, 'Q': 23, 'R': 24, 'S': 25, 'T': 26, 'U': 27, 'V': 28, 'W': 29, 'X': 30, 'Y': 31, 'Z': 32, 'a': 33, 'b': 34, 'c': 35, 'd': 36, 'e': 37, 'f': 38, 'g': 39, 'h': 40, 'i': 41, 'j': 42, 'k': 43, 'm': 44, 'n': 45, 'o': 46, 'p': 47, 'q': 48, 'r': 49, 's': 50, 't': 51, 'u': 52, 'v': 53, 'w': 54, 'x': 55, 'y': 56, 'z': 57 };
        this.base58AlphabetRev = [ '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z' ];
        this.buffer12 = new ArrayBuffer(12);
    }

    /** Number should be between 0 and 255 @param {number} num - Integer to convert to 1 byte Uint8Array */
    numberTo1ByteUint8Array(num) {
        return new Uint8Array([num]);
    }
    /** Number should be between 0 and 65535 @param {number} num - Integer to convert to 2 bytes Uint8Array */
    numberTo2BytesUint8Array(num) {
        this.view2.setUint16(0, num, true); // true for little-endian
        return new Uint8Array(this.buffer2);
    }
    /** Number should be between 0 and 4294967295 @param {number} num - Integer to convert to 4 bytes Uint8Array */
    numberTo4BytesUint8Array(num) {
        this.view4.setUint32(0, num, true); // true for little-endian
        return new Uint8Array(this.buffer4);
    }
    /** Number should be between 0 and 281474976710655 @param {number} num - Integer to convert to 6 bytes Uint8Array */
    numberTo6BytesUint8Array(num) {
        // Combine the 6 bytes into one number
        const numBig = BigInt(num);
        const lower = numBig & 0xFFFFFFFFn; // Read the lower 4 bytes
        const upper = numBig >> 32n; // Read the upper 2 bytes
        this.view6.setUint32(0, Number(lower), true);
        this.view6.setUint16(4, Number(upper), true);
        return new Uint8Array(this.buffer6);
    }
    bigIntTo8BytesUint8Array(bigInt) {
        this.view8.setBigUint64(0, bigInt, true);
        return new Uint8Array(this.buffer8);
    }
    /** Number should be between 0 and 281474976710655 @param {number} num - Integer to convert to the smallest Uint8Array possible */
    numberToUint8Array(num) {
        if (num > 281474976710655) { throw new Error('Number out of range: > 281474976710655'); }

        if (num > 4294967295) { return this.numberTo6BytesUint8Array(num); }
        if (num > 65535) { return this.numberTo4BytesUint8Array(num); }
        if (num > 255) { return this.numberTo2BytesUint8Array(num); }
        if (num >= 0) { return this.numberTo1ByteUint8Array(num); }
        
        throw new Error('Number out of range: < 0');
    }
    /** @param {string} hex - Hex string to convert to Uint8Array */
    hexToUint8Array(hex) {
        const length = hex.length / 2;
        const uint8Array = new Uint8Array(length);
        
        for (let i = 0, j = 0; i < length; ++i, j += 2) {
            uint8Array[i] = (this.hexMap[hex[j]] << 4) + this.hexMap[hex[j + 1]];
        }
    
        return uint8Array;
    }
    /** @param {string} hex - Hex string to convert to BigInt */
    hexToBigInt(hex) {
        return BigInt('0x' + hex);
    }

    /** @param {string} str - string to convert to Uint8Array */
    stringToUint8Array(str) {
        return new TextEncoder().encode(str);
    }
    /** @param {string} hex - Hex string to convert to base58 */
    hexToBase58(hex) {
        const num = this.hexToBigInt(hex);

        let base58 = '';
        let n = num;
        while (n > 0) {
            const remainder = n % BigInt(58);
            base58 = this.base58AlphabetRev[Number(remainder)] + base58;
            n = n / BigInt(58);
        }

        const bytes = isNode ? Buffer.from(base58) : new TextEncoder().encode(base58);

        for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
            base58 = '1' + base58;
        }

        return base58;
    }
    /** @param {string} base58 - Base58 string to convert to Hex */
    base58ToHex(base58, minLength = 0) {
        let num = BigInt(0);
        const base = BigInt(58);
        for (const char of base58) { num = num * base + BigInt(this.base58Alphabet[char]); }

        let hex = num.toString(16);
        if (hex.length % 2 !== 0) { hex = '0' + hex; }
        if (minLength > 0) { hex = hex.padStart(minLength, '0'); }
        return hex;
    }
    /** @param {string} addressBase58 - Base58 address to convert to Uint8Array(16 bytes) */
    addressBase58ToUint8Array(addressBase58) {
        const hex = this.base58ToHex(addressBase58, 32);
        return this.hexToUint8Array(hex);
    }
    /** @param {Uint8Array} addressUint8Array - Uint8Array(16 bytes) to convert to base58 */
    addressUint8ArrayToBase58(addressUint8Array) {
        const hex = this.uint8ArrayToHex(addressUint8Array, 32);
        //if (hex.length !== 32) { throw new Error('Invalid address length'); }
        return this.hexToBase58(hex);
    }

    uint8ArrayToHex(uint8Array, minLength = 0) {
        let hexStr = '';
        /*for (let i = 0; i < uint8Array.length; i++) {
            hexStr += uint8Array[i].toString(16).padStart(2, '0');
        }*/
        uint8Array.forEach(byte => hexStr += byte.toString(16).padStart(2, '0'));
        if (minLength > 0) { hexStr = hexStr.padStart(minLength, '0'); }
        return hexStr;
    }
    /** @param {Uint8Array} uint8Array - Uint8Array to convert to string */
    uint81ByteToNumber(uint8Array) {
        return uint8Array[0];
    }
    uint82BytesToNumber(uint8Array) {
        this.view2.setUint8(0, uint8Array[0]);
        this.view2.setUint8(1, uint8Array[1]);
        return this.view2.getUint16(0, true);
    }
    uint84BytesToNumber(uint8Array) {
        this.view4.setUint8(0, uint8Array[0]);
        this.view4.setUint8(1, uint8Array[1]);
        this.view4.setUint8(2, uint8Array[2]);
        this.view4.setUint8(3, uint8Array[3]);
        return this.view4.getUint32(0, true);
    }
    uint86BytesToNumber(uint8Array) {
        for (let i = 0; i < 8; i++) { this.view8.setUint8(i, 0); }
        for (let i = 0; i < 6; i++) { this.view8.setUint8(i, uint8Array[i]); }
        return Number(this.view8.getBigUint64(0, true));
    }
    uint88BytesToBigInt(uint8Array) {
        for (let i = 0; i < 8; i++) { this.view8.setUint8(i, uint8Array[i]); }
        return this.view8.getBigUint64(0, true);
    }
};
const fastConverter = new FastConverter();

const serializer = {
    rawData: {
        toBinary_v1(rawData) {
            /** @type {Uint8Array} */
            const encoded = msgpack.encode(rawData);//, { maxStrLength: }
            return encoded;
        },
        /** @param {Uint8Array} encodedData */
        fromBinary_v1(encodedData) {
            return msgpack.decode(encodedData);
        },
        clone(data) { // not that fast compared to JSON.parse(JSON.stringify(data))
            const encoded = serializer.rawData.toBinary_v1(data);
            const decoded = serializer.rawData.fromBinary_v1(encoded);
            return decoded;
        }
    },
    transaction: {
        /** @param {Transaction} tx */
        toBinary_v2(tx, applyMsgPack = true) { // return array of Uint8Array
            try {
                const txAsArray = [
                    null, // id
                    [], // witnesses
                    null, // version
                    [], // inputs,
                    [] // outputs
                ]

                txAsArray[0] = convert.hex.toUint8Array(tx.id); // safe type: hex
                txAsArray[2] = convert.number.toUint8Array(tx.version); // safe type: number

                for (let i = 0; i < tx.witnesses.length; i++) {
                    const splitted = tx.witnesses[i].split(':');
                    txAsArray[1].push([
                        convert.hex.toUint8Array(splitted[0]), // safe type: hex
                        convert.hex.toUint8Array(splitted[1]) // safe type: hex
                    ]);
                }

                for (let j = 0; j < tx.inputs.length; j++) {
                    const splitted = tx.inputs[j].split(':');
                    if (splitted.length === 3) { // -> anchor ex: "3:f996a9d1:0"
                        txAsArray[3].push([
                            convert.number.toUint8Array(splitted[0]), // safe type: number
                            convert.hex.toUint8Array(splitted[1]), // safe type: hex
                            convert.number.toUint8Array(splitted[2]) // safe type: number
                        ]);
                    } else if (splitted.length === 2) { // -> pos validator address:hash
                        // ex: "WKXmNF5xJTd58aWpo7QX:964baf99b331fe400ca2de4da6fb4f52cbff8a7abfcea74e9f28704dc0dd2b5c"
                        txAsArray[3].push([
                            convert.base58.toUint8Array(splitted[0]), // safe type: base58
                            convert.hex.toUint8Array(splitted[1]) // safe type: hex
                        ]);
                    } else if (splitted.length === 1) { // -> pow miner nonce ex: "5684e9b4"
                        txAsArray[3].push([convert.hex.toUint8Array(splitted[0])]); // safe type: hex
                    }
                };

                for (let j = 0; j < tx.outputs.length; j++) {
                    const { address, amount, rule } = tx.outputs[j];
                    if (address, amount, rule) { //  {"amount": 19545485, "rule": "sig", "address": "WKXmNF5xJTd58aWpo7QX"}
                        const ruleCode = UTXO_RULES_GLOSSARY[rule].code;
                        txAsArray[4].push([
                            convert.number.toUint8Array(amount), // safe type: number
                            convert.number.toUint8Array(ruleCode), // safe type: numbers
                            convert.base58.toUint8Array(address) // safe type: base58
                        ]);
                    } else { // type: string
                        txAsArray[4].push([convert.string.toUint8Array(tx.outputs[j])]);
                    }
                };

                if (!applyMsgPack) { return txAsArray; }

                /** @type {Uint8Array} */
                const encoded = msgpack.encode(txAsArray);
                return encoded;
            } catch (error) {
                console.error('Error in prepareTransaction.toBinary_v2:', error);
                throw new Error('Failed to serialize the transaction');
            }
        },
        /** @param {Uint8Array} encodedTx */
        fromBinary_v2(encodedTx, applyMsgPack = true) {
            try {
                /** @type {Transaction} */
                const decodedTx = applyMsgPack ? msgpack.decode(encodedTx) : encodedTx;
                /** @type {Transaction} */
                const tx = {
                    id: convert.uint8Array.toHex(decodedTx[0]), // safe type: uint8 -> hex
                    witnesses: [],
                    version: convert.uint8Array.toNumber(decodedTx[2]), // safe type: uint8 -> number
                    inputs: [],
                    outputs: []
                };

                for (let i = 0; i < decodedTx[1].length; i++) {
                    const signature = convert.uint8Array.toHex(decodedTx[1][i][0]); // safe type: uint8 -> hex
                    const publicKey = convert.uint8Array.toHex(decodedTx[1][i][1]); // safe type: uint8 -> hex
                    tx.witnesses.push(`${signature}:${publicKey}`);
                };

                for (let j = 0; j < decodedTx[3].length; j++) {
                    const input = decodedTx[3][j];
                    if (input.length === 3) { // -> anchor ex: "3:f996a9d1:0"
                        tx.inputs.push(`${convert.uint8Array.toNumber(input[0])}:${convert.uint8Array.toHex(input[1])}:${convert.uint8Array.toNumber(input[2])}`);
                    } else if (input.length === 2) { // -> pos validator address:hash
                        tx.inputs.push(`${convert.uint8Array.toBase58(input[0])}:${convert.uint8Array.toHex(input[1])}`);
                    } else if (input.length === 1) { // -> pow miner nonce ex: "5684e9b4"
                        tx.inputs.push(convert.uint8Array.toHex(input[0]));
                    }
                };

                for (let j = 0; j < decodedTx[4].length; j++) {
                    const output = decodedTx[4][j];
                    if (output.length === 3) {
                        const amount = convert.uint8Array.toNumber(output[0]); // safe type: uint8 -> number
                        const ruleCode = convert.uint8Array.toNumber(output[1]); // safe type: uint8 -> number
                        const rule = UTXO_RULESNAME_FROM_CODE[ruleCode];
                        const address = convert.uint8Array.toBase58(output[2]); // safe type: uint8 -> base58
                        tx.outputs.push({ address, amount, rule });
                    } else {
                        tx.outputs.push(convert.uint8Array.toString(output));
                    }
                }

                return tx;
            } catch (error) {
                console.error('Error in prepareTransaction.fromBinary_v2:', error);
                throw new Error('Failed to deserialize the transaction');
            }
        }
    },
    array_of_transactions: {
        /** @param {Transaction[]} txs */
        toBinary_v3(txs, applyMsgPack = true) {
            const serializedTxs = [];
            for (let i = 0; i < txs.length; i++) {
                serializedTxs.push(serializer.transaction.toBinary_v2(txs[i], false));
            }

            if (!applyMsgPack) { return serializedTxs; }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(serializedTxs);
            return encoded;
        },
        toBinary_v4(txs, applyMsgPack = true) {
            const serializedTxs = [];
            for (let i = 0; i < txs.length; i++) {
                if (i < 2) { serializedTxs.push(serializer.transaction.toBinary_v2(txs[i], false)); continue; }
                serializedTxs.push(serializerFast.serialize.transaction(txs[i]));
            }

            if (!applyMsgPack) { return serializedTxs; }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(serializedTxs);
            return encoded;
        },
        /** @param {Uint8Array} encodedTxs */
        fromBinary_v3(encodedTxs, applyMsgPack = true) {
            const decodedTxs = applyMsgPack ? msgpack.decode(encodedTxs) : encodedTxs;
            const txs = [];
            for (let i = 0; i < decodedTxs.length; i++) {
                txs.push(serializer.transaction.fromBinary_v2(decodedTxs[i], false));
            }

            return txs;
        },
        fromBinary_v4(encodedTxs, applyMsgPack = true) {
            const decodedTxs = applyMsgPack ? msgpack.decode(encodedTxs) : encodedTxs;
            const txs = [];
            for (let i = 0; i < decodedTxs.length; i++) {
                if (i < 2) { txs.push(serializer.transaction.fromBinary_v2(decodedTxs[i], false)); continue; }
                txs.push(serializerFast.deserialize.transaction(decodedTxs[i]));
            }

            return txs;
        }
    },
    array_of_tx_ids: {
        /** @param {string[]} txIds */
        toBinary_v3(txIds, applyMsgPack = true) {
            const txIdsAsArray = [];
            for (let i = 0; i < txIds.length; i++) {
                txIdsAsArray.push(convert.hex.toUint8Array(txIds[i])); // safe type: hex
            }

            if (!applyMsgPack) { return txIdsAsArray; }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(txIdsAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedTxIds */
        fromBinary_v3(encodedTxIds, applyMsgPack = true) {
            const decodedTxIds = applyMsgPack ? msgpack.decode(encodedTxIds) : encodedTxIds;
            const txIds = [];
            for (let i = 0; i < decodedTxIds.length; i++) {
                txIds.push(convert.uint8Array.toHex(decodedTxIds[i])); // safe type: uint8 -> hex
            }

            return txIds;
        }
    },
    block_candidate: {
        /** @param {BlockData} blockData */
        toBinary_v2(blockData) {
            // + powReward
            // - nonce - hash - timestamp

            const blockAsArray = [
                convert.number.toUint8Array(blockData.index), // safe type: number
                convert.number.toUint8Array(blockData.supply), // safe type: number
                convert.number.toUint8Array(blockData.coinBase), // safe type: number
                convert.number.toUint8Array(blockData.difficulty), // safe type: number
                convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                convert.number.toUint8Array(blockData.powReward), // safe type: number
                [] // Txs
            ];

            for (let i = 0; i < blockData.Txs.length; i++) {
                blockAsArray[8].push(serializer.transaction.toBinary_v2(blockData.Txs[i]));
            }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v2(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = {
                index: convert.uint8Array.toNumber(decodedBlock[0]), // safe type: uint8 -> number
                supply: convert.uint8Array.toNumber(decodedBlock[1]), // safe type: uint8 -> number
                coinBase: convert.uint8Array.toNumber(decodedBlock[2]), // safe type: uint8 -> number
                difficulty: convert.uint8Array.toNumber(decodedBlock[3]), // safe type: uint8 -> number
                legitimacy: convert.uint8Array.toNumber(decodedBlock[4]), // safe type: uint8 -> number
                prevHash: convert.uint8Array.toHex(decodedBlock[5]), // safe type: uint8 -> hex
                posTimestamp: convert.uint8Array.toNumber(decodedBlock[6]), // safe type: uint8 -> number
                powReward: convert.uint8Array.toNumber(decodedBlock[7]), // safe type: uint8 -> number
                Txs: []
            };

            for (let i = 0; i < decodedBlock[8].length; i++) {
                blockData.Txs.push(serializer.transaction.fromBinary_v2(decodedBlock[8][i]));
            }

            return blockData;
        },
        /** @param {BlockData} blockData */
        toBinary_v4(blockData) {
            const blockAsArray = [
                convert.number.toUint8Array(blockData.index), // safe type: number
                convert.number.toUint8Array(blockData.supply), // safe type: number
                convert.number.toUint8Array(blockData.coinBase), // safe type: number
                convert.number.toUint8Array(blockData.difficulty), // safe type: number
                convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                convert.number.toUint8Array(blockData.powReward), // safe type: number
                serializer.array_of_transactions.toBinary_v4(blockData.Txs, false)
            ];

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v4(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = {
                index: convert.uint8Array.toNumber(decodedBlock[0]), // safe type: uint8 -> number
                supply: convert.uint8Array.toNumber(decodedBlock[1]), // safe type: uint8 -> number
                coinBase: convert.uint8Array.toNumber(decodedBlock[2]), // safe type: uint8 -> number
                difficulty: convert.uint8Array.toNumber(decodedBlock[3]), // safe type: uint8 -> number
                legitimacy: convert.uint8Array.toNumber(decodedBlock[4]), // safe type: uint8 -> number
                prevHash: convert.uint8Array.toHex(decodedBlock[5]), // safe type: uint8 -> hex
                posTimestamp: convert.uint8Array.toNumber(decodedBlock[6]), // safe type: uint8 -> number
                powReward: convert.uint8Array.toNumber(decodedBlock[7]), // safe type: uint8 -> number
                Txs: serializer.array_of_transactions.fromBinary_v4(decodedBlock[8], false)
            };

            return blockData;
        }
    },
    block_finalized: {
        /** @param {BlockData} blockData */
        toBinary_v2(blockData) {
            //const startTimestamp = Date.now();
            const blockAsArray = [
                convert.number.toUint8Array(blockData.index), // safe type: number
                convert.number.toUint8Array(blockData.supply), // safe type: number
                convert.number.toUint8Array(blockData.coinBase), // safe type: number
                convert.number.toUint8Array(blockData.difficulty), // safe type: number
                convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                convert.number.toUint8Array(blockData.timestamp), // safe type: number
                convert.hex.toUint8Array(blockData.hash), // safe type: hex
                convert.hex.toUint8Array(blockData.nonce), // safe type: hex
                [] // Txs
            ];

            for (let i = 0; i < blockData.Txs.length; i++) {
                blockAsArray[10].push(serializer.transaction.toBinary_v2(blockData.Txs[i]));
            };

            //console.log('Block finalized serialization time:', Date.now() - startTimestamp, 'ms');
            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            //console.log('Block finalized serialization+msgpack time:', Date.now() - startTimestamp, 'ms');
            //console.log('Block finalized serialization+msgpack size:', encoded.length, 'bytes');
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v2(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = {
                index: convert.uint8Array.toNumber(decodedBlock[0]), // safe type: uint8 -> number
                supply: convert.uint8Array.toNumber(decodedBlock[1]), // safe type: uint8 -> number
                coinBase: convert.uint8Array.toNumber(decodedBlock[2]), // safe type: uint8 -> number
                difficulty: convert.uint8Array.toNumber(decodedBlock[3]), // safe type: uint8 -> number
                legitimacy: convert.uint8Array.toNumber(decodedBlock[4]), // safe type: uint8 -> number
                prevHash: convert.uint8Array.toHex(decodedBlock[5]), // safe type: uint8 -> hex
                posTimestamp: convert.uint8Array.toNumber(decodedBlock[6]), // safe type: uint8 -> number   
                timestamp: convert.uint8Array.toNumber(decodedBlock[7]), // safe type: uint8 -> number
                hash: convert.uint8Array.toHex(decodedBlock[8]), // safe type: uint8 -> hex
                nonce: convert.uint8Array.toHex(decodedBlock[9]), // safe type: uint8 -> hex
                Txs: []
            };

            for (let i = 0; i < decodedBlock[10].length; i++) {
                blockData.Txs.push(serializer.transaction.fromBinary_v2(decodedBlock[10][i]));
            }

            return blockData;
        },
        /** @param {BlockData} blockData */
        toBinary_v3(blockData) {
            const blockAsArray = serializer.blockHeader_finalized.toBinary_v3(blockData, false);
            const Txs = serializer.array_of_transactions.toBinary_v3(blockData.Txs, false);
            blockAsArray.push(Txs);

            //console.log('Block finalized serialization time:', Date.now() - startTimestamp, 'ms');
            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            //console.log('Block finalized serialization+msgpack time:', Date.now() - startTimestamp, 'ms');
            //console.log('Block finalized serialization+msgpack size:', encoded.length, 'bytes');
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v3(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = serializer.blockHeader_finalized.fromBinary_v3(decodedBlock, false);
            blockData.Txs = serializer.array_of_transactions.fromBinary_v3(decodedBlock[10], false);

            return blockData;
        },
        /** @param {BlockData} blockData */
        toBinary_v4(blockData) {
            const blockAsArray = serializer.blockHeader_finalized.toBinary_v3(blockData, false);
            const Txs = serializer.array_of_transactions.toBinary_v4(blockData.Txs, false);
            blockAsArray.push(Txs);

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedBlock */
        fromBinary_v4(encodedBlock) {
            const decodedBlock = msgpack.decode(encodedBlock);
            /** @type {BlockData} */
            const blockData = serializer.blockHeader_finalized.fromBinary_v3(decodedBlock, false);
            blockData.Txs = serializer.array_of_transactions.fromBinary_v4(decodedBlock[10], false);

            return blockData;
        }
    },
    blocks_finalized: {
        /** @param {BlockData[]} blocksData */
        toBinary_v3(blocksData, applyMsgPack = true) {
            const blocksAsArray = [];
            for (let i = 0; i < blocksData.length; i++) {
                blocksAsArray.push(serializer.block_finalized.toBinary_v3(blocksData[i], false));
            }

            if (!applyMsgPack) { return blocksAsArray; }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blocksAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedBlocks */
        fromBinary_v3(encodedBlocks, applyMsgPack = true) {
            const decodedBlocks = applyMsgPack ? msgpack.decode(encodedBlocks) : encodedBlocks;
            const blocksData = [];
            for (let i = 0; i < decodedBlocks.length; i++) {
                blocksData.push(serializer.block_finalized.fromBinary_v3(decodedBlocks[i], false));
            }

            return blocksData;
        }
    },
    blockHeader_finalized: {
        /** @param {BlockData} blockData */
        toBinary_v3(blockData, applyMsgPack = true) {
            const blockHeaderAsArray = [
                convert.number.toUint8Array(blockData.index), // safe type: number
                convert.number.toUint8Array(blockData.supply), // safe type: number
                convert.number.toUint8Array(blockData.coinBase), // safe type: number
                convert.number.toUint8Array(blockData.difficulty), // safe type: number
                convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                convert.number.toUint8Array(blockData.timestamp), // safe type: number
                convert.hex.toUint8Array(blockData.hash), // safe type: hex
                convert.hex.toUint8Array(blockData.nonce) // safe type: hex
            ];

            if (!applyMsgPack) { return blockHeaderAsArray; }

            /** @type {Uint8Array} */
            const encoded = msgpack.encode(blockHeaderAsArray);
            return encoded;
        },
        /** @param {Uint8Array} encodedBlockHeader */
        fromBinary_v3(encodedBlockHeader, applyMsgPack = true) {
            const decodedBlockHeader = applyMsgPack ? msgpack.decode(encodedBlockHeader) : encodedBlockHeader;
            /** @type {BlockData} */
            const blockData = {
                index: convert.uint8Array.toNumber(decodedBlockHeader[0]), // safe type: uint8 -> number
                supply: convert.uint8Array.toNumber(decodedBlockHeader[1]), // safe type: uint8 -> number
                coinBase: convert.uint8Array.toNumber(decodedBlockHeader[2]), // safe type: uint8 -> number
                difficulty: convert.uint8Array.toNumber(decodedBlockHeader[3]), // safe type: uint8 -> number
                legitimacy: convert.uint8Array.toNumber(decodedBlockHeader[4]), // safe type: uint8 -> number
                prevHash: convert.uint8Array.toHex(decodedBlockHeader[5]), // safe type: uint8 -> hex
                posTimestamp: convert.uint8Array.toNumber(decodedBlockHeader[6]), // safe type: uint8 -> number
                timestamp: convert.uint8Array.toNumber(decodedBlockHeader[7]), // safe type: uint8 -> number
                hash: convert.uint8Array.toHex(decodedBlockHeader[8]), // safe type: uint8 -> hex
                nonce: convert.uint8Array.toHex(decodedBlockHeader[9]) // safe type: uint8 -> hex
            };

            return blockData;
        }
    },
};
/**
 * Theses functions are used to convert data between different formats.
 * 
 * - functions do not check the input data.
 * - Make sure to validate the data before using these functions.
 */
const serializerFast = {
    serialize: {
        /** @param {string} anchor */
        anchor(anchor) {
            const splitted = anchor.split(':');
            const blockHeight = fastConverter.numberTo4BytesUint8Array(splitted[0]);
            const hash = fastConverter.hexToUint8Array(splitted[1]);
            const inputIndex = fastConverter.numberTo2BytesUint8Array(splitted[2]);

            const anchorBuffer = new ArrayBuffer(10);
            const bufferView = new Uint8Array(anchorBuffer);
            bufferView.set(blockHeight, 0);
            bufferView.set(hash, 4);
            bufferView.set(inputIndex, 8);
            return bufferView;
        },
        /** @param {string[]} anchors */
        anchorsArray(anchors) {
            const anchorsBuffer = new ArrayBuffer(10 * anchors.length);
            const bufferView = new Uint8Array(anchorsBuffer);
            for (let j = 0; j < anchors.length; j++) { // -> anchor ex: "3:f996a9d1:0"
                const splitted = anchors[j].split(':');
                const blockHeight = fastConverter.numberTo4BytesUint8Array(splitted[0]);
                const hash = fastConverter.hexToUint8Array(splitted[1]);
                const inputIndex = fastConverter.numberTo2BytesUint8Array(splitted[2]);

                bufferView.set(blockHeight, j * 10);
                bufferView.set(hash, j * 10 + 4);
                bufferView.set(inputIndex, j * 10 + 8);
            };
            return bufferView;
        },
        anchorsObjToArray(anchors) {
            return this.anchorsArray(Object.keys(anchors));
        },
        /** serialize the UTXO as a miniUTXO: address, amount, rule (23 bytes)
         * @param {UTXO} utxo */
        miniUTXO(utxo) {
            const utxoBuffer = new ArrayBuffer(23);
            const bufferView = new Uint8Array(utxoBuffer); // 23 bytes (6 + 1 + 16)
            bufferView.set(fastConverter.numberTo6BytesUint8Array(utxo.amount), 0);
            bufferView.set(fastConverter.numberTo1ByteUint8Array(UTXO_RULES_GLOSSARY[utxo.rule].code), 6);
            bufferView.set(fastConverter.addressBase58ToUint8Array(utxo.address), 7);
            return bufferView;
        },
        /** @param {UTXO[]} outputs */
        miniUTXOsArray(outputs) {
            const outputsBuffer = new ArrayBuffer(23 * outputs.length);
            const outputsBufferView = new Uint8Array(outputsBuffer);
            for (let i = 0; i < outputs.length; i++) {
                const { address, amount, rule } = outputs[i];
                const ruleCode = UTXO_RULES_GLOSSARY[rule].code;
                outputsBufferView.set(fastConverter.numberTo6BytesUint8Array(amount), i * 23);
                outputsBufferView.set(fastConverter.numberTo1ByteUint8Array(ruleCode), i * 23 + 6);
                outputsBufferView.set(fastConverter.addressBase58ToUint8Array(address), i * 23 + 7);
            }
            return outputsBufferView;
        },
        /** @param {Object <string, UTXO>} utxos */
        miniUTXOsObj(utxos) {
            const totalBytes = (10 + 23) * Object.keys(utxos).length;
            const utxosBuffer = new ArrayBuffer(totalBytes);
            const bufferView = new Uint8Array(utxosBuffer);
            // loop over entries
            let i = 0;
            for (const [key, value] of Object.entries(utxos)) {
                // key: anchor string (10 bytes)
                // value: miniUTXO serialized (23 bytes uint8Array)
                const anchorSerialized = this.anchor(key);
                const miniUTXOSerialized = value;
                bufferView.set(anchorSerialized, i * 33);
                bufferView.set(miniUTXOSerialized, i * 33 + 10);

                i++;
            }
            return bufferView;
        },
        /** @param {string[]} txsRef */
        txsReferencesArray(txsRef) {
            const anchorsBuffer = new ArrayBuffer(8 * txsRef.length);
            const bufferView = new Uint8Array(anchorsBuffer);
            for (let j = 0; j < txsRef.length; j++) { // -> anchor ex: "3:f996a9d1:0"
                const splitted = txsRef[j].split(':');
                const blockHeight = fastConverter.numberTo4BytesUint8Array(splitted[0]);
                const hash = fastConverter.hexToUint8Array(splitted[1]);

                bufferView.set(blockHeight, j * 8);
                bufferView.set(hash, j * 8 + 4);
            };
            return bufferView;
        },
        witnessesArray(witnesses) {
            const witnessesBuffer = new ArrayBuffer(96 * witnesses.length); // (sig + pubKey) * nb of witnesses
            const witnessesBufferView = new Uint8Array(witnessesBuffer);
            for (let i = 0; i < witnesses.length; i++) {
                const witness = fastConverter.hexToUint8Array(witnesses[i].replace(':', ''));
                witnessesBufferView.set(witness, i * 96);
            }
            return witnessesBufferView;
        },
        specialTransation: {
            
        },
        /** @param {Transaction} tx */
        transaction(tx) {
            try {
                const elementsLenght = {
                    witnesses: tx.witnesses.length, // nb of witnesses
                    witnessesBytes: tx.witnesses.length * 96, // (sig + pubKey) * nb of witnesses -> 96 bytes * nb of witnesses
                    inputs: tx.inputs.length, // nb of inputs
                    inputsBytes: tx.inputs.length * 10, // (blockHeight + hash + inputIndex) * nb of inputs -> 10 bytes * nb of inputs
                    outputs: tx.outputs.length, // nb of outputs
                    outputsBytes: tx.outputs.length * 23, // (amount + rule + address) * nb of outputs -> 23 bytes * nb of outputs
                    dataBytes: tx.data ? tx.data.byteLength : 0 // data: bytes
                }

                const serializedTx = new ArrayBuffer(8 + 4 + elementsLenght.witnessesBytes + 2 + elementsLenght.inputsBytes + elementsLenght.outputsBytes + elementsLenght.dataBytes);
                const serializedTxView = new Uint8Array(serializedTx);

                // DESCRIPTION (8 bytes)
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.witnesses), 0); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.inputs), 2); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.outputs), 4); // 2 bytes
                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(elementsLenght.dataBytes), 6); // 2 bytes
                
                let cursor = 8;
                serializedTxView.set(fastConverter.hexToUint8Array(tx.id), cursor);
                cursor += 4; // id: hex 4 bytes

                serializedTxView.set(this.witnessesArray(tx.witnesses), cursor);
                cursor += elementsLenght.witnessesBytes;

                serializedTxView.set(fastConverter.numberTo2BytesUint8Array(tx.version), cursor);
                cursor += 2; // version: number 2 bytes

                serializedTxView.set(this.anchorsArray(tx.inputs), cursor);
                cursor += elementsLenght.inputsBytes;

                const serializedOutputs = this.miniUTXOsArray(tx.outputs);
                serializedTxView.set(serializedOutputs, cursor);
                cursor += elementsLenght.outputsBytes;

                if (elementsLenght.dataBytes === 0) { return serializedTxView; }

                throw new Error('Data serialization not implemented yet');
                serializedTxView.set(tx.data, cursor); // max 65535 bytes
                return serializedTxView;

            } catch (error) {
                console.error('Error while serializing the transaction:', error);
                throw new Error('Failed to serialize the transaction');
            }
        },
        /** @param {Object <string, string>} pubkeyAddresses */
        pubkeyAddressesObj(pubkeyAddresses) {
            // { pubKeyHex(32bytes): addressBase58(16bytes) }

            const pubKeys = Object.keys(pubkeyAddresses);
            const nbOfBytesToAllocate = pubKeys.length * (32 + 16);
            const resultBuffer = new ArrayBuffer(nbOfBytesToAllocate);
            const uint8Result = new Uint8Array(resultBuffer);
            for (let i = 0; i < pubKeys.length; i++) {
                uint8Result.set(fastConverter.hexToUint8Array(pubKeys[i]), i * 48);
                uint8Result.set(fastConverter.addressBase58ToUint8Array(pubkeyAddresses[pubKeys[i]]), i * 48 + 32);
            }
            return uint8Result;
        },

        /** @param {BlockData} blockData */
        blockHeader_finalized(blockData) {
            try {
                const elementsLenght = {
                    indexBytes: 4,
                    supplyBytes: 8,
                    coinBaseBytes: 4,
                    difficultyBytes: 4,
                    legitimacyBytes: 2,
                    prevHashBytes: 32,
                    posTimestampBytes: 4,
                    timestampBytes: 4,
                    hashBytes: 32,
                    nonceBytes: 4
                }
                
                const serializedHeader = new ArrayBuffer();
                /*const blockHeaderAsArray = [
                    convert.number.toUint8Array(blockData.index), // safe type: number
                    convert.number.toUint8Array(blockData.supply), // safe type: number
                    convert.number.toUint8Array(blockData.coinBase), // safe type: number
                    convert.number.toUint8Array(blockData.difficulty), // safe type: number
                    convert.number.toUint8Array(blockData.legitimacy), // safe type: number
                    convert.hex.toUint8Array(blockData.prevHash), // safe type: hex
                    convert.number.toUint8Array(blockData.posTimestamp), // safe type: number
                    convert.number.toUint8Array(blockData.timestamp), // safe type: number
                    convert.hex.toUint8Array(blockData.hash), // safe type: hex
                    convert.hex.toUint8Array(blockData.nonce) // safe type: hex
                ];*/
                
            } catch (error) {
                
            }
        }
    },
    deserialize: {
        /** @param {Uint8Array} serializedAnchor */
        anchor(serializedAnchor) {
            const blockHeightSerialized = serializedAnchor.slice(0, 4);
            const hashSerialized = serializedAnchor.slice(4, 8);
            const inputIndexSerialized = serializedAnchor.slice(8, 10);

            const blockHeight = fastConverter.uint84BytesToNumber(blockHeightSerialized);
            const hash = fastConverter.uint8ArrayToHex(hashSerialized);
            const inputIndex = fastConverter.uint82BytesToNumber(inputIndexSerialized);

            return `${blockHeight}:${hash}:${inputIndex}`;
        },
        /** @param {Uint8Array} serializedAnchorsArray */
        anchorsArray(serializedAnchorsArray) {
            const anchors = [];
            for (let i = 0; i < serializedAnchorsArray.length; i += 10) {
                const serializedAnchor = serializedAnchorsArray.slice(i, i + 10);
                anchors.push(this.anchor(serializedAnchor));
            }
            return anchors;
        },
        /** @param {Uint8Array} serializedAnchorsObj */
        anchorsObjFromArray(serializedAnchorsObj) {
            const anchors = this.anchorsArray(serializedAnchorsObj);
            const obj = {};
            for (let i = 0; i < anchors.length; i++) {
                obj[anchors[i]] = true;
            }
            return obj;
        },
        /** Deserialize a miniUTXO: address, amount, rule (23 bytes)
         * @param {Uint8Array} serializedUTXO */
        miniUTXO(serializedminiUTXO) {
            const amount = fastConverter.uint86BytesToNumber(serializedminiUTXO.slice(0, 6)); // 6 bytes
            const ruleCode = fastConverter.uint81ByteToNumber(serializedminiUTXO.slice(6, 7)); // 1 byte
            /** @type {string} */
            const rule = UTXO_RULESNAME_FROM_CODE[ruleCode];
            const address = fastConverter.addressUint8ArrayToBase58(serializedminiUTXO.slice(7, 23)); // 16 bytes

            return { address, amount, rule };
        },
        /** @param {Uint8Array} serializedminiUTXOs */
        miniUTXOsArray(serializedminiUTXOs) {
            const miniUTXOs = [];
            for (let i = 0; i < serializedminiUTXOs.length; i += 23) {
                miniUTXOs.push(this.miniUTXO(serializedminiUTXOs.slice(i, i + 23)));
            }
            return miniUTXOs;
        },
        /** @param {Uint8Array} serializedminiUTXOs */
        miniUTXOsObj(serializedminiUTXOs) {
            //const deserializationStart = performance.now();
            //let totalAnchorsDeserializationTime = 0;
            const miniUTXOsObj = {};
            for (let i = 0; i < serializedminiUTXOs.length; i += 33) {
                const anchorSerialized = serializedminiUTXOs.slice(i, i + 10);
                const miniUTXOSerialized = serializedminiUTXOs.slice(i + 10, i + 33);
                //const AnchorsdeserializationStart = performance.now();
                const anchor = this.anchor(anchorSerialized); // deserialize anchor to string key
                //const AnchorsdeserializationEnd = performance.now();
                //totalAnchorsDeserializationTime += AnchorsdeserializationEnd - AnchorsdeserializationStart;
                miniUTXOsObj[anchor] = miniUTXOSerialized;
            }
            /*const totalDeserializationTime = performance.now() - deserializationStart;
            console.log('Total anchors deserialization time:', totalAnchorsDeserializationTime, 'ms');
            console.log('Total deserialization time:', totalDeserializationTime, 'ms');*/
            return miniUTXOsObj;
        },
        /** @param {Uint8Array} serializedTxsRef */
        txsReferencesArray(serializedTxsRef) {
            const txsRef = [];
            for (let i = 0; i < serializedTxsRef.length; i += 8) {
                const blockHeight = fastConverter.uint84BytesToNumber(serializedTxsRef.slice(i, i + 4));
                const hash = fastConverter.uint8ArrayToHex(serializedTxsRef.slice(i + 4, i + 8));
                txsRef.push(`${blockHeight}:${hash}`);
            }
            return txsRef;
        },
        /** @param {Uint8Array} serializedWitnesses */
        witnessesArray(serializedWitnesses) {
            const witnesses = [];
            for (let i = 0; i < serializedWitnesses.length; i += 96) { 
                const sig = fastConverter.uint8ArrayToHex(serializedWitnesses.slice(i, i + 64));
                const pubKey = fastConverter.uint8ArrayToHex(serializedWitnesses.slice(i + 64, i + 96));
                witnesses.push(`${sig}:${pubKey}`);
            }
            return witnesses;
        },
        /** @param {Uint8Array} serializedTx */
        transaction(serializedTx) {
            try {
                const elementsLenght = {
                    witnesses: fastConverter.uint82BytesToNumber(serializedTx.slice(0, 2)), // nb of witnesses
                    inputs: fastConverter.uint82BytesToNumber(serializedTx.slice(2, 4)), // nb of inputs
                    outputs: fastConverter.uint82BytesToNumber(serializedTx.slice(4, 6)), // nb of outputs
                    dataBytes: fastConverter.uint82BytesToNumber(serializedTx.slice(6, 8)) // data: bytes
                }

                let cursor = 8;
                const id = fastConverter.uint8ArrayToHex(serializedTx.slice(cursor, cursor + 4));
                cursor += 4; // id: hex 4 bytes

                const witnesses = this.witnessesArray(serializedTx.slice(cursor, cursor + elementsLenght.witnesses * 96));
                cursor += elementsLenght.witnesses * 96;

                const version = fastConverter.uint82BytesToNumber(serializedTx.slice(cursor, cursor + 2));
                cursor += 2; // version: number 2 bytes

                const inputs = this.anchorsArray(serializedTx.slice(cursor, cursor + elementsLenght.inputs * 10));
                cursor += elementsLenght.inputs * 10;

                const outputs = this.miniUTXOsArray(serializedTx.slice(cursor, cursor + elementsLenght.outputs * 23));
                cursor += elementsLenght.outputs * 23;

                if (elementsLenght.dataBytes === 0) { return Transaction(inputs, outputs, id, witnesses, version); }

                throw new Error('Data field not implemented yet!');
                const data = serializedTx.slice(cursor, cursor + elementsLenght.dataBytes); // max 65535 bytes
                return Transaction(inputs, outputs, id, witnesses, version, data);
                
            } catch (error) {
                //console.error('Error in prepareTransaction.fromBinary_v2:', error);
                throw new Error('Failed to deserialize the transaction');
            }
        },
        /** @param {Uint8Array} serializedPubkeyAddresses */
        pubkeyAddressesObj(serializedPubkeyAddresses) {
            const pubkeyAddresses = {};
            for (let i = 0; i < serializedPubkeyAddresses.byteLength; i += 48) {
                const pubKey = fastConverter.uint8ArrayToHex(serializedPubkeyAddresses.slice(i, i + 32)); // 48 + 32 = 80
                const address = fastConverter.addressUint8ArrayToBase58(serializedPubkeyAddresses.slice(i + 32, i + 48));
                pubkeyAddresses[pubKey] = address;
            }
            return pubkeyAddresses;
        }
    }
};

const compression = {
    msgpack_Zlib: {
        rawData: {
            toBinary_v1(rawData, compress = false) {
                const encoded = msgpack.encode(rawData);
                /** @type {Uint8Array} */
                const readyToReturn = compress ? new Compressor.Zlib.Gzip(encoded).compress() : encoded;
                return readyToReturn;
            },
            /** @param {Uint8Array} binary */
            fromBinary_v1(binary, isCompressed = false) {
                const readyToDecode = isCompressed ? new Decompressor.Zlib.Gunzip(binary).decompress() : binary;
                const decoded = msgpack.decode(readyToDecode);

                return decoded;
            }
        },
        transaction: {
            /** @param {Transaction} tx */
            toBinary_v1(tx) {
                const prepared = compression.msgpack_Zlib.prepareTransaction.toBinary_v1(tx);
                const encoded = msgpack.encode(prepared);
                /** @type {Uint8Array} */
                const compressed = new Compressor.Zlib.Gzip(encoded).compress();
                return compressed;
            },
            /** @param {Uint8Array} binary */
            fromBinary_v1(binary) {
                const decompressed = new Decompressor.Zlib.Gunzip(binary).decompress();
                /** @type {Transaction} */
                const decoded = msgpack.decode(decompressed);
                const finalized = compression.msgpack_Zlib.prepareTransaction.fromBinary_v1(decoded);
                return finalized;
            }
        },
        prepareTransaction: { // ugly, remove if serializer.transaction.[...]_v2 is working
            /** @param {Transaction} tx */
            toBinary_v1(tx) {
                if (typeValidation.hex(tx.id) === false) {
                    throw new Error('Invalid tx.id');
                }
                tx.id = convert.hex.toUint8Array(tx.id); // safe type: hex
                for (let i = 0; i < tx.witnesses.length; i++) {
                    const signature = tx.witnesses[i].split(':')[0];
                    const publicKey = tx.witnesses[i].split(':')[1];
                    tx.witnesses[i] = [convert.hex.toUint8Array(signature), convert.hex.toUint8Array(publicKey)]; // safe type: hex
                }
                for (let j = 0; j < tx.inputs.length; j++) {
                    /*if (isMinerOrValidatorTx) {
                        tx.inputs[j] = convert.hex.toUint8Array(tx.inputs[j]); // case of coinbase/posReward: input = nonce/validatorHash
                        continue;
                    }*/

                    //for (const key in input) { if (input[key] === undefined) { delete input[key]; } } // should not append
                };
                for (let j = 0; j < tx.outputs.length; j++) {
                    const output = tx.outputs[j];
                    for (const key in output) { if (output[key] === undefined) { delete tx.outputs[j][key]; } }
                };

                return tx;
            },
            /** @param {Transaction} decodedTx */
            fromBinary_v1(decodedTx) {
                const tx = decodedTx;
                tx.id = convert.uint8Array.toHex(tx.id); // safe type: uint8 -> hex
                for (let i = 0; i < tx.witnesses.length; i++) {
                    const signature = convert.uint8Array.toHex(tx.witnesses[i][0]); // safe type: uint8 -> hex
                    const publicKey = convert.uint8Array.toHex(tx.witnesses[i][1]); // safe type: uint8 -> hex
                    tx.witnesses[i] = `${signature}:${publicKey}`;
                }
                for (let j = 0; j < tx.inputs.length; j++) {
                    const input = tx.inputs[j];
                    if (typeof input === 'string') { continue; }
                    if (typeValidation.uint8Array(input)) {
                        tx.inputs[j] = convert.uint8Array.toHex(input); // case of coinbase/posReward: input = nonce/validatorHash
                        continue;
                    }
                };

                return tx;
            }
        },
        proposalBlock: {
            /** @param {BlockData} blockData */
            toBinary_v1(blockData) {
                // first block prevHash isn't Hex
                blockData.prevHash = blockData.index !== 0 ? convert.hex.toUint8Array(blockData.prevHash) : blockData.prevHash;
                for (let i = 0; i < blockData.Txs.length; i++) {
                    //const isMinerOrValidatorTx = Transaction_Builder.isMinerOrValidatorTx(blockData.Txs[i]);
                    blockData.Txs[i] = compression.msgpack_Zlib.prepareTransaction.toBinary_v1(blockData.Txs[i]);
                };

                const encoded = msgpack.encode(blockData);
                /** @type {Uint8Array} */
                const compressed = new Compressor.Zlib.Gzip(encoded).compress();
                return compressed;
            },
            /** @param {Uint8Array} binary */
            fromBinary_v1(binary) {
                const decompressed = new Decompressor.Zlib.Gunzip(binary).decompress();
                /** @type {BlockData} */
                const decoded = msgpack.decode(decompressed);

                // first block prevHash isn't Hex
                decoded.prevHash = decoded.index !== 0 ? convert.uint8Array.toHex(decoded.prevHash) : decoded.prevHash;
                for (let i = 0; i < decoded.Txs.length; i++) {
                    decoded.Txs[i] = compression.msgpack_Zlib.prepareTransaction.fromBinary_v1(decoded.Txs[i]);
                };

                return decoded;
            }
        },
        finalizedBlock: {
            /** 
             * @param {BlockData} blockData */
            toBinary_v1(blockData, compress = false) {
                // first block prevHash isn't Hex
                blockData.prevHash = blockData.index !== 0 ? convert.hex.toUint8Array(blockData.prevHash) : blockData.prevHash;
                blockData.hash = convert.hex.toUint8Array(blockData.hash); // safe type: hex
                blockData.nonce = convert.hex.toUint8Array(blockData.nonce); // safe type: hex

                for (let i = 0; i < blockData.Txs.length; i++) {
                    //const isMinerOrValidatorTx = Transaction_Builder.isMinerOrValidatorTx(blockData.Txs[i], i);
                    blockData.Txs[i] = compression.msgpack_Zlib.prepareTransaction.toBinary_v1(blockData.Txs[i]);
                };

                const encoded = msgpack.encode(blockData);
                /** @type {Uint8Array} */
                //const compressed = new Compressor.Zlib.Gzip(encoded).compress();
                const readyToReturn = compress ? new Compressor.Zlib.Gzip(encoded).compress() : encoded;
                return readyToReturn;
            },
            /** @param {Uint8Array} binary */
            fromBinary_v1(binary, compress = false) {
                const readyToDecode = compress ? new Decompressor.Zlib.Gunzip(binary).decompress() : binary;
                /** @type {BlockData} */
                const decoded = msgpack.decode(readyToDecode);

                // first block prevHash isn't Hex
                decoded.prevHash = decoded.index !== 0 ? convert.uint8Array.toHex(decoded.prevHash) : decoded.prevHash;
                decoded.hash = convert.uint8Array.toHex(decoded.hash); // safe type: uint8 -> hex
                decoded.nonce = convert.uint8Array.toHex(decoded.nonce); // safe type: uint8 -> hex

                for (let i = 0; i < decoded.Txs.length; i++) {
                    decoded.Txs[i] = compression.msgpack_Zlib.prepareTransaction.fromBinary_v1(decoded.Txs[i]);
                };

                return decoded;
            }
        }
    },
    Gzip: {
        compress(data) {
            const compressed = new Compressor.Zlib.Gzip(data).compress();
            return compressed;
        },
        decompress(data) {
            const decompressed = new Decompressor.Zlib.Gunzip(data).decompress();
            return decompressed;
        }
    }
};
const mining = {
    /**
    * @param {BlockData} lastBlock
    * @returns {number} - New difficulty
    */
    difficultyAdjustment: (lastBlock, averageBlockTimeMS, logs = true) => {
        const blockIndex = lastBlock.index;
        const difficulty = lastBlock.difficulty;

        if (typeof difficulty !== 'number') { console.error('Invalid difficulty'); return 1; }
        if (difficulty < 1) { console.error('Invalid difficulty < 1'); return 1; }

        if (typeof blockIndex !== 'number') { console.error('Invalid blockIndex'); return difficulty; }
        if (blockIndex === 0) { return difficulty; }

        if (blockIndex % MINING_PARAMS.blocksBeforeAdjustment !== 0) { return difficulty; }

        const deviation = 1 - (averageBlockTimeMS / SETTINGS.targetBlockTime);
        const deviationPercentage = deviation * 100; // over zero = too fast / under zero = too slow

        if (logs) {
            console.log(`BlockIndex: ${blockIndex} | Average block time: ${Math.round(averageBlockTimeMS)}ms`);
            console.log(`Deviation: ${deviation.toFixed(4)} | Deviation percentage: ${deviationPercentage.toFixed(2)}%`);
        }

        const diffAdjustment = Math.floor(Math.abs(deviationPercentage) / MINING_PARAMS.thresholdPerDiffIncrement);
        const capedDiffIncrement = Math.min(diffAdjustment, MINING_PARAMS.maxDiffIncrementPerAdjustment);
        const diffIncrement = deviation > 0 ? capedDiffIncrement : -capedDiffIncrement;
        const newDifficulty = Math.max(difficulty + diffIncrement, 1); // cap at 1 minimum

        if (logs) {
            const state = diffIncrement === 0 ? 'maintained' : diffIncrement > 0 ? 'increased' : 'decreased';
            console.log(`Difficulty ${state} ${state !== 'maintained' ? "by: " + diffIncrement + " => " : ""}${state === 'maintained' ? 'at' : 'to'}: ${newDifficulty}`);
        }

        return newDifficulty;
    },
    /** @param {BlockData} blockData - undefined if genesis block */
    calculateNextCoinbaseReward(blockData) {
        if (!blockData) { throw new Error('Invalid blockData'); }

        const halvings = Math.floor( (blockData.index + 1) / SETTINGS.halvingInterval );
        const coinBases = [SETTINGS.rewardMagicNb1, SETTINGS.rewardMagicNb2];
        for (let i = 0; i < halvings + 1; i++) {
            coinBases.push(coinBases[coinBases.length - 2] - coinBases[coinBases.length - 1]);
        }

        const coinBase = Math.max(coinBases[coinBases.length - 1], SETTINGS.minBlockReward);
        const maxSupplyWillBeReached = blockData.supply + coinBase >= SETTINGS.maxSupply;
        return maxSupplyWillBeReached ? SETTINGS.maxSupply - blockData.supply : coinBase;
    },
    /** @param {BlockData} lastBlock @param {BlockData} olderBlock */
    calculateAverageBlockTime: (lastBlock, olderBlock) => {
        if (!olderBlock) { return SETTINGS.targetBlockTime; }
        const periodInterval = lastBlock.timestamp - olderBlock.posTimestamp;
        return periodInterval / MINING_PARAMS.blocksBeforeAdjustment;
    },
    /** @param {number} length - Nonce length in bytes */
    generateRandomNonce: (length = MINING_PARAMS.nonceLength) => {
        const Uint8 = new Uint8Array(length);
        crypto.getRandomValues(Uint8);

        const Hex = Array.from(Uint8).map(b => b.toString(16).padStart(2, '0')).join('');
        return { Uint8, Hex };
    },
    /**
     * This function uses an Argon2 hash function to perform a hashing operation.
     * The Argon2 hash function must follow the following signature:
     * - argon2HashFunction(pass, salt, time, mem, parallelism, type, hashLen)
     *
     *@param {function(string, string, number=, number=, number=, number=, number=): Promise<false | { encoded: string, hash: Uint8Array, hex: string, bitsArray: number[] }>} argon2HashFunction
     *@param {string} blockSignature - Block signature to hash
     *@param {string} nonce - Nonce to hash
    */
    hashBlockSignature: async (argon2HashFunction, blockSignature = '', nonce = '') => {
        const { time, mem, parallelism, type, hashLen } = MINING_PARAMS.argon2;
        const newBlockHash = await argon2HashFunction(blockSignature, nonce, time, mem, parallelism, type, hashLen);
        if (!newBlockHash) { return false; }

        return newBlockHash;
    },
    getBlockFinalDifficulty: (blockData) => {
        const { difficulty, legitimacy, posTimestamp, timestamp } = blockData;
        const powTimestamp = timestamp || posTimestamp + SETTINGS.targetBlockTime;

        if (!typeValidation.numberIsPositiveInteger(posTimestamp)) { throw new Error('Invalid posTimestamp'); }
        if (!typeValidation.numberIsPositiveInteger(powTimestamp)) { throw new Error('Invalid timestamp'); }

        const differenceRatio = (powTimestamp - posTimestamp) / SETTINGS.targetBlockTime;
        const timeDiffAdjustment = MINING_PARAMS.maxTimeDifferenceAdjustment - Math.round(differenceRatio * MINING_PARAMS.maxTimeDifferenceAdjustment);
        
        const legitimacyAdjustment = legitimacy * MINING_PARAMS.diffAdjustPerLegitimacy;
        const finalDifficulty = Math.max(difficulty + timeDiffAdjustment + legitimacyAdjustment, 1); // cap at 1 minimum

        return { difficulty, timeDiffAdjustment, legitimacy, finalDifficulty };
    },
    decomposeDifficulty: (difficulty = 1) => {
        const zeros = Math.floor(difficulty / 16);
        const adjust = difficulty % 16;
        return { zeros, adjust };
    },
    /** @param {string} HashBitsAsString @param {BlockData} blockData */
    verifyBlockHashConformToDifficulty: (HashBitsAsString = '', blockData) => {
        if (typeof HashBitsAsString !== 'string') { throw new Error('Invalid HashBitsAsString'); }

        const { difficulty, timeDiffAdjustment, legitimacy, finalDifficulty } = mining.getBlockFinalDifficulty(blockData);
        const { zeros, adjust } = mining.decomposeDifficulty(finalDifficulty);

        const result = { conform: false, message: 'na', difficulty, timeDiffAdjustment, legitimacy, finalDifficulty, zeros, adjust };

        const condition1 = conditionnals.binaryStringStartsWithZeros(HashBitsAsString, zeros);
        if (!condition1) { result.message = `unlucky--(condition 1)=> hash does not start with ${zeros} zeros | finalDifficulty: ${finalDifficulty} | HashBitsAsString: ${HashBitsAsString}` };

        const next5Bits = HashBitsAsString.substring(zeros, zeros + 5);
        const condition2 = conditionnals.binaryStringSupOrEqual(next5Bits, adjust);
        if (!condition2) { result.message = `unlucky--(condition 2)=> hash does not meet the condition: ${next5Bits} >= ${adjust} | finalDifficulty: ${finalDifficulty} | HashBitsAsString: ${HashBitsAsString}` };

        if (result.message === 'na') { result.conform = true; result.message = 'lucky'; }
        return result;
    }
};

const devParams = {
    useDevArgon2: false,
    nbOfAccounts: 20,
    addressPrefix: 'W',
    masterHex: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00"
};

const utils = {
    blockchainSettings: SETTINGS,
    MINING_PARAMS,
    ed25519,
    base58Alphabet,
    isNode,
    cryptoLib,
    argon2: argon2Lib,
    newWorker,
    SETTINGS,
    ProgressLogger,
    addressUtils,
    utxoUtils,
    typeValidation,
    serializer,
    serializerFast,
    convert,
    fastConverter,
    compression,
    conditionnals,
    types,
    UTXO_RULES_GLOSSARY,
    mining,
    devParams
};

export default utils;