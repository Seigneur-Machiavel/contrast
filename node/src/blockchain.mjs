// @ts-check
import { Vss } from './vss.mjs';
import { BlockUtils } from './block.mjs';
import { solving } from '../../utils/conditionals.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { BlockValidation } from './block-validation.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
//import { BlockchainStorage, AddressesTxsRefsStorage } from '../../storage/storage.mjs';
import { BlockchainStorage } from '../../storage/bc-store.mjs';
import { IdentityStore } from "../../storage/identity-store.mjs";
import { LedgersStorage } from '../../storage/ledgers-store.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../config/blockchain-settings.mjs';

/**
* @typedef {import("./mempool.mjs").MemPool} MemPool
* @typedef {import("./node.mjs").ContrastNode} ContrastNode
* @typedef {import("../../types/transaction.mjs").UTXO} UTXO
* @typedef {import("../../types/transaction.mjs").TxAnchor} TxAnchor
* @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
* @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
* @typedef {import("../../types/block.mjs").BlockSolvingData} BlockSolvingData
* @typedef {import("../../storage/ledgers-store.mjs").AddressLedger} AddressLedger */

export class Blockchain {
	/** @type {BlockFinalized | null} */	lastBlock = null;
	get currentHeight() { return this.blockStorage.lastBlockIndex; }
    logger = new MiniLogger('blockchain');
	vss;
	storage;
	blockStorage;
	identityStore;
	ledgersStorage;
	simulateFailureRate = 0; // for testing purposes (0 === no failure, 1 === always fail)

	/** @param {import('../../storage/storage.mjs').ContrastStorage} [storage] - ContrastStorage instance for node data persistence. */
	constructor(storage) {
		if (!storage) throw new Error('Blockchain constructor: storage is required.');
		this.storage = storage;
		this.blockStorage = new BlockchainStorage(storage);
		this.identityStore = new IdentityStore(this.blockStorage);
		this.ledgersStorage = new LedgersStorage(storage);
		this.vss = new Vss(this, storage);
	}
	
	async initialize() {
		if (this.currentHeight === -1) return; // FRESH CHAIN
		await this.#ensureConsistency();
		this.lastBlock = this.getBlock() || null;
	}

	// API METHODS
	/** Digest and apply a finalized block to the blockchain.
	 * @param {ContrastNode} node @param {Uint8Array} serializedBlock - The serialized finalized block.
     * @param {Object} [options] - Configuration options for the blockchain.
     * @param {boolean} [options.broadcastNewCandidate] - default: true
     * @param {boolean} [options.isSync] - default: false */
    async digestFinalizedBlock(node, serializedBlock, options = {}) {
		let block;
		const startTime = performance.now();
		const statePrefix = options.isSync ? '(syncing) ' : '';
		const { broadcastNewCandidate = true, isSync = false } = options;

		if (this.currentHeight > 10 && Math.random() < this.simulateFailureRate)
			return console.log(`%c[DEBUG] Simulated failure of digestFinalizedBlock #${this.currentHeight}`, 'color: orange;');
		
		// let blockIndex = null;
		try {
			// VALIDATE BLOCK
			if (serializedBlock.length > BLOCKCHAIN_SETTINGS.maxBlockSize) throw new Error('Block size exceeds the maximum limit');
			block = serializer.deserialize.blockFinalized(serializedBlock);
			// blockIndex = block.index;
			node.updateState(`${statePrefix}block-validation #${block.index}`);
			const validationResult = await BlockValidation.validateBlockProposal(node, block, serializedBlock);
			const { hashConfInfo, involvedAnchors, involvedUTXOs } = validationResult;
			if (!hashConfInfo?.conform) throw new Error('Failed to validate block');
			this.vss.digestBlockStakes(block, 'control'); // throw if invalid stakes
	
			// APPLY BLOCK (SYNC)
			node.updateState(`${statePrefix}applying finalized block #${block.index}`);
			this.#addBlock(block, involvedAnchors, involvedUTXOs);
			
			// APPLY LEDGERS CHANGES (ASYNC)
			//await this.ledgersStorage.digestBlock(block, involvedUTXOs, 'APPLY');
			this.ledgersStorage.digestBlockSync(block, involvedUTXOs, 'APPLY'); // prefer sync
			this.ledgersStorage.cache.clear();
			node.memPool.removeFinalizedBlocksTransactions(block);
			
			const timeBetweenPosPow = ((block.timestamp - block.posTimestamp) / 1000).toFixed(2);
			const [solverAddress, validatorAddress] = [block.Txs[0].outputs[0].address, block.Txs[1].outputs[0].address];
			this.logger.log(`${statePrefix}#${block.index} (${block.Txs.length} Txs, ${validationResult.size} bytes, ${(performance.now() - startTime).toFixed(2)} ms) -> {v: ${validatorAddress} | m: ${solverAddress}} - (diff[${hashConfInfo.difficulty}]+timeAdj[${hashConfInfo.timeDiffAdjustment}]+leg[${hashConfInfo.legitimacy}])=${hashConfInfo.finalDifficulty} | z: ${hashConfInfo.zeros} | a: ${hashConfInfo.adjust} | PosPow: ${timeBetweenPosPow}s`, (m, c) => console.info(m, c));
			node.updateState("idle", "applying finalized block");
			node.sync.setAndshareMyStatus(block);
		} catch (/** @type {any} */ error) {
			const shouldLogMsgOnly = error.message.includes('invalid prevHash:')
									|| error.message.includes('last+1')
									|| error.message.includes('(outdated)');
			if (shouldLogMsgOnly) this.logger.log(`[DFB] ${error.message}`, (m, c) => console.error(m, c));

			const isOffense = error.message.startsWith('!applyOffense!');
			if (isOffense) this.logger.log(`[DFB] !!! Offense detected: ${error.message}`, (m, c) => console.warn(m, c));
			else if (!isSync) await node.sync.catchUpWithNetwork();
			return false;
		}

		// EXEC CALLBACK
		try { await node.callbacks.onBlockConfirmed?.(block);
		} catch (/** @type {any} */ error) { this.logger.log(`onBlockConfirmed callback error: ${error.message}`, (m, c) => console.error(m, c)); }

		// UPDATE NODE INFO
		if (node.controller?.sharedSecret && block.index >= 12) {
			const headers = this.blockStorage.getBlocksHeaders(block.index - 12, block.index);
			if (headers) node.solver.networkPower = solving.estimateGlobalHashrate(headers);
		}
		if (node.controller?.sharedSecret && node.rewardsInfo.sAddress)
			node.rewardsInfo.sBalance = (await this.ledgersStorage.getAddressLedger(node.rewardsInfo.sAddress))?.balance || 0;
		if (node.controller?.sharedSecret && node.rewardsInfo.vAddress)
			node.rewardsInfo.vBalance = (await this.ledgersStorage.getAddressLedger(node.rewardsInfo.vAddress))?.balance || 0;

		// CREATE AND SHARE NEW CANDIDATE AFTER A SHORT DELAY
		if (broadcastNewCandidate && !isSync) {
			const delay = Math.round(BLOCKCHAIN_SETTINGS.targetBlockTime / 12);
			node.timeouts.createAndShareBlockCandidate = setTimeout(() => node.createAndShareMyBlockCandidate(), delay);
		}

		return true;
    }
	/** Adds a new confirmed block to the blockchain.
	 * - Everything should be roughly validated before calling this method.
	 * @param {BlockFinalized} block - The block to add.
	 * @param {TxAnchor[]} involvedAnchors - The list of UTXO anchors involved in the block.
	 * @param {Object<string, UTXO>} involvedUTXOs - The list of UTXO anchors involved in the block */
    #addBlock(block, involvedAnchors, involvedUTXOs) {
		// SAVE IN ORDER: BLOCKCHAIN > IDENTITIES > LEDGERS > VSS (STAKE CHANGES SHOULD BE LAST TO BE SURE THEY ARE TAKEN INTO ACCOUNT IN CASE OF FAILURE DURING THE PROCESS)
		this.blockStorage.store(block, involvedAnchors);
		// CRASH DURING SAVING OPERATION (TEST PURPOSES)
		//if (block.index === 5) throw new Error('Test error on block 5 saving');
		this.identityStore.digestBlock(block);
		this.vss.digestBlockStakes(block, 'persist');

		this.lastBlock = block;
		//this.logger.log(`Block added: #${block.index}, hash=${block.hash.slice(0, 20)}...`, (m, c) => console.info(m, c));
    }
	getBlock(height = this.currentHeight) {
		const blockBytes = this.blockStorage.getBlockBytes(height)?.blockBytes;
		if (blockBytes) return serializer.deserialize.blockFinalized(blockBytes);
	}
	/** @param {TxAnchor} anchor */
	getUtxo(anchor) {
		return this.getUtxos([anchor], true)?.[anchor] || null;
	}
	/** @param {TxAnchor[]} anchors @param {boolean} breakOnSpent Specify to return null when a spent UTXO is found (early abort), default: false */
	getUtxos(anchors, breakOnSpent = false) {
		return this.blockStorage.getUtxos(anchors, breakOnSpent);
	}
	async undoBlock(resetOnFailure = false) {
		const block = this.lastBlock;
		if (!block)
			if (resetOnFailure) return this.reset('Blockchain.undoBlock: no block to undo.');
			else throw new Error('Blockchain.undoBlock: no block to undo.');
		
		if (block.index !== this.currentHeight)
			if (resetOnFailure) return this.reset('Blockchain.undoBlock: last block index mismatch.');
			else throw new Error(`Blockchain.undoBlock: last block index mismatch.`);
		
		const { involvedAnchors, repeatedAnchorsCount } = BlockUtils.extractInvolvedAnchors(block, 'blockFinalized');
		const involvedUTXOs = this.getUtxos(involvedAnchors, false);
		if (!involvedUTXOs)
			if (resetOnFailure) return this.reset('Blockchain.undoBlock: unable to retrieve involved UTXOs.');
			else throw new Error('Blockchain.undoBlock: unable to retrieve all involved UTXOs for the last block.');

		// await this.ledgersStorage.revertBlock(block, involvedUTXOs, 'REVERT');
		this.ledgersStorage.digestBlockSync(block, involvedUTXOs, 'REVERT'); // prefer sync
		this.vss.revertBlockStakes(block);
		this.identityStore.revertBlock(block);
		this.blockStorage.unstore(involvedAnchors);
		
		this.ledgersStorage.cache.clear();
		this.logger.log(`Block undone: #${block.index}, hash=${block.hash.slice(0, 8)}..., currentHeight=#${this.currentHeight}`, (m, c) => console.info(m, c));
		if (this.currentHeight === -1) this.reset('Blockchain.undoBlock: no more blocks after undo.');
		else this.lastBlock = this.getBlock() || null;
	}
	reset(reason = '') {
		this.logger.log(`RESETTING BLOCKCHAIN... ${reason}`, (m, c) => console.warn(m, c));
		this.vss.reset();
        this.blockStorage.reset();
		this.identityStore.reset();
        this.ledgersStorage.reset();
		this.lastBlock = null;
        this.logger.log('BLOCKCHAIN RESET COMPLETE.', (m, c) => console.warn(m, c));
    }

	// INTERNAL METHODS
	/** Ensure the blockchain storage consistency by checking the last block */
	async #ensureConsistency() {
		// ZERO: if no blocks, just reset everything to be sure
		if (this.currentHeight === -1) { this.reset('#ensureConsistency: currentHeight === -1'); return; }

		/** @type {BlockFinalized | undefined} */
		let block = undefined;
		/** @type {string[] | undefined} */
		let involvedAnchors = undefined;
		let repeatedAnchorsCount = 0;

		// FIRST: CHECK BLOCKCHAIN FILE LENGTH MATCHES THE LAST INDEXED BLOCK OFFSET
		// IF: IDX = OK, BLOCKCHAIN = BAD => RESIZE BLOCKCHAIN AND UNDO IDX. (LEDGERS AND IDENTITIES SHOULD BE GOOD)
		const isLastBlockConsistent = this.blockStorage.checkBlockchainBytesLengthConsistency();
		try {
			block = this.getBlock(this.currentHeight);
			const extracted = block ? BlockUtils.extractInvolvedAnchors(block, 'blockFinalized') : undefined;
			involvedAnchors = extracted?.involvedAnchors;
			repeatedAnchorsCount = extracted?.repeatedAnchorsCount || 0;
		} catch (/** @type {any} */ error) { this.logger.log(`Error while retrieving last block or its involved anchors during consistency check: ${error.message}`, (m, c) => console.error(m, c)); }

		if (!block || !isLastBlockConsistent) {
			this.blockStorage.unstore(involvedAnchors);
			this.logger.log('Blockchain file repaired', (m, c) => console.warn(m, c));
			return;
		}

		// SECOND: ENSURE IDENTITIES CONSISTENCY
		if (repeatedAnchorsCount > 0) throw new Error('Blockchain consistency check failed: repeated UTXO anchors found.');
		if (!block || !involvedAnchors) throw new Error('Blockchain consistency check failed: unable to retrieve the last block or its involved anchors.');

		const discovery = this.identityStore.digestBlock(block);
		if (discovery.size === 0) this.logger.log('Blockchain identities check: no change', (m, c) => console.info(m, c));
		else this.logger.log(`Blockchain identities check: ${discovery.size} new identities patch`, (m, c) => console.info(m, c));
		
		// THIRD: ENSURE VSS CONSISTENCY
		if (this.vss.hasBlockStakes(block)) this.logger.log('VSS consistency check: no change', (m, c) => console.info(m, c));
		else {
			this.vss.revertBlockStakes(block); // ensure no stakes from block
			this.vss.digestBlockStakes(block, 'persist'); // re-add stakes from block
			this.logger.log('VSS consistency check: stakes repaired', (m, c) => console.warn(m, c));
		}

		// FOURTH: ENSURE LEDGERS CONSISTENCY
		const involvedUTXOs = this.getUtxos(involvedAnchors, false);
		if (!involvedUTXOs) throw new Error('Blockchain consistency check failed: unable to retrieve all involved UTXOs for the last block.');
		
		//const applyCount = await this.ledgersStorage.digestBlock(block, involvedUTXOs, 'APPLY, true);
		const applyCount = this.ledgersStorage.digestBlockSync(block, involvedUTXOs, 'APPLY', true); // prefer sync
		if (applyCount === 0) this.logger.log('Blockchain ledgers check: no change', (m, c) => console.info(m, c));
		else this.logger.log(`Blockchain ledgers check: ${applyCount} ledgers patched`, (m, c) => console.info(m, c));
		this.ledgersStorage.cache.clear();
	}
}