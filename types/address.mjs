// @ts-check
import { Converter } from '../node/src/conCrypto.mjs';
const converter = new Converter();

/** @type {Record<string, {description: string, threshold: number}>} */
const LEXICON = {
	C: { description: 'Standard Contrast addresses', threshold: 1 },
	M1: { description: 'Multisig Contrast addresses', threshold: 1 },
	M2: { description: 'Multisig Contrast addresses', threshold: 2 },
	M3: { description: 'Multisig Contrast addresses', threshold: 3 },
	M4: { description: 'Multisig Contrast addresses', threshold: 4 },
	M5: { description: 'Multisig Contrast addresses', threshold: 5 },
	M6: { description: 'Multisig Contrast addresses', threshold: 6 },
	M7: { description: 'Multisig Contrast addresses', threshold: 7 },
	M8: { description: 'Multisig Contrast addresses', threshold: 8 },
	M9: { description: 'Multisig Contrast addresses', threshold: 9 },
	Ma: { description: 'Multisig Contrast addresses', threshold: 10 },
	// CAUTION: ONLY APPEND NEW PREFIXES, DO NOT MODIFY OR DELETE EXISTING ONES (to avoid breaking changes)
}
const PREFIXES_LIST = Object.keys(LEXICON);
/** { C: 0, M1: 1, M2: 2, ... } @type {Record<string, number>} */
const PREFIX_CODES = {};
for (let i = 0; i < PREFIXES_LIST.length; i++) PREFIX_CODES[PREFIXES_LIST[i]] = i;

const CRITERIA = { // WORK IN PROGRESS
	/** Number of addresses generated per uint32 pointer in the identity file
	 * e.g. root: C111111 => handle C111111 to C111119 */
	ADDRESSES_PER_ROOT: 9,
	/** Number of bytes of the address (without the first character prefix) */
	B58_BYTES: 4,
	/** Total number of bytes of the address including the prefix */
	TOTAL_BYTES: 5,
	/** Length of the address in Base58 characters (without the first character prefix)
	 * - 1 char prefix => 6 next characters (e.g. C + 123456)
	 * - 2 chars prefix => 5 next characters (e.g. M1 + 5 chars) */
	B58_LENGTH: { suffix1: 6, suffix2: 5 },
	/** Length of the address in Base58 characters including the prefix */
	TOTAL_LENGTH: 7,
	/** Max numerical representation of the address
	 * - - 1 char prefix => 6 chars Base58 => 4 bytes => max value = 2^32-1 = 4,294,967,295 (TODO: HARD LIMIT based on b58 => 38 068 692 544 / 9)
	 * - - 2 chars prefix => 5 chars Base58 => 4 bytes => max value = max encoded 5 chars Base58 = 656,356,768 */
	MAX_NUM_VALUE: { suffix1: 0xFFFFFFFF, suffix2: 656356768 },
};

class ConverterCache {
	maxCacheSize = 100_000;
	cache = new Map();

	/** @param {string | number} key */
	get(key) { return this.cache.get(key); }
	/** @param {string | number} key @param {any} value */
	set(key, value) {
		if (this.cache.size >= this.maxCacheSize) this.cache.clear();
		this.cache.set(key, value);
	}
}

export class ADDRESS {
	static #AUTHORIZED_PREFIXES = new Set(PREFIXES_LIST);
	static LEXICON = LEXICON;
	static CRITERIA = CRITERIA;
	get isMultiSig() { return this.prefix.startsWith('M'); }
	STRING = 'C123456'; 	// THE FULL ADDRESS STRING, 			length = 7
	B58 = '123456';			// THE BASE58 PART WITHOUT THE PREFIX, 	length = 6/5
	prefix = 'C';			// THE PREFIX CHARACTERS				length = 1/2
	uint32 = 0;				// THE NUMERICAL REPRESENTATION OF THE ADDRESS
	bytes; 					// THE ADDRESS AS BYTES (1 byte prefix + 4 bytes number)

	/** @param {string} prefix @param {string} B58 @param {number} uint32 */
	constructor(prefix, B58, uint32) {
		this.B58 = B58;
		this.prefix = prefix;
		this.uint32 = uint32;
		this.STRING = prefix + B58;
		this.bytes = new Uint8Array(5);
		this.bytes.set(converter.stringToBytes(prefix), 0);
		this.bytes.set(converter.numberTo4Bytes(uint32), 1);
	}

	// CACHES
	static #b58ToUint32Cache = new ConverterCache();
	static b58ToUint32(str = '123456') {
		/** @type {number | undefined} */
		const cached = ADDRESS.#b58ToUint32Cache.get(str);
		if (cached !== undefined) return cached;
		
		const result = Converter.b58ToUint32(str);
		ADDRESS.#b58ToUint32Cache.set(str, result);
		return result;
	}
	static #uint32ToB58Caches = { suffix1: new ConverterCache(), suffix2: new ConverterCache() };
	static uint32ToB58(num = 0, prefixLength = 1) {
		/** @type {string | undefined} */
		const cached =  prefixLength === 1
			? ADDRESS.#uint32ToB58Caches.suffix1.get(num)
			: ADDRESS.#uint32ToB58Caches.suffix2.get(num);
		if (cached !== undefined) return cached;

		const b58Length = prefixLength === 1 ? CRITERIA.B58_LENGTH.suffix1 : CRITERIA.B58_LENGTH.suffix2;
		const result = Converter.uint32ToB58(num, b58Length);
		if (prefixLength === 1) ADDRESS.#uint32ToB58Caches.suffix1.set(num, result);
						   else ADDRESS.#uint32ToB58Caches.suffix2.set(num, result);
		return result;
	}
	static #bytesToB58Cache = new ConverterCache();
	/** @param {Uint8Array} bytes length: 5, first byte is prefix */
	static bytesToB58(bytes) {
		const key = converter.bytesToHex(bytes);
		/** @type {string | undefined} */
		const cached = ADDRESS.#bytesToB58Cache.get(key);
		if (cached !== undefined) return cached;

		const result = ADDRESS.BYTES_TO_B58(bytes);
		ADDRESS.#bytesToB58Cache.set(key, result);
		return result;
	}

	// BUILDERS
	//** @param {string} addressBase58 */
	/*static fromString(addressBase58) {
		if (typeof addressBase58 !== 'string') throw new Error('Address must be a string');
		if (addressBase58.length !== CRITERIA.TOTAL_LENGTH) throw new Error(`Address must be ${CRITERIA.TOTAL_LENGTH} characters long`);
		
		const { prefix, lastPartBase58 } = ADDRESS.splitAddress(addressBase58);
		if (!ADDRESS.#AUTHORIZED_PREFIXES.has(prefix)) throw new Error(`Address must start with one of the following prefixes: ${[...ADDRESS.#AUTHORIZED_PREFIXES].join(', ')}`);
		
		const uint32 = ADDRESS.b58ToUint32(lastPartBase58);
		return new ADDRESS(prefix, lastPartBase58, uint32);
	}*/

	// HELPERS
	/** Get the prefix for a multisig address based on its threshold @param {number} threshold */
	static getPrefixForMultisig(threshold) {
		if (threshold < 1 || threshold > 10) throw new Error('Multisig threshold must be between 1 and 10');
		return 'M' + threshold;
	}
	/** All multisig addresses start with 'M', followed by a number indicating the threshold @param {string} addressBase58 */
	static isMultiSigAddress(addressBase58) {
		return addressBase58.startsWith('M');
	}
	/** @param {string} addressBase58 */
	static splitAddress(addressBase58) {
		const firstChar = addressBase58.substring(0, 1);
		const prefix = firstChar === 'M' ? addressBase58.substring(0, 2) : firstChar; // Handle multisig prefix (M1, M2, ...)
		const lastPartBase58 = addressBase58.substring(prefix.length);
		return { prefix, lastPartBase58 };
	}
	/** @param {string} addressBase58 */
	static getAddressRoot(addressBase58) {
		const { prefix, lastPartBase58 } = ADDRESS.splitAddress(addressBase58);
		const uint32 = ADDRESS.b58ToUint32(lastPartBase58);
		const remainder = uint32 % CRITERIA.ADDRESSES_PER_ROOT;
		const rootUint32 = uint32 - remainder;
		const rootB58 = ADDRESS.uint32ToB58(rootUint32, prefix.length);
		return { prefix, rootB58, rootUint32 };
	}
	/** Returns all addresses associated with root address (e.g. C111111 => C111111, C111112, ..., C111119) @param {string} rootAddressBase58 */
	static getAddressesFromRoot(rootAddressBase58) {
		const { prefix, lastPartBase58 } = ADDRESS.splitAddress(rootAddressBase58);
		const uint32 = ADDRESS.b58ToUint32(lastPartBase58);
		if (uint32 % CRITERIA.ADDRESSES_PER_ROOT !== 0) throw new Error('Address is not a root address');

		const addresses = [rootAddressBase58];
		for (let i = 1; i < CRITERIA.ADDRESSES_PER_ROOT; i++)
			addresses.push(`${prefix}${ADDRESS.uint32ToB58(uint32 + i, prefix.length)}`);

		return addresses;
	}

	/** Check if the address conforms to the criteria @param {string} addressBase58 - Address to validate */
	static checkConformity(addressBase58) {
		if (typeof addressBase58 !== 'string') return false;
		if (addressBase58.length !== CRITERIA.TOTAL_LENGTH) return false;

		// CONTROL FIRST CHAR EXISTS IN LEXICON
		const { prefix, lastPartBase58 } = ADDRESS.splitAddress(addressBase58);
		if (!ADDRESS.#AUTHORIZED_PREFIXES.has(prefix)) return false;
		
		/// CONTROL NUMERICAL VALUE OF THE ADDRESS IS UNDER MAX VALUE
		const val = ADDRESS.b58ToUint32(lastPartBase58);
		const maxVal = prefix.length === 1 ? CRITERIA.MAX_NUM_VALUE.suffix1 : CRITERIA.MAX_NUM_VALUE.suffix2;
		return val <= maxVal;
	}
	/** @param {string} addressBase58 */
	static B58_TO_BYTES(addressBase58) {
		const bytes = new Uint8Array(5);
		const { prefix, lastPartBase58 } = ADDRESS.splitAddress(addressBase58);
		const uint32 = ADDRESS.b58ToUint32(lastPartBase58);
		bytes.set([PREFIX_CODES[prefix]], 0);
		bytes.set(converter.numberTo4Bytes(uint32), 1);
		return bytes;
	}
	/** @param {Uint8Array} bytes length: 5, first byte is prefix */
	static BYTES_TO_B58(bytes) {
		const uint32 = (bytes[4] << 24 | bytes[3] << 16 | bytes[2] << 8 | bytes[1]) >>> 0; // LE
		const key = bytes[0] * 0x100000000 + uint32; // unique per prefix+uint32

		/** @type {string | undefined} */
		const cached = ADDRESS.#bytesToB58Cache.get(key);
		if (cached !== undefined) return cached;

		const prefix = PREFIXES_LIST[bytes[0]];
		const B58 = ADDRESS.uint32ToB58(uint32, prefix.length);
		const result = prefix + B58;
		ADDRESS.#bytesToB58Cache.set(key, result);
		return result;
	}
}