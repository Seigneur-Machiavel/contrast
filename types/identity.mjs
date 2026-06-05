// @ts-check
import { QsafeHelper } from '../node/src/conCrypto.mjs';
import { BLOCKCHAIN_SETTINGS } from '../config/blockchain-settings.mjs';
import { serializer } from '../utils/serializer.mjs';

/** 
 * @typedef {Object} 		QsafeVerifyTask
 * @property {Uint8Array} 	signable
 * @property {string[]} 	pubKeysHex
 * @property {Set<string>} 	signatures
 * 
 * @typedef {Object} 		Identity
 * @property {string} 		walletId The root wallet address (addressses[0])
 * @property {string[]} 	pubKeysHex The list of pubkeys able to sign
 * @property {number} 		threshold The required number of signature
 * @property {boolean}		selfDeclared Only true for specialTx, blocks cross-tx usage */

/** Build identity entry, used to declare/record the pubkey(s) associated with an address in the identities filed of a transaction, to be retrieved later for identity resolution.
 * @param {string[]} pubKeysHex @param {number} [threshold] (1b) number of required signatures for multi-sig */
export function buildEntry(pubKeysHex, threshold = 1) {
	if (threshold < 1) throw new Error(`buildEntry(): threshold must be at least 1`);
	if (pubKeysHex.length === 0) throw new Error(`buildEntry(): at least one pubkey is required`);
	if (pubKeysHex.length > BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig) throw new Error(`buildEntry(): maximum number of pubkeys is ${BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig}`);
	if (threshold > 255) throw new Error(`buildEntry(): threshold cannot be higher than 255`);
	
	for (const pk of pubKeysHex)
		if (!QsafeHelper.checkFormat(serializer.converter.hexToBytes(pk)))
			throw new Error(`buildEntry(): invalid pubKeyHex ${serializer.converter.hexToBytes(pk)}`);

	return serializer.serialize.identityEntry(threshold, pubKeysHex); // throws if non conform
}

export class IdentitiesCache {
	/** key: walletId, value: Identity @type {Map<string, Identity>} */
	identities = new Map();
	
	/** @param {string} walletId @param {string[]} pubKeysHex @param {number} threshold */
	set(walletId, pubKeysHex, threshold, selfDeclared = false) {
		if (this.identities.has(walletId)) throw new Error(`Identity for walletId ${walletId} already exists in cache`);
		this.identities.set(walletId, { walletId, pubKeysHex, threshold, selfDeclared });
	}
	
	/** @param {string} walletId */
	get(walletId) { return this.identities.get(walletId); }
}

/** Cache of the tx identity entries in a block to detect collision */
export class EntriesCache {
	/** @type {Uint8Array[]} */
	#cache = [];

	/** @param {Uint8Array} serializedEntry */
	set(serializedEntry) {
		this.#cache.push(serializedEntry);
	}
	/** @param {Uint8Array} serializedEntry */
	has(serializedEntry) {
		for (const s of this.#cache) {
			if (s.length !== serializedEntry.length) continue;
			if (s.every((byte, index) => byte === serializedEntry[index])) return true;
		}
		return false;
	}
}