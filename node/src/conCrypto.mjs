import { xxHash32, ed25519, Converter, Argon2Unified } from 'hive-p2p';
//import * as crypto from 'crypto';

const argon2 = new Argon2Unified();
const converter = new Converter();

/** This function hashes a password using Argon2
 * @param {string} pass - Password to hash
 * @param {string} salt - Salt to use for the hash
 * @param {number} time - Time cost in iterations
 * @param {number} mem - Memory usage in KiB
 * @param {number} parallelism - Number of threads to use
 * @param {number} type - 0: Argon2d, 1: Argon2i, 2: Argon2id
 * @param {number} hashLen - Length of the hash in bytes */
export const argon2Hash = async (pass, salt, time = 1, mem = 2**20, parallelism = 1, type = 2, hashLen = 32) => {
	const hashResult = await argon2.hash(pass, salt, mem, time, parallelism, type, hashLen);
    if (!hashResult) return false;
	else return hashResult;
};

export class HashFunctions {
    static Argon2 = argon2Hash;
    static xxHash32 = (input, minLength = 8) => {
        const hashNumber = xxHash32(input);
        const hashHex = hashNumber.toString(16);
        const padding = '0'.repeat(minLength - hashHex.length);
        return `${padding}${hashHex}`;
    };
    static async SHA256(message) {
		const messageUint8 = converter.stringToBytes(message);
        const arrayBuffer = await crypto.subtle.digest('SHA-256', messageUint8);
        const uint8Array = new Uint8Array(arrayBuffer);
		const hashHex = converter.bytesToHex(uint8Array);
        return hashHex;
    };
};
export class AsymetricFunctions {
    /** @param {string} privKeyHex - Hexadecimal representation of the private key */
    static generateKeyPairFromHash(privKeyHex) {
        if (privKeyHex.length !== 64) { console.error('Hash must be 32 bytes long (hex: 64 chars)'); return false; }
        
        // Calculate the public key from the private key
		const privKeyBytes = converter.hexToBytes(privKeyHex);
        const publicKey = ed25519.getPublicKey(privKeyBytes);
		const pubKeyHex = converter.bytesToHex(publicKey);
        return { privKeyHex, pubKeyHex };
    }
    /** Sign a message using Ed25519
     * @param {string} messageHex - Message to sign
     * @param {string} privKeyHex - necessary to sign the message
     * @param {string} pubKeyHex - (optional) can't confirm validity if not provided */
    static signMessage(messageHex, privKeyHex, pubKeyHex = undefined) {
        const result = { isValid: false, signatureHex: '', error: '' };
        if (typeof messageHex !== 'string') { result.error = 'Invalid message type'; return result; }
        if (typeof privKeyHex !== 'string') { result.error = 'Invalid privKeyHex type'; return result; }
        if (privKeyHex.length !== 64) { result.error = 'Hash must be 32 bytes long (hex: 64 chars)'; return result; }

        const signature = ed25519.sign(messageHex, privKeyHex);
        if (!signature) { result.error = 'Failed to sign the message'; return result; }
        
		result.signatureHex = converter.bytesToHex(signature);
		result.isValid = true;
		return result;
    }
    /** @param {string} signature @param {string} messageHex @param {string} pubKeyHex @returns {boolean} */
    static verifySignature(signature, messageHex, pubKeyHex) {
        return ed25519.verify(signature, messageHex, pubKeyHex);
    }
};