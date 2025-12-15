// @ts-check
import HiveP2P from "hive-p2p";
import { Vss } from './vss.mjs';
import { Miner } from './miner.mjs';
import { MemPool } from './mempool.mjs';
import { BlockUtils } from './block.mjs';
import { Blockchain } from './blockchain.mjs';
import { MESSAGE } from '../../types/messages.mjs';
import { BlockValidation } from './block-validation.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { ValidationWorker } from '../workers/workers-classes.mjs';
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';

/**
* @typedef {import("./wallet.mjs").Account} Account
* @typedef {import("./wallet.mjs").Wallet} Wallet
* @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
* 
* @typedef {Object} NodeOptions
* @property {import('hive-p2p').CryptoCodex} [cryptoCodex] - A hiveP2P CryptoCodex instance (works as Identity).
* @property {import('../../utils/storage.mjs').ContrastStorage} [storage] - ContrastStorage instance for node data persistence.
* @property {number} [verbose] - Verbosity level for logging.
* @property {boolean} [autoStart] - Whether to automatically start the node upon creation. (default: true)
* @property {string} [domain] - The domain name for the node (Public only).
* @property {number} [port] - The port number for the node to listen on (Public only).
* @property {string[]} bootstraps - An array of bootstrap node addresses. */

/** @param {NodeOptions} [options] */
export async function createContrastNode(options = { bootstraps: [] }) {
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
	p2p;
	verb;

	// CORE COMPONENTS ------------------------------------------------------------------
	/** @type {Account | undefined} */ account;
	vss = new Vss();
	memPool = new MemPool();
	miner = new Miner(this);
	workers = {
		nbOfValidationWorkers: 4,
		/** @type {ValidationWorker[]} */		validations: [],
	};
	/** @type {Object<string, NodeJS.Timeout | null>} */
	timeouts = { createAndShareBlockCandidate: null };

	/** Node instance should be created with "createContrastNode" method, not using "new" constructor.
	 * @param {import('hive-p2p').Node} p2pNode - Hive P2P node instance.
	 * @param {import('../../utils/storage.mjs').ContrastStorage} [storage] - ContrastStorage instance for node data persistence. */
	constructor(p2pNode, storage, verb = 2) {
		this.blockchain = new Blockchain(storage);
		this.mainStorage = storage;
		this.p2p = p2pNode;
		this.verb = verb;
		
		this.miner.startWithWorker();
		this.p2p.onPeerConnect(() => this.logger.log('Peer connected to Contrast node', (m, c) => console.log(m, c)));
	}

	// GETTERS --------------------------------------------------------------------------
	get time() { return this.p2p.time; }
	get neighborsCount() { return this.p2p.peerStore.neighborsList.length; }

	// API ------------------------------------------------------------------------------
	/** Update the node state and notify websocket clients. @param {string} newState @param {string} [onlyFrom] Updates only if current state matches */
	updateState(newState, onlyFrom) {
        const state = this.info.state;
        if (onlyFrom && !(state === onlyFrom || state.includes(onlyFrom))) return;
        this.info.state = newState;
		this.wsCallbacks.onStateUpdate?.execute(newState, undefined);
    }
	/** Starts the Contrast node operations @param {Wallet} [wallet] */
	async start(wallet, startFromScratch = false) {
		this.logger.log(`Starting Contrast node...`, (m, c) => console.log(m, c)); // control the clock
		if (wallet) this.associateWallet(wallet);
		for (let i = 0; i < this.workers.nbOfValidationWorkers; i++) this.workers.validations.push(new ValidationWorker(i));

		if (!this.p2p.started) { // START P2P NODE IF NOT
			this.updateState("Starting HiveP2P node");
			await this.p2p.start();
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
		try {
			this.updateState("creating block candidate");
			const myCandidate = await BlockUtils.createAndSignBlockCandidate(this);
			if (!myCandidate) throw new Error('Failed to create block candidate');

			const updated = this.miner.updateBestCandidate(myCandidate);
			if (!updated) throw new Error('The miner rejected the created block candidate');
	
			this.p2p.broadcast(new MESSAGE.BLOCK_CANDIDATE_MSG(myCandidate));
			this.wsCallbacks.onBroadcastNewCandidate?.execute(BlockUtils.getCandidateBlockHeader(myCandidate), undefined);
		} catch (/** @type {any} */ error) { this.logger.log(error.stack, (m, c) => console.error(m, c)); }
		
		this.updateState("idle", "creating block candidate");
	}
	/** Digest and apply a finalized block to the blockchain.
     * @param {BlockFinalized} block
     * @param {Object} [options] - Configuration options for the blockchain.
     * @param {boolean} [options.broadcastNewCandidate] - default: true
     * @param {boolean} [options.isSync] - default: false
     * @param {boolean} [options.persistToDisk] - default: true */
    async digestFinalizedBlock(block, options = {}) {
        const statePrefix = options.isSync ? '(syncing) ' : '';
        this.updateState(`${statePrefix}finalized block #${block.index}`);

        const { broadcastNewCandidate = true, isSync = false, persistToDisk = true } = options;
        //if (!finalizedBlock || (this.syncHandler.isSyncing && !isSync)) 
            //throw new Error(!finalizedBlock ? 'Invalid block candidate' : "Node is syncing, can't process block");
        this.updateState(`${statePrefix}block-validation #${block.index}`);
        const validationResult = await BlockValidation.validateBlockProposal(this, block);
        const { hashConfInfo, involvedUTXOs, allDiscoveredPubKeysAddresses } = validationResult;
        if (!(hashConfInfo?.conform)) throw new Error('Failed to validate block');

		const newStakesOutputs = BlockUtils.extractNewStakesFromFinalizedBlock(block);
		if (!this.vss.newStakes(newStakesOutputs, 'control')) throw new Error('VSS: Max supply reached during applyBlock().');

        this.updateState(`${statePrefix}applying finalized block #${block.index}`);
        this.memPool.addNewKnownPubKeysAddresses(allDiscoveredPubKeysAddresses);
        
        this.blockchain.addConfirmedBlock(block);
		this.vss.newStakes(newStakesOutputs, 'persist');
        this.memPool.removeFinalizedBlocksTransactions(block);
        if (this.wsCallbacks.onBlockConfirmed) {
			const blockInfo = BlockUtils.getFinalizedBlockInfo(involvedUTXOs, block);
			this.wsCallbacks.onBlockConfirmed.execute(blockInfo, undefined);
		}
    
        //this.logger.log(`${statePrefix}#${finalizedBlock.index} -> blockBytes: ${blockBytes} | Txs: ${finalizedBlock.Txs.length}`, (m, c) => console.info(m, c));
        const timeBetweenPosPow = ((block.timestamp - block.posTimestamp) / 1000).toFixed(2);
        const minerId = block.Txs[0].outputs[0].address.slice(0, 6);
        const validatorId = block.Txs[1].outputs[0].address.slice(0, 6);
        this.logger.log(`${statePrefix}#${block.index} -> {valid: ${validatorId} | miner: ${minerId}} - (diff[${hashConfInfo.difficulty}]+timeAdj[${hashConfInfo.timeDiffAdjustment}]+leg[${hashConfInfo.legitimacy}])=${hashConfInfo.finalDifficulty} | z: ${hashConfInfo.zeros} | a: ${hashConfInfo.adjust} | PosPow: ${timeBetweenPosPow}s`, (m, c) => console.info(m, c));
        
        this.updateState("idle", "applying finalized block");
        if (!broadcastNewCandidate || isSync) return;
		const d = Math.round(BLOCKCHAIN_SETTINGS.targetBlockTime / 12);
		this.timeouts.createAndShareBlockCandidate = setTimeout(() => this.createAndShareMyBlockCandidate(), d);
    }
	// INTERNALS ------------------------------------------------------------------------

}