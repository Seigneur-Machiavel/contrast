import HiveP2P from "hive-p2p";
import { Miner } from './miner.mjs';
import { Vss } from './vss.mjs';
//import { MemPool } from './mempool.mjs';
import { Blockchain } from './blockchain.mjs';
//import { UtxoCache } from './utxo-cache.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { BlockData, BlockUtils } from './block-classes.mjs';
//import { BlockValidation } from './validations-classes.mjs';
//import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { ValidationWorker } from '../workers/workers-classes.mjs';
//import { SnapshotSystem, CheckpointSystem } from './snapshot-system.mjs';
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';

/**
* @typedef {Object} NodeOptions
* @property {import('hive-p2p').CryptoCodex} cryptoCodex - A hiveP2P CryptoCodex instance (works as Identity).
* @property {import('../../utils/storage.mjs').ContrastStorage} storage - ContrastStorage instance for node data persistence.
* @property {number} [verbose] - Verbosity level for logging.
* @property {boolean} [autoStart] - Whether to automatically start the node upon creation. (default: true)
* @property {string} [domain] - The domain name for the node (Public only).
* @property {number} [port] - The port number for the node to listen on (Public only).
* @property {string[]} [bootstraps] - An array of bootstrap node addresses. */

/** @param {NodeOptions} [options] */
export async function createContrastNode(options = {}) {
	if (!options.cryptoCodex) throw new Error('Node requires a CryptoCodex instance in options.cryptoCodex');
	
	const verb = options.verbose !== undefined ? options.verbose : options.cryptoCodex.verbose;
	const asPublic = options.domain !== undefined && options.port !== undefined;
	if (options.autoStart === undefined) options.autoStart = true; // set default autoStart to true
	
	const p2pNode = asPublic ? await HiveP2P.createPublicNode(options) : await HiveP2P.createNode(options);
	return new ContrastNode(p2pNode, options.storage, verb);
}

export class ContrastNode {
	info = { lastLegitimacy: 0, averageBlockTime: 0, state: 'idle' };
	/** @type {Object<string, import("./websocketCallback.mjs").WebSocketCallBack>} */
    wsCallbacks = {};
	mainStorage;
	blockchain;
	p2pNode;
	verb;

	// CORE COMPONENTS ------------------------------------------------------------------
	vss = new Vss(BLOCKCHAIN_SETTINGS.maxSupply);
	miner = new Miner(this);
	workers = {
		nbOfValidationWorkers: 4,
		/** @type {ValidationWorker[]} */		validations: [],
	};

	/** Node instance should be created with "createContrastNode" method, not using "new" constructor.
	 * @param {import('hive-p2p').Node} p2pNode - Hive P2P node instance.
	 * @param {import('../../utils/storage.mjs').ContrastStorage} storage - ContrastStorage instance for node data persistence. */
	constructor(p2pNode, storage, verb = 2) {
		this.blockchain = new Blockchain(storage);
		this.mainStorage = storage;
		this.p2pNode = p2pNode;
		this.verb = verb;
	}

	// GETTERS --------------------------------------------------------------------------
	get time() { return this.p2pNode.time; }
	get neighborsCount() { return this.p2pNode.peerStore.neighborsList.length; }

	// API ------------------------------------------------------------------------------
	async start() {
		for (let i = 0; i < this.workers.nbOfValidationWorkers; i++)
			this.workers.validations.push(new ValidationWorker(i));
		// TODO: PRUNE CHECKPOINTS AND LOAD SNAPSHOT

		this.updateState("Starting HiveP2P node");
		if (!this.p2pNode.started) await this.p2pNode.start();

		//console.log(`${this.p2pNode.time} - ${Date.now()}`); // control the clock
		
	}
	async stop() {
		if (this.verb >= 1) console.log(`Stopping Contrast node...`);
	}
	async restart() {
		if (this.verb >= 1) console.log(`Restarting Contrast node...`);
		await this.stop();
		await this.start();
	}
	/** Update the node state and notify websocket clients. @param {string} newState @param {string} [onlyFrom] Updates only if current state matches */
	updateState(newState, onlyFrom) {
        const state = this.info.state;
        if (onlyFrom && !(state === onlyFrom || state.includes(onlyFrom))) return;
        this.info.state = newState;
		this.wsCallbacks.onStateUpdate?.execute(newState);
    }
	setWallet() { // associat a wallet with this node (for miner and validator functions)
		// To be implemented
	}

	// INTERNALS ------------------------------------------------------------------------
	/** Aggregates transactions from mempool, creates a new block candidate (Genesis block if no lastBlock) */
    async #createBlockCandidate() {
        const posTimestamp = this.blockchain.lastBlock ? this.blockchain.lastBlock.timestamp + 1 : this.time;
        if (!this.blockchain.lastBlock) return BlockData(0, 0, BLOCKCHAIN_SETTINGS.blockReward, MINING_PARAMS.initialDifficulty, 0, '0000000000000000000000000000000000000000000000000000000000000000', [], posTimestamp);
        
		const prevHash = this.blockchain.lastBlock.hash;
		const myLegitimacy = await this.vss.getAddressLegitimacy(this.account.address, prevHash);
		this.info.lastLegitimacy = myLegitimacy;

		// THIS PART SHOULD BE SEPARATED
		/*let maxLegitimacyToBroadcast = this.vss.maxLegitimacyToBroadcast;
		if (this.roles.includes('miner') && this.miner.bestCandidateIndex() === this.blockchain.lastBlock.index + 1)
			maxLegitimacyToBroadcast = Math.min(maxLegitimacyToBroadcast, this.miner.bestCandidateLegitimacy());
		
		if (myLegitimacy > maxLegitimacyToBroadcast) return null;*/
		// END OF PART THAT SHOULD BE SEPARATED

		const { averageBlockTime, newDifficulty } = this.calculateAverageBlockTimeAndDifficulty();
		this.info.averageBlockTime = averageBlockTime;
		const coinBaseReward = mining.calculateNextCoinbaseReward(this.blockchain.lastBlock);
		const Txs = this.memPool.getMostLucrativeTransactionsBatch(this.utxoCache);
		return BlockData(this.blockchain.lastBlock.index + 1, this.blockchain.lastBlock.supply + this.blockchain.lastBlock.coinBase, coinBaseReward, newDifficulty, myLegitimacy, prevHash, Txs, posTimestamp);
    }
	/** Adds POS reward transaction to the block candidate and signs it @param {BlockData} blockCandidate */
	async #signBlockCandidate(blockCandidate) {
		const { powReward, posReward } = BlockUtils.calculateBlockReward(this.utxoCache, blockCandidate);
		const posFeeTx = await Transaction_Builder.createPosReward(posReward, blockCandidate, this.validatorRewardAddress, this.account.address);
		const signedPosFeeTx = await this.account.signTransaction(posFeeTx);
		blockCandidate.Txs.unshift(signedPosFeeTx);
		blockCandidate.powReward = powReward; // Reward for the miner
		return blockCandidate;
	}
}