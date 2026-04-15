// @ts-check

/**
 * @typedef {import('@pinkparrot/qsafe-sig').QsafeSigner} QsafeSigner
 * @typedef {import('@pinkparrot/qsafe-sig').QsafeHelper} QsafeHelper
 */

/** @type {import('@pinkparrot/qsafe-sig')} */
const Qsafe = typeof window !== 'undefined' // @ts-ignore
	? await import('../../qsafe-sig.browser.min.js')
	: await import('@pinkparrot/qsafe-sig');

export const { QsafeSigner, QsafeHelper, sha256, sha512 } = Qsafe;

/** @type {typeof import('hive-p2p')} */
const HiveP2P = typeof window !== 'undefined' // @ts-ignore
	? await import('../../hive-p2p.min.js')
	: await import('hive-p2p');
const { xxHash32, Converter, Argon2Unified, ed25519 } = HiveP2P;
export { xxHash32, Converter, Argon2Unified, ed25519 };

const argon2 = new Argon2Unified();
const converter = new Converter();
export const argon2Hash = argon2.hash;

export class HashFunctions {
	static Argon2 = argon2.hash;
	/** Return a hash of the input as Hexadecimal string @param {string | Uint8Array} input @param {number} minLength */
    static xxHash32 = (input, minLength = 8) => {
        const hashNumber = xxHash32(input);
        const hashHex = hashNumber.toString(16);
        const padding = '0'.repeat(minLength - hashHex.length);
        return `${padding}${hashHex}`;
    };
	/** @param {string | Uint8Array} message */
	static SHA256(message) {
		const messageUint8 = typeof message === 'string' ? converter.stringToBytes(message) : message;
		const hashBytes = sha256(messageUint8);
		const hashHex = converter.bytesToHex(hashBytes);
		return { hashBytes, hashHex };
	}
	/** @param {string | Uint8Array} message */
    static SHA512(message) {
		const messageUint8 = typeof message === 'string' ? converter.stringToBytes(message) : message;
		const hashBytes = sha512(messageUint8);
		const hashHex = converter.bytesToHex(hashBytes);
        return { hashBytes, hashHex };
    };
};
export class AsymetricFunctions {
	/** @type {QsafeSigner} */
	static verifierInstance;

	/** Verify a signature using Qsafe. Will throw an error if the signature is invalid
	 * @param {string | Uint8Array} message @param {string | Uint8Array} signature @param {string | Uint8Array} pubKeyHex */
	static async qsafeVerify(message, signature, pubKeyHex) {
		const verifier 		 = this.verifierInstance || await QsafeSigner.createFull();
		const toSignBytes 	 = typeof message === 'string' ? converter.hexToBytes(message) : message;
		const signatureBytes = typeof signature === 'string' ? converter.hexToBytes(signature) : signature;
		const pubKeyBytes 	 = typeof pubKeyHex === 'string' ? converter.hexToBytes(pubKeyHex) : pubKeyHex;
		const iValid = await verifier.verify(toSignBytes, signatureBytes, pubKeyBytes);
		if (!iValid) throw new Error('Invalid signature');
	}
};