// @ts-check

/**
 * @typedef {import('@pinkparrot/qsafe-sig').QsafeSigner} QsafeSigner
 * @typedef {import('@pinkparrot/qsafe-sig').QsafeHelper} QsafeHelper
 */

/** @type {import('@pinkparrot/qsafe-sig')} */
const Qsafe = typeof window !== 'undefined' // @ts-ignore
	? await import('@pinkparrot/qsafe-sig.min.js')
	: await import('@pinkparrot/qsafe-sig');

export const { QsafeSigner, QsafeHelper } = Qsafe;

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
	/** @param {string} message */
    static async SHA256(message) {
		const messageUint8 = converter.stringToBytes(message);
        const arrayBuffer = await crypto.subtle.digest('SHA-256', messageUint8);
        const uint8Array = new Uint8Array(arrayBuffer);
		const hashHex = converter.bytesToHex(uint8Array);
        return hashHex;
    };
};
export class AsymetricFunctions {
	/** @type {QsafeSigner} */
	static verifierInstance;

	/** Verify a signature using Qsafe. Will throw an error if the signature is invalid
	 * @param {string} message @param {string} signature @param {string} pubKeyHex */
	static async qsafeVerify(message, signature, pubKeyHex) {
		const verifier 		= this.verifierInstance || await QsafeSigner.createFull();
		const toSignBytes 	= converter.hexToBytes(message);
		const signtureBytes = converter.hexToBytes(signature);
		const pubKeyBytes 	= converter.hexToBytes(pubKeyHex);
		await verifier.verify(signtureBytes, toSignBytes, pubKeyBytes); // will throw an error if the signature is invalid
	}
};