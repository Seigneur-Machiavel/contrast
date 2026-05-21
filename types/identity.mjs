// @ts-check
import { QsafeHelper } from '../node/src/conCrypto.mjs';
import { BLOCKCHAIN_SETTINGS } from '../config/blockchain-settings.mjs';
import { serializer } from '../utils/serializer.mjs';

/** Build identity entry, used to declare/record the pubkey(s) associated with an address in the identities filed of a transaction, to be retrieved later for identity resolution.
 * @param {string[]} pubKeysHex @param {number} [threshold] (1b) number of required signatures for multi-sig */
export function buildEntry(pubKeysHex, threshold = 1) {
	if (threshold < 1) throw new Error(`buildEntry(): threshold must be at least 1`);
	if (pubKeysHex.length === 0) throw new Error(`buildEntry(): at least one pubkey is required`);
	if (pubKeysHex.length > BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig) throw new Error(`buildEntry(): maximum number of pubkeys is ${BLOCKCHAIN_SETTINGS.maxPubkeysPerMultiSig}`);
	if (threshold > 255) throw new Error(`buildEntry(): threshold cannot be higher than 255`);
	
	for (const pk of pubKeysHex)
		if (!QsafeHelper.checkFormat(serializer.converter.hexToBytes(pk)))
			throw new Error(`buildEntry(): invalid pubkey ${serializer.converter.hexToBytes(pk)}`);

	return serializer.serialize.identityEntry(threshold, pubKeysHex); // throws if non conform
}

export class Identity {
	/** only true for specialTx, blocks cross-tx usage */
	selfDeclared;
	address;
	pubKeysHex;
	threshold;

	/** @param {string} address @param {string[]} pubKeysHex @param {number} threshold */
	constructor(address, pubKeysHex, threshold, selfDeclared = false) {
		this.address = address;
		this.pubKeysHex = pubKeysHex;
		this.threshold = threshold;
		this.selfDeclared = selfDeclared;
	}
}

export class IdentitiesCache {
	/** Set of walletId who needs to be in tx witnesses @type {Set<string>} */
	requiredWitnesses = new Set();

	/** key: walletId, value: Identity @type {Map<string, Identity>} */
	identities = new Map();
	
	/** @param {string} walletId @param {string[]} pubKeysHex @param {number} threshold */
	set(walletId, pubKeysHex, threshold, selfDeclared = false) {
		if (this.identities.has(walletId)) throw new Error(`Identity for walletId ${walletId} already exists in cache`);
		this.identities.set(walletId, new Identity(walletId, pubKeysHex, threshold, selfDeclared));
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

export class QsafeVerifyTask {
	signable;
	pubKeysHex;
	signatures;

	/** @param {Uint8Array} signable @param {string[]} pubKeysHex @param {Set<string>} signatures */
	constructor(signable, pubKeysHex, signatures) {
		this.signable = signable;
		this.pubKeysHex = pubKeysHex;
		this.signatures = signatures;
	}
}