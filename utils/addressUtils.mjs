import { xxHash32, Converter } from 'hive-p2p';
import { conditionnals } from './conditionnals.mjs';

/**
* @typedef {import("../node/src/conCrypto.mjs").argon2Hash} argon2Hash
*/

const converter = new Converter();
export const addressUtils = {
    params: {
        argon2DerivationMemory: 2 ** 14,
        addressDerivationBytes: 16, // the hex return will be double this value -> 32 bytes
        addressBase58Length: 20, // -> 16 bytes using serializer
    },
    glossary: { // 16 zeroBits is the maximum, NEVER BYPASS THIS VALUE!!!
        W: { name: 'Weak', description: 'No condition', zeroBits: 0 },
        C: { name: 'Contrast', description: '64 times harder to generate', zeroBits: 6 }, // The standard
        P: { name: 'Pro', description: '1024 times harder to generate', zeroBits: 10 },
        U: { name: 'Ultimate', description: '65536 times harder to generate', zeroBits: 16 },
        M: { name: 'MultiSig', description: 'Multi-signature address', zeroBits: 0 }
    },

    /** This function uses an Argon2 hash function to perform a hashing operation.
     * @param {argon2Hash} argon2HashFunction
     * @param {string} pubKeyHex */
    deriveAddress: async (argon2HashFunction, pubKeyHex) => {
        const hex128 = pubKeyHex.substring(32, 64);
        const salt = pubKeyHex.substring(0, 32); // use first part as salt because entropy is lower

        const argon2hash = await argon2HashFunction(hex128, salt, addressUtils.params.argon2DerivationMemory, 1, 1, 2, addressUtils.params.addressDerivationBytes);
        if (!argon2hash) { console.error('Failed to hash the SHA-512 pubKeyHex'); return false; }

        const hex = argon2hash.hex;
        const addressBase58 = converter.hexToBase58(hex).substring(0, 20);
        return addressBase58;
    },
    /** ==> First verification, low computation cost. ( ALWAYS use this first )
     * - Control the length of the address and its first char
     * @param {string} addressBase58 - Address to validate */
    conformityCheck: (addressBase58) => {
        if (typeof addressBase58 !== 'string') { throw new Error('Invalid address type !== string'); }
        if (addressBase58.length !== 20) {
            throw new Error('Invalid address length !== 20'); }

        const firstChar = addressBase58.substring(0, 1);
        const addressTypeInfo = addressUtils.glossary[firstChar];
        if (addressTypeInfo === undefined) throw new Error(`Invalid address firstChar: ${firstChar}`);
        return 'Address conforms to the standard';
    },
    /** ==> Second verification, low computation cost. ( ALWAYS use conformity check first )
     * - (address + pubKeyHex) are concatenated and hashed with SHA-256 -> condition: start with zeros
     * @param {string} addressBase58 - Address to validate
     * @param {string} pubKeyHex - Public key to derive the address from */
    securityCheck: async (addressBase58, pubKeyHex = '') => {
        if (pubKeyHex.length !== 64) throw new Error('Invalid public key length !== 64');

        const firstChar = addressBase58.substring(0, 1);
        const addressTypeInfo = addressUtils.glossary[firstChar];
        if (addressTypeInfo === undefined) throw new Error(`Invalid address firstChar: ${firstChar}`);

        const addressBase58Bytes = converter.addressBase58ToBytes(addressBase58); // 16 bytes
        const addressBase58Hex = converter.bytesToHex(addressBase58Bytes);
        let mixedAddPubKeyHashHex = '';
        for (let i = 0; i < 8; i++) {
            let mixedPart = '';
            mixedPart += pubKeyHex.slice(i * 8, i * 8 + 4);
            mixedPart += addressBase58Hex.slice(i * 4, i * 4 + 4);
            mixedPart += pubKeyHex.slice(i * 8 + 4, i * 8 + 8);
            
            const hashNumber = xxHash32(mixedPart)
            mixedAddPubKeyHashHex += hashNumber.toString(16).padStart(8, '0');
        }

        if (mixedAddPubKeyHashHex.length !== 64) throw new Error('Failed to hash the address and the public key');
        
		const bitsString = Converter.hexToBits(mixedAddPubKeyHashHex, 'string');
        if (!bitsString) throw new Error('Failed to convert the public key to bits');

        const condition = conditionnals.binaryStringStartsWithZeros(bitsString, addressTypeInfo.zeroBits);
        if (!condition) throw new Error(`Address does not meet the security level ${addressTypeInfo.zeroBits} requirements`);
        return 'Address meets the security level requirements';
    },
    /** ==> Third verification, higher computation cost. ( ALWAYS use conformity check first )
     * - This function uses an Argon2 hash function to perform a hashing operation.
     * @param {HashFunctions} argon2HashFunction
     * @param {string} addressBase58 - Address to validate
     * @param {string} pubKeyHex - Public key to derive the address from */
    derivationCheck: async (argon2HashFunction, addressBase58, pubKeyHex = '') => {
        const derivedAddressBase58 = await addressUtils.deriveAddress(argon2HashFunction, pubKeyHex);
        if (!derivedAddressBase58) { console.error('Failed to derive the address'); return false; }

        return addressBase58 === derivedAddressBase58;
    },
	/** Format an address with a separator for better readability
	* @param {string} addressBase58 - Address to format
	* @param {string} separator - Separator to use (default: '.') */
    formatAddress: (addressBase58, separator = ('.')) => {
        if (typeof addressBase58 !== 'string') { return false; }
        if (typeof separator !== 'string') { return false; }

        // WWRMJagpT6ZK95Mc2cqh => WWRM-Jagp-T6ZK-95Mc-2cqh or WWRM.Jagp.T6ZK.95Mc.2cqh
        const formated = addressBase58.match(/.{1,4}/g).join(separator);
        return formated;
    },
};