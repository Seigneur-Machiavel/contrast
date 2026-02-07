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

	// BUILDERS
	/** @param {string} prefix @param {number} uint32 */
	static fromUint32(prefix, uint32) {
		const B58 = Converter.uint32ToB58(uint32, CRITERIA.B58_LENGTH);
		return new ADDRESS(prefix, B58, uint32);
	}
	/** @param {string} addressBase58 */
	static fromString(addressBase58) {
		const lastPartBase58 = addressBase58.substring(1);
		const uint32 = Converter.b58ToUint32(addressBase58.substring(1));
		return new ADDRESS(addressBase58.substring(0, 1), lastPartBase58, uint32);
	}
	/** @param {Uint8Array} uint8Array length: 5, first byte is prefix */
	static fromUint8Array(uint8Array) {
		const prefix = converter.bytesToString(uint8Array.slice(0, 1));
		const uint32 = converter.bytes4ToNumber(uint8Array.slice(1, 5));
		const B58 = Converter.uint32ToB58(uint32, CRITERIA.B58_LENGTH);
		return new ADDRESS(prefix, B58, uint32);
	}
	/** @param {string} pubKeyHex */
	static deriveB58(pubKeyHex) {
		const n = xxHash32(converter.hexToBytes(pubKeyHex));
		return Converter.uint32ToB58(n, CRITERIA.B58_LENGTH);
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
		const val = Converter.b58ToUint32(addressBase58.substring(1));
		return (val <= CRITERIA.MAX_NUM_VALUE);
	}
	/** Perform security check of the address by deriving it from the public key
	 * @param {string} addressBase58 - Address to validate @param {string} pubKeyHex - Public key to derive the address from */
	static isDerivedFrom(addressBase58, pubKeyHex) {
		const val = Converter.b58ToUint32(addressBase58.substring(1));
		const n = xxHash32(converter.hexToBytes(pubKeyHex));
		return val === n;
	}

	// HELPERS
	/** @param {string} addressBase58 */
	static B58_TO_BYTES(addressBase58) {
		const bytes = new Uint8Array(5);
		const uint32 = Converter.b58ToUint32(addressBase58.substring(1));
		bytes.set(converter.stringToBytes(addressBase58.substring(0, 1)), 0);
		bytes.set(converter.numberTo4Bytes(uint32), 1);
		return bytes;
	}
	/** @param {Uint8Array} bytes length: 5, first byte is prefix */
	static BYTES_TO_B58(bytes) {
		const prefix = converter.bytesToString(bytes.slice(0, 1));
		const uint32 = converter.bytes4ToNumber(bytes.slice(1, 5));
		return prefix + Converter.uint32ToB58(uint32, CRITERIA.B58_LENGTH);
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