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
	SUFFIX_BYTES: 4,
	/** Total number of bytes of the address including the prefix */
	BYTES_LENGTH: 5,
	/** Length of the address in Base58 characters (without the first character prefix)
	 * - 1 char prefix => 6 next characters (e.g. C + 123456)
	 * - 2 chars prefix => 5 next characters (e.g. M1 + 5 chars) */
	SUFFIX_LENGTH: { p1: 6, p2: 5 },
	/** Length of the address in Base58 characters including the prefix */
	STRING_LENGTH: 7,
	/** Max numerical representation of the address
	 * - - 1 char prefix => 6 chars Base58 => 4 bytes => max value = 2^32-1 = 4,294,967,295 (TODO: HARD LIMIT based on b58 => 38 068 692 544 / 9)
	 * - - 2 chars prefix => 5 chars Base58 => 4 bytes => max value = max encoded 5 chars Base58 = 656,356,768 */
	MAX_NUM_VALUE: { p1: 0xFFFFFFFF, p2: 656356768 },
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

	// CACHES
	static #suffixToUint32Cache = new ConverterCache();
	static suffixToUint32(str = '123456') {
		/** @type {number | undefined} */
		const cached = ADDRESS.#suffixToUint32Cache.get(str);
		if (cached !== undefined) return cached;

		const result = Converter.b58ToUint32(str);
		ADDRESS.#suffixToUint32Cache.set(str, result);
		return result;
	}
	static #uint32ToSuffixCaches = { p1: new ConverterCache(), p2: new ConverterCache() };
	static uint32ToSuffix(num = 0, prefixLength = 1) {
		/** @type {string | undefined} */
		const cached = prefixLength === 1
			? ADDRESS.#uint32ToSuffixCaches.p1.get(num)
			: ADDRESS.#uint32ToSuffixCaches.p2.get(num);
		if (cached !== undefined) return cached;

		const b58Length = prefixLength === 1 ? CRITERIA.SUFFIX_LENGTH.p1 : CRITERIA.SUFFIX_LENGTH.p2;
		const result = Converter.uint32ToB58(num, b58Length);
		if (prefixLength === 1) ADDRESS.#uint32ToSuffixCaches.p1.set(num, result);
		else ADDRESS.#uint32ToSuffixCaches.p2.set(num, result);
		return result;
	}

	// HELPERS
	static #addressToBytesCache = new ConverterCache();
	/** @param {string} addressBase58 */
	static addressToBytes(addressBase58) {
		/** @type {Uint8Array | undefined} */
		const cached = ADDRESS.#addressToBytesCache.get(addressBase58);
		if (cached !== undefined) return cached;

		const bytes = new Uint8Array(5);
		const { prefix, suffix } = ADDRESS.splitAddress(addressBase58);
		const uint32 = ADDRESS.suffixToUint32(suffix);
		bytes.set([PREFIX_CODES[prefix]], 0);
		bytes.set(converter.numberTo4Bytes(uint32), 1);
		
		ADDRESS.#addressToBytesCache.set(addressBase58, bytes);
		return bytes;
	}

	static #bytesToAddressCache = new ConverterCache();
	/** @param {Uint8Array} bytes length: 5, first byte is prefix */
	static bytesToAddress(bytes) {
		if (bytes.length !== CRITERIA.BYTES_LENGTH) throw new Error('Invalid bytes length!');
		
		const key = bytes[0] * 0x100000000 + converter.bytes4ToNumber(bytes.subarray(1));
		/** @type {string | undefined} */
		const cached = ADDRESS.#bytesToAddressCache.get(key);
		if (cached !== undefined) return cached;

		const prefix = PREFIXES_LIST[bytes[0]];
		const uint32 = converter.bytes4ToNumber(bytes.subarray(1));
		const result = prefix + ADDRESS.uint32ToSuffix(uint32, prefix.length);
		ADDRESS.#bytesToAddressCache.set(key, result);
		return result;
	}

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
		const prefix = addressBase58[0] === 'M' ? addressBase58.slice(0, 2) : addressBase58[0]; // Handle multisig prefix (M1, M2, ...)
		const suffix = addressBase58.slice(prefix.length);
		return { prefix, suffix };
	}

	/** @param {string} addressBase58 */
	static getAddressRoot(addressBase58) {
		const { prefix, suffix } = ADDRESS.splitAddress(addressBase58);
		const uint32 = ADDRESS.suffixToUint32(suffix);
		const remainder = uint32 % CRITERIA.ADDRESSES_PER_ROOT;
		if (remainder === 0) return { prefix, rootSuffix: suffix, rootUint32: uint32, walletId: addressBase58 };

		const rootUint32 = uint32 - remainder;
		const rootSuffix = ADDRESS.uint32ToSuffix(rootUint32, prefix.length);
		return { prefix, rootSuffix, rootUint32, walletId: `${prefix}${rootSuffix}` };
	}
	/** @param {string} addressBase58 */
	static isRootAddress(addressBase58) {
		const { prefix, suffix } = ADDRESS.splitAddress(addressBase58);
		const uint32 = ADDRESS.suffixToUint32(suffix);
		return uint32 % CRITERIA.ADDRESSES_PER_ROOT === 0;
	}

	/** Returns all addresses associated with walletId (e.g. C111111 => C111111, C111112, ..., C111119) @param {string} walletId */
	static getAddressesFromWalletId(walletId) {
		const { prefix, suffix } = ADDRESS.splitAddress(walletId);
		const uint32 = ADDRESS.suffixToUint32(suffix);
		if (uint32 % CRITERIA.ADDRESSES_PER_ROOT !== 0) throw new Error('Address is not a root address');

		const addresses = [walletId];
		for (let i = 1; i < CRITERIA.ADDRESSES_PER_ROOT; i++)
			addresses.push(`${prefix}${ADDRESS.uint32ToSuffix(uint32 + i, prefix.length)}`);

		return addresses;
	}

	/** Check if the address conforms to the criteria @param {string} addressBase58 - Address to validate */
	static checkConformity(addressBase58) {
		if (typeof addressBase58 !== 'string') return false;
		if (addressBase58.length !== CRITERIA.STRING_LENGTH) return false;

		// CONTROL FIRST CHAR EXISTS IN LEXICON
		const { prefix, suffix } = ADDRESS.splitAddress(addressBase58);
		if (!ADDRESS.#AUTHORIZED_PREFIXES.has(prefix)) return false;

		/// CONTROL NUMERICAL VALUE OF THE ADDRESS IS UNDER MAX VALUE
		const val = ADDRESS.suffixToUint32(suffix);
		const maxVal = prefix.length === 1 ? CRITERIA.MAX_NUM_VALUE.p1 : CRITERIA.MAX_NUM_VALUE.p2;
		return val <= maxVal;
	}
}