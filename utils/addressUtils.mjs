import { xxHash32 } from '../libs/xxhash32.mjs';
import { convert, FastConverter } from './converters.mjs';
import { conditionnals } from './conditionnals.mjs';
/**
* @typedef {import("./conCrypto.mjs").argon2Hash} HashFunctions
*/

const fastConverter = new FastConverter();
class AddressTypeInfo {
    name = '';
    description = '';
    zeroBits = 0;
    nbOfSigners = 1;
};
export const addressUtils = {
    /*params: {
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
    },*/
    // BLOCK PROCESSING ARE TO LONG ON LOW CONFIG WITH PREVIOUS PARAMS, NEED TO LOWER THE MEMORY
    // 16 zeroBits is the maximum, NEVER BYPASS THIS VALUE!!!
    params: {
        argon2DerivationMemory: 2 ** 14,
        addressDerivationBytes: 16, // the hex return will be double this value -> 32 bytes
        addressBase58Length: 20, // -> 16 bytes using serializer
    },
    glossary: {
        W: { name: 'Weak', description: 'No condition', zeroBits: 0 },
        C: { name: 'Contrast', description: '64 times harder to generate', zeroBits: 6 }, // The standard
        P: { name: 'Pro', description: '1024 times harder to generate', zeroBits: 10 },
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