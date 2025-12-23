// @ts-check
import { BlockUtils } from './block.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
//import { BlockchainStorage, AddressesTxsRefsStorage } from '../../storage/storage.mjs';
import { BlockchainStorage } from '../../storage/bc-store.mjs';
import { IdentityStore } from "../../storage/identity-store.mjs";
import { LedgersStorage } from '../../storage/ledgers-store.mjs';

/**
* @typedef {import("./mempool.mjs").MemPool} MemPool
* @typedef {import("./node.mjs").ContrastNode} ContrastNode
* @typedef {import("../../types/transaction.mjs").UTXO} UTXO
* @typedef {import("../../types/transaction.mjs").TxAnchor} TxAnchor
* @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
* @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
* @typedef {import("../../types/block.mjs").BlockMiningData} BlockMiningData
* @typedef {import("../../storage/ledgers-store.mjs").AddressLedger} AddressLedger */

export class Blockchain {
	/** @type {BlockFinalized | null} */	lastBlock = null;
	get currentHeight() { return this.blockStorage.lastBlockIndex; }
    miniLogger = new MiniLogger('blockchain');
	blockStorage;
	identityStore;
	ledgersStorage;

	/** @param {import('../../storage/storage.mjs').ContrastStorage} [storage] - ContrastStorage instance for node data persistence. */
	constructor(storage) {
		if (!storage) throw new Error('Blockchain constructor: storage is required.');
		this.blockStorage = new BlockchainStorage(storage);
		this.identityStore = new IdentityStore(this.blockStorage);
		this.ledgersStorage = new LedgersStorage(storage);
		if (this.currentHeight >= 0) this.lastBlock = this.getBlock() || null;
	}

	// API METHODS
	/** Adds a new confirmed block to the blockchain.
	 * - Everything should be roughly validated before calling this method.
	 * @param {BlockFinalized} block - The block to add.
	 * @param {TxAnchor[]} involvedAnchors - The list of UTXO anchors involved in the block.
	 * @param {Object<string, UTXO>} involvedUTXOs - The list of UTXO anchors involved in the block */
    addBlock(block, involvedAnchors, involvedUTXOs) {
		this.ledgersStorage.digestBlock(block, involvedUTXOs);
		this.identityStore.digestBlock(block, involvedUTXOs);
		this.blockStorage.addBlock(block, involvedAnchors);
		this.lastBlock = block;
		//this.miniLogger.log(`Block added: #${block.index}, hash=${block.hash.slice(0, 20)}...`, (m, c) => console.info(m, c));
    }
	getBlock(height = this.currentHeight) {
		const blockBytes = this.blockStorage.getBlockBytes(height)?.blockBytes;
		if (blockBytes) return serializer.deserialize.blockFinalized(blockBytes);
	}
	/** @param {TxAnchor[]} anchors @param {boolean} breakOnSpent Specify if the function should return null when a spent UTXO is found (early abort) */
	getUtxos(anchors, breakOnSpent = false) {
		return this.blockStorage.getUtxos(anchors, breakOnSpent);
	}
	undoBlock() {
		// TODO: undo Ledgers first
		this.blockStorage.undoBlock();
	}
	reset() {
        this.blockStorage.reset();
        this.ledgersStorage.reset();
        this.miniLogger.log('Blockchain & Ledgers erased', (m, c) => console.info(m, c));
    }

	// INTERNAL METHODS
}