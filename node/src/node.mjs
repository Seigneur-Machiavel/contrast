import HiveP2P from "hive-p2p";
import { Miner } from './miner.mjs';
import { Vss } from './vss.mjs';
import { MemPool } from './mempool.mjs';
import { BlockUtils } from './block.mjs';
import { UtxoCache } from './utxo-cache.mjs';
import { Blockchain } from './blockchain.mjs';
import { MESSAGE } from '../../types/messages.mjs';
//import { serializer } from '../../utils/serializer.mjs';
//import { Transaction_Builder } from './transaction.mjs';
import { BlockValidation } from './block-validation.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { ValidationWorker } from '../workers/workers-classes.mjs';
//import { CheckpointSystem } from './snapshot.mjs';
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';

/**
* @typedef {import("./wallet.mjs").Account} Account
* @typedef {import("./wallet.mjs").Wallet} Wallet
* @typedef {import("../../types/block.mjs").BlockData} BlockData
* 
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
	syncAndReady = false;
	logger = new MiniLogger('node');
	info = { lastLegitimacy: 0, averageBlockTime: 0, state: 'idle' };
	/** @type {{ validator: string | null, miner: string | null }} */
	rewardAddresses = { validator: null, miner: null };
	/** @type {Object<string, import("./websocketCallback.mjs").WebSocketCallBack>} */
    wsCallbacks = {};
	mainStorage;
	blockchain;
	p2pNode;
	verb;

	// CORE COMPONENTS ------------------------------------------------------------------
	/** @type {Account} */		account;
	vss = new Vss();
	memPool = new MemPool();
	miner = new Miner(this);
	workers = {
		nbOfValidationWorkers: 4,
		/** @type {ValidationWorker[]} */		validations: [],
	};
	timeouts = { createAndShareBlockCandidate: null };

	/** Node instance should be created with "createContrastNode" method, not using "new" constructor.
	 * @param {import('hive-p2p').Node} p2pNode - Hive P2P node instance.
	 * @param {import('../../utils/storage.mjs').ContrastStorage} storage - ContrastStorage instance for node data persistence. */
	constructor(p2pNode, storage, verb = 2) {
		this.blockchain = new Blockchain(storage);
		this.utxoCache = new UtxoCache(this.blockchain);
		this.mainStorage = storage;
		this.p2pNode = p2pNode;
		this.verb = verb;
		
		this.miner.startWithWorker();
		this.p2pNode.onPeerConnect(() => this.logger.log('Peer connected to Contrast node', (m, c) => console.log(m, c)));
	}

	// GETTERS --------------------------------------------------------------------------
	get time() { return this.p2pNode.time; }
	get neighborsCount() { return this.p2pNode.peerStore.neighborsList.length; }

	// API ------------------------------------------------------------------------------
	/** Update the node state and notify websocket clients. @param {string} newState @param {string} [onlyFrom] Updates only if current state matches */
	updateState(newState, onlyFrom) {
        const state = this.info.state;
        if (onlyFrom && !(state === onlyFrom || state.includes(onlyFrom))) return;
        this.info.state = newState;
		this.wsCallbacks.onStateUpdate?.execute(newState);
    }
	/** Starts the Contrast node operations @param {Wallet} [wallet] */
	async start(wallet) {
		this.logger.log(`Starting Contrast node...`, (m, c) => console.log(m, c)); // control the clock
		if (wallet) this.associateWallet(wallet);
		for (let i = 0; i < this.workers.nbOfValidationWorkers; i++) this.workers.validations.push(new ValidationWorker(i));
		// TODO: PRUNE CHECKPOINTS AND LOAD SNAPSHOT

		if (!this.p2pNode.started) { // START P2P NODE IF NOT
			this.updateState("Starting HiveP2P node");
			await this.p2pNode.start();
		}

		// TODO: SYNC BLOCKCHAIN FROM NETWORK

		await this.createAndShareMyBlockCandidate();

	}
	async stop() {
		if (this.verb >= 1) this.logger.log(`Stopping Contrast node...`, (m, c) => console.log(m, c));
	}
	async restart() {
		if (this.verb >= 1) this.logger.log(`Restarting Contrast node...`, (m, c) => console.log(m, c));
		await this.stop();
		await this.start();
	}
	/** Associate a wallet with this node (for miner and validator functions) @param {Wallet} wallet */
	associateWallet(wallet) { 
		this.account = wallet.accounts.C[0];
		this.rewardAddresses.validator = wallet.accounts.C[0].address;
		this.rewardAddresses.miner = wallet.accounts.C[1].address;
	}
	async createAndShareMyBlockCandidate() {
		this.updateState("creating block candidate");
		const myCandidate = await BlockUtils.createAndSignBlockCandidate(this);
		const updated = this.miner.updateBestCandidate(myCandidate);
		this.updateState("idle", "creating block candidate");
		if (!updated) return false;

		this.p2pNode.broadcast(new MESSAGE.BLOCK_CANDIDATE_MSG(myCandidate));
		this.wsCallbacks.onBroadcastNewCandidate?.execute(BlockUtils.getBlockHeader(myCandidate));
	}
	/** Digest and apply a finalized block to the blockchain.
     * @param {BlockData} finalizedBlock
     * @param {Object} [options] - Configuration options for the blockchain.
     * @param {boolean} [options.broadcastNewCandidate] - default: true
     * @param {boolean} [options.isSync] - default: false
     * @param {boolean} [options.persistToDisk] - default: true */
    async digestFinalizedBlock(finalizedBlock, options = {}) {
        const statePrefix = options.isSync ? '(syncing) ' : '';
        this.updateState(`${statePrefix}finalized block #${finalizedBlock.index}`);

        const { broadcastNewCandidate = true, isSync = false, persistToDisk = true } = options;
        //if (!finalizedBlock || (this.syncHandler.isSyncing && !isSync)) 
            //throw new Error(!finalizedBlock ? 'Invalid block candidate' : "Node is syncing, can't process block");
        let totalFees;
        this.updateState(`${statePrefix}block-validation #${finalizedBlock.index}`);
        const validationResult = await BlockValidation.validateBlockProposal(this, finalizedBlock);
        const hashConfInfo = validationResult.hashConfInfo;
        if (!(hashConfInfo?.conform)) throw new Error('Failed to validate block');

        this.updateState(`${statePrefix}applying finalized block #${finalizedBlock.index}`);
        this.memPool.addNewKnownPubKeysAddresses(validationResult.allDiscoveredPubKeysAddresses);
        
        const blockInfo = this.blockchain.addConfirmedBlock(this.utxoCache, finalizedBlock, persistToDisk, this.wsCallbacks.onBlockConfirmed, totalFees);
		this.blockchain.applyBlock(this.utxoCache, this.vss, finalizedBlock);
        this.memPool.removeFinalizedBlocksTransactions(finalizedBlock);
        if (this.wsCallbacks.onBlockConfirmed) this.wsCallbacks.onBlockConfirmed.execute(blockInfo);
    
        //this.logger.log(`${statePrefix}#${finalizedBlock.index} -> blockBytes: ${blockBytes} | Txs: ${finalizedBlock.Txs.length}`, (m, c) => console.info(m, c));
        const timeBetweenPosPow = ((finalizedBlock.timestamp - finalizedBlock.posTimestamp) / 1000).toFixed(2);
        const minerId = finalizedBlock.Txs[0].outputs[0].address.slice(0, 6);
        const validatorId = finalizedBlock.Txs[1].outputs[0].address.slice(0, 6);
        this.logger.log(`${statePrefix}#${finalizedBlock.index} -> {valid: ${validatorId} | miner: ${minerId}} - (diff[${hashConfInfo.difficulty}]+timeAdj[${hashConfInfo.timeDiffAdjustment}]+leg[${hashConfInfo.legitimacy}])=${hashConfInfo.finalDifficulty} | z: ${hashConfInfo.zeros} | a: ${hashConfInfo.adjust} | PosPow: ${timeBetweenPosPow}s`, (m, c) => console.info(m, c));

		// TODO: SAVE SNAPSHOT & CHECKPOINT
        await this.blockchain.saveSnapshot(this, finalizedBlock);
        //await this.#saveCheckpoint(finalizedBlock);
        
        this.updateState("idle", "applying finalized block");
        if (!broadcastNewCandidate || isSync) return;
		const d = Math.round(BLOCKCHAIN_SETTINGS.targetBlockTime / 12);
		this.timeouts.createAndShareBlockCandidate = setTimeout(() => this.createAndShareMyBlockCandidate(), d);
    }
	// INTERNALS ------------------------------------------------------------------------

}