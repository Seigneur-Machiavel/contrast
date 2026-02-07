// @ts-check

/** @type {typeof import('hive-p2p')} */
const HiveP2P = typeof window !== 'undefined' // @ts-ignore
	? await import('../../hive-p2p.min.js')
	: await import('hive-p2p');
const { xxHash32, Converter, Argon2Unified, ed25519 } = HiveP2P;
const argon2 = new Argon2Unified();
const converter = new Converter();

export const argon2Hash = argon2.hash;

export class HashFunctions {
    //static Argon2 = argon2Hash;
	static Argon2 = argon2.hash;
	/** @param {string | Uint8Array} input @param {number} minLength */
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
     * @param {string} privKeyHex - necessary to sign the message */
    static signMessage(messageHex, privKeyHex) {
        const result = { isValid: false, signatureHex: '', error: '' };
        if (typeof messageHex !== 'string') { result.error = 'Invalid message type'; return result; }
        if (typeof privKeyHex !== 'string') { result.error = 'Invalid privKeyHex type'; return result; }
        if (privKeyHex.length !== 64) { result.error = 'Hash must be 32 bytes long (hex: 64 chars)'; return result; }

		const messageBytes = converter.stringToBytes(messageHex);
		const privBytes = converter.hexToBytes(privKeyHex);
        const signature = ed25519.sign(messageBytes, privBytes);
        if (!signature) { result.error = 'Failed to sign the message'; return result; }
        
		result.signatureHex = converter.bytesToHex(signature);
		result.isValid = true;
		return result;
    }
    /** @param {string} signature @param {string} messageHex @param {string} pubKeyHex @returns {boolean} */
    static verifySignature(signature, messageHex, pubKeyHex) {
		const signatureBytes = converter.hexToBytes(signature);
        const messageBytes = converter.stringToBytes(messageHex);
		const pubKeyBytes = converter.hexToBytes(pubKeyHex);
		return ed25519.verify(signatureBytes, messageBytes, pubKeyBytes);
    }
};