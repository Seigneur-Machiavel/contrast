/** @type {typeof import('hive-p2p')} */
const HiveP2P = typeof window !== 'undefined' // @ts-ignore
	? await import('../hive-p2p.min.js')
	: await import('hive-p2p');
const { xxHash32, Converter } = HiveP2P;
const converter = new Converter();

/** @type {Record<string, {name: string, description: string, multiSig: boolean} | undefined>} */
const LEXICON = {
	C: { name: 'Contrast Original Standard', description: 'The first batch of Contrast addresses', multiSig: false },
	//M: { name: 'Contrast Original MultiSig', description: 'Multi-signature Contrast addresses', multiSig: true },
}
const CRITERIA = { // WORK IN PROGRESS
	/** Number of bytes of the address (without the first character prefix) */
	B58_BYTES: 4,
	/** Total number of bytes of the address including the prefix */
	TOTAL_BYTES: 5,
	/** Length of the address in Base58 characters (without the first character prefix) */
	B58_LENGTH: 6,
	/** Length of the address in Base58 characters including the prefix */
	TOTAL_LENGTH: 7,
	/** Max numerical representation of the address */
	MAX_NUM_VALUE: 4_294_967_295 // 2^32-1
};

/*
	static #maxCacheSize = 100_000;
	static #b58ToUint32Cache = new Map();
	static b58ToUint32(str = '123456') {
		if (ADDRESS.#b58ToUint32Cache.has(str)) return ADDRESS.#b58ToUint32Cache.get(str);
		if (ADDRESS.#b58ToUint32Cache.size >= ADDRESS.#maxCacheSize) ADDRESS.#b58ToUint32Cache.clear();
		const result = Converter.b58ToUint32(str);
		ADDRESS.#b58ToUint32Cache.set(str, result);
		return result;
	}*/

class ConverterCache {
	maxCacheSize = 100_000;
	cache = new Map();

	get(key) { return this.cache.get(key); }
	set(key, value) {
		if (this.cache.size >= this.maxCacheSize) this.cache.clear();
		this.cache.set(key, value);
	}
}

export class ADDRESS {
	static AUTHORIZED_PREFIXES = new Set(Object.keys(LEXICON));
	static LEXICON = LEXICON;
	static CRITERIA = CRITERIA;
	static SAMPLE = 'C123456';
	get isMultiSig() { return ADDRESS.LEXICON[this.prefix]?.multiSig || false; }
	STRING = 'C123456'; 	// THE FULL ADDRESS STRING, 			length = 7
	B58 = '123456';			// THE BASE58 PART WITHOUT THE PREFIX, 	length = 6
	prefix = 'C';			// THE PREFIX CHARACTER
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
	static #uint32ToB58Cache = new ConverterCache();
	static uint32ToB58(num = 0) {
		/** @type {string | undefined} */
		const cached = ADDRESS.#uint32ToB58Cache.get(num);
		if (cached !== undefined) return cached;

		const result = Converter.uint32ToB58(num, CRITERIA.B58_LENGTH);
		ADDRESS.#uint32ToB58Cache.set(num, result);
		return result;
	}
	static #bytesToB58Cache = new ConverterCache();
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
	/** @param {string} addressBase58 */
	static fromString(addressBase58) {
		if (typeof addressBase58 !== 'string') throw new Error('Address must be a string');
		if (addressBase58.length !== CRITERIA.TOTAL_LENGTH) throw new Error(`Address must be ${CRITERIA.TOTAL_LENGTH} characters long`);
		
		const firstChar = addressBase58.substring(0, 1);
		if (!ADDRESS.AUTHORIZED_PREFIXES.has(firstChar)) throw new Error(`Address must start with one of the following prefixes: ${[...ADDRESS.AUTHORIZED_PREFIXES].join(', ')}`);
		
		const lastPartBase58 = addressBase58.substring(1);
		const uint32 = ADDRESS.b58ToUint32(lastPartBase58);
		return new ADDRESS(firstChar, lastPartBase58, uint32);
	}
	/** @param {string} pubKeyHex */
	static deriveB58(pubKeyHex) {
		const uint32 = xxHash32(converter.hexToBytes(pubKeyHex));
		return ADDRESS.uint32ToB58(uint32);
	}

	// VALIDATORS
	/** Check if the address conforms to the criteria @param {string} addressBase58 - Address to validate */
	static checkConformity(addressBase58) {
		if (typeof addressBase58 !== 'string') return false;
		if (addressBase58.length !== CRITERIA.TOTAL_LENGTH) return false;

		// CONTROL FIRST CHAR EXISTS IN LEXICON
		const firstChar = addressBase58.substring(0, 1);
		if (!ADDRESS.AUTHORIZED_PREFIXES.has(firstChar)) return false;
		
		/// CONTROL NUMERICAL VALUE OF THE ADDRESS IS UNDER MAX VALUE
		const val = ADDRESS.b58ToUint32(addressBase58.substring(1));
		return (val <= CRITERIA.MAX_NUM_VALUE);
	}
	/** Perform security check of the address by deriving it from the public key
	 * @param {string} addressBase58 - Address to validate @param {string} pubKeyHex - Public key to derive the address from */
	static isDerivedFrom(addressBase58, pubKeyHex) {
		const val = ADDRESS.b58ToUint32(addressBase58.substring(1));
		const uint32 = xxHash32(converter.hexToBytes(pubKeyHex));
		return val === uint32;
	}

	// HELPERS
	/** @param {string} addressBase58 */
	static B58_TO_BYTES(addressBase58) {
		const bytes = new Uint8Array(5);
		const uint32 = ADDRESS.b58ToUint32(addressBase58.substring(1));
		bytes.set(converter.stringToBytes(addressBase58.substring(0, 1)), 0);
		bytes.set(converter.numberTo4Bytes(uint32), 1);
		return bytes;
	}
	/** @param {Uint8Array} bytes length: 5, first byte is prefix */
	static BYTES_TO_B58(bytes) {
		//const prefix = converter.bytesToString(bytes.slice(0, 1));
		//const uint32 = converter.bytes4ToNumber(bytes.slice(1, 5));
		//return prefix + ADDRESS.uint32ToB58(uint32);

		const uint32 = (bytes[4] << 24 | bytes[3] << 16 | bytes[2] << 8 | bytes[1]) >>> 0; // LE
		const key = bytes[0] * 0x100000000 + uint32; // unique per prefix+uint32

		/** @type {string | undefined} */
		const cached = ADDRESS.#bytesToB58Cache.get(key);
		if (cached !== undefined) return cached;

		const prefix = converter.bytesToString(bytes.slice(0, 1));
		const B58 = ADDRESS.uint32ToB58(uint32);
		const result = prefix + B58;
		ADDRESS.#bytesToB58Cache.set(key, result);
		return result;
	}
	/** Format an address with a separator for better readability, ex: C123456 -> C1-23456
	* @param {string} addressBase58 - Address to format @param {string} separator - Separator to use (default: '-') */
	static formatAddress(addressBase58, separator = ('-')) {
		if (typeof addressBase58 !== 'string') return false;
		if (typeof separator !== 'string') return false;

		const prefix = addressBase58.substring(0, 2);
		const rest = addressBase58.substring(2);
		return prefix + separator + rest;
	}
	/** @param {string} addressBase58 */
	static isMultiSigAddress(addressBase58) {
		const prefix = addressBase58.substring(0, 1);
		return ADDRESS.LEXICON[prefix]?.multiSig || false;
	}
}