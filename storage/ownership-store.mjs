// @ts-check
import path from 'path';
import { ADDRESS } from '../types/address.mjs';
import { Converter, HashFunctions } from '../node/src/conCrypto.mjs';

export class OwnershipStorage {
	/** @type {Map<string, string | null>} */
	cache = new Map(); // clear on new block & undo block
	storage;
	get logger() { return this.storage.miniLogger; }
	converter = new Converter();

	/** @param {import('./storage.mjs').ContrastStorage} storage */
	constructor(storage) { this.storage = storage; }

	/** @param {string} pubKeyHash */
	#pathOfOwnership(pubKeyHash) { // 16 * 16 * 16 = 4096 folders per folder
		const fileName = pubKeyHash.slice(6, 32); // last 13 bytes of the public key hash
		const dirPath = path.join(this.storage.PATH.OWNERSHIPS, pubKeyHash.slice(0, 3), pubKeyHash.slice(3, 6));
		return { fileName, dirPath };
	}
	/** @param {string[]} pubKeysHex */
	getOwnedRootAddress(pubKeysHex) {
		const str = pubKeysHex.slice().sort().join(''); // sort
		const hash = HashFunctions.SHA256(str, 32).hashHex; // 16 bytes
		if (this.cache.has(hash)) return this.cache.get(hash);

		const { fileName, dirPath } = this.#pathOfOwnership(hash);
		const serializedAddress = this.storage.loadBinary(fileName, dirPath, false);
		const b58 = serializedAddress ? ADDRESS.bytesToAddress(serializedAddress) : null;
		this.cache.set(hash, b58);
		return b58;
	}
	/** @param {string[]} pubKeysHex @param {string} walletId */
	saveOwnership(pubKeysHex, walletId) {
		const str = pubKeysHex.slice().sort().join(''); // sort
		const hash = HashFunctions.SHA256(str, 32).hashHex; // 16 bytes
		const { fileName, dirPath } = this.#pathOfOwnership(hash);
		const serializedAddress = ADDRESS.addressToBytes(walletId);
		const b58 = ADDRESS.bytesToAddress(serializedAddress);
		if (this.cache.get(hash) !== null) throw new Error(`address should not been cached before saving ownership ! ${this.cache.get(hash)} - ${b58}`);
		this.cache.set(hash, b58);
		this.storage.saveBinary(fileName, serializedAddress, dirPath);
	}
	/** @param {string[]} pubKeysHex */
	deleteOwnership(pubKeysHex) {
		const str = pubKeysHex.slice().sort().join(''); // sort
		const hash = HashFunctions.SHA256(str, 32).hashHex; // 16 bytes
		const { fileName, dirPath } = this.#pathOfOwnership(hash);
		this.storage.deleteFile(`${fileName}.bin`, dirPath);
	}
}