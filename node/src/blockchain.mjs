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
		if (this.currentHeight === -1) return; // FRESH CHAIN

		this.#ensureConsistency();
		this.lastBlock = this.getBlock() || null;
	}

	// API METHODS
	/** Adds a new confirmed block to the blockchain.
	 * - Everything should be roughly validated before calling this method.
	 * @param {BlockFinalized} block - The block to add.
	 * @param {TxAnchor[]} involvedAnchors - The list of UTXO anchors involved in the block.
	 * @param {Object<string, UTXO>} involvedUTXOs - The list of UTXO anchors involved in the block */
    addBlock(block, involvedAnchors, involvedUTXOs) {
		// SAVE IN ORDER: BLOCK_IDX, BLOCK_DATA, IDENTITIES, LEDGERS
		this.blockStorage.addBlock(block, involvedAnchors);
		// CRASH DURING SAVING OPERATION (TEST PURPOSES)
		//if (block.index === 5) throw new Error('Test error on block 5 saving');
		this.identityStore.digestBlock(block, involvedUTXOs);
		this.ledgersStorage.digestBlock(block, involvedUTXOs);
		this.lastBlock = block;
		//this.miniLogger.log(`Block added: #${block.index}, hash=${block.hash.slice(0, 20)}...`, (m, c) => console.info(m, c));
    }
	getBlock(height = this.currentHeight) {
		const blockBytes = this.blockStorage.getBlockBytes(height)?.blockBytes;
		if (blockBytes) return serializer.deserialize.blockFinalized(blockBytes);
	}
	/** @param {TxAnchor[]} anchors @param {boolean} breakOnSpent Specify to return null when a spent UTXO is found (early abort), default: false */
	getUtxos(anchors, breakOnSpent = false) {
		return this.blockStorage.getUtxos(anchors, breakOnSpent);
	}
	undoBlock() {
		// TODO: undo Ledgers first
		this.blockStorage.undoBlock();

		if (this.currentHeight === -1) this.reset();
		else this.lastBlock = this.getBlock() || null;
	}
	reset() {
        this.blockStorage.reset();
        this.ledgersStorage.reset();
		this.identityStore.reset();
        this.miniLogger.log('Blockchain & Ledgers erased', (m, c) => console.info(m, c));
    }

	// INTERNAL METHODS
	/** Ensure the blockchain storage consistency by checking the last block */
	#ensureConsistency() {
		// FIRST: CHECK BLOCKCHAIN FILE LENGTH MATCHES THE LAST INDEXED BLOCK OFFSET
		// IF: IDX = OK, BLOCKCHAIN = BAD => RESIZE BLOCKCHAIN AND UNDO IDX. (LEDGERS AND IDENTITIES SHOULD BE GOOD)
		const isLastBlockConsistent = this.blockStorage.checkBlockchainBytesLengthConsistency();
		if (!isLastBlockConsistent) { this.blockStorage.undoBlock(); return; }

		// SECOND: ENSURE IDENTITIES CONSISTENCY
		const block = this.getBlock(this.currentHeight);
		if (!block) throw new Error('Blockchain consistency check failed: unable to retrieve last block.');

		const { involvedAnchors, repeatedAnchorsCount } = BlockUtils.extractInvolvedAnchors(block, 'blockFinalized');
		if (repeatedAnchorsCount > 0) throw new Error('Blockchain consistency check failed: repeated UTXO anchors found in the last block.');

		const involvedUTXOs = this.getUtxos(involvedAnchors, false);
		if (!involvedUTXOs) throw new Error('Blockchain consistency check failed: unable to retrieve all involved UTXOs for the last block.');
		
		const discoveryAddresses = this.identityStore.digestBlock(block, involvedUTXOs);
		if (discoveryAddresses.length === 0) this.miniLogger.log('Blockchain identities check: no change', (m, c) => console.info(m, c));
		else this.miniLogger.log(`Blockchain identities check: ${discoveryAddresses.length} new identities patch`, (m, c) => console.info(m, c));
		
		// THIRD: ENSURE LEDGERS CONSISTENCY
		const applyCount = this.ledgersStorage.digestBlock(block, involvedUTXOs, true);
		if (applyCount === 0) this.miniLogger.log('Blockchain ledgers check: no change', (m, c) => console.info(m, c));
		else this.miniLogger.log(`Blockchain ledgers check: ${applyCount} ledgers patched`, (m, c) => console.info(m, c));
	}
}