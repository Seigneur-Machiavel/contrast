// @ts-check
import HiveP2P from "hive-p2p";
import { Vss } from './vss.mjs';
import { Sync } from './sync.mjs';
import { Miner } from './miner.mjs';
import { MemPool } from './mempool.mjs';
import { BlockUtils } from './block.mjs';
import { TaskQueue } from './task-queue.mjs';
import { Blockchain } from './blockchain.mjs';
import { serializer } from "../../utils/serializer.mjs";
import { BlockValidation } from './block-validation.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { ValidationWorker } from '../workers/validation-worker-wrapper.mjs';
import { ADDRESS } from "../../types/address.mjs";

/**
* @typedef {import("./wallet.mjs").Account} Account
* @typedef {import("./wallet.mjs").Wallet} Wallet
* @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
* 
* @typedef {Object} NodeOptions
* @property {import('hive-p2p').CryptoCodex} [cryptoCodex] - A hiveP2P CryptoCodex instance (works as Identity).
* @property {import('../../storage/storage.mjs').ContrastStorage} [storage] - ContrastStorage instance for node data persistence.
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
	running = true;
	logger = new MiniLogger('node');
	info = { lastLegitimacy: 0, averageBlockTime: 0, state: 'idle' };
	/** @type {{ validator: string | null, miner: string | null }} */
	rewardAddresses = { validator: null, miner: null };
	/** @type {Object<string, import("./websocketCallback.mjs").WebSocketCallBack>} */
    wsCallbacks = {};
	/** @type {Object<string, Function>} */
	callbacks = {};

	mainStorage; blockchain;
	taskQueue; memPool; p2p;
	vss; miner; sync;
	verb;

	/** @type {Account | undefined} */
	account;
	workers = {
		nbOfValidationWorkers: 4,
		/** @type {ValidationWorker[]} */		validations: [],
	};
	/** @type {Object<string, NodeJS.Timeout | null>} */
	timeouts = { createAndShareBlockCandidate: null };

	/** Node instance should be created with "createContrastNode" method, not using "new" constructor.
	 * @param {import('hive-p2p').Node} p2pNode - Hive P2P node instance.
	 * @param {import('../../storage/storage.mjs').ContrastStorage} [storage] - ContrastStorage instance for node data persistence. */
	constructor(p2pNode, storage, verb = 2) {
		this.blockchain = new Blockchain(storage);
		this.memPool = new MemPool(this.blockchain);
		this.taskQueue = new TaskQueue();
		this.mainStorage = storage;
		this.verb = verb;
		this.p2p = p2pNode;
		this.vss = new Vss();
		this.miner = new Miner(this);
		this.sync = new Sync(this);

		p2pNode.gossip.on('block_candidate', this.#onBlockCandidate);
		p2pNode.gossip.on('block_finalized', this.#onBlockFinalized);
		p2pNode.messager.on('address_ledger_request', this.#onAddressLedgerRequest);
	}

	// GETTERS --------------------------------------------------------------------------
	get time() { return this.p2p.time; }
	get neighborsCount() { return this.p2p.peerStore.neighborsList.length; }

	// API ------------------------------------------------------------------------------
	/** Register a websocket callback. @param {'onBlockConfirmed' | 'onStateUpdate' | 'onBroadcastNewCandidate'} event @param {Function} callback */
	on(event, callback) { this.callbacks[event] = callback; }
	/** Update the node state and notify websocket clients. @param {string} newState @param {string} [onlyFrom] Updates only if current state matches */
	updateState(newState, onlyFrom) {
        const state = this.info.state;
        if (onlyFrom && !(state === onlyFrom || state.includes(onlyFrom))) return;
        this.info.state = newState;
		this.callbacks.onStateUpdate?.(newState);
		this.wsCallbacks.onStateUpdate?.execute(newState, undefined);
    }
	/** Starts the Contrast node operations @param {Wallet} [wallet] */
	async start(wallet, startFromScratch = false) {
		this.logger.log(`Starting Contrast node...`, (m, c) => console.log(m, c)); // control the clock
		if (wallet) this.associateWallet(wallet);
		for (let i = 0; i < this.workers.nbOfValidationWorkers; i++) this.workers.validations.push(new ValidationWorker(i));
		
		if (!this.p2p.started) { 		// START P2P NODE IF NOT
			this.updateState("Starting HiveP2P node");
			await this.p2p.start();
		}
		
		this.#startStackExecution();
		await this.createAndShareMyBlockCandidate();
		if (this.blockchain.lastBlock) // SHARE MY STATUS IF ANY BLOCK EXISTS
			this.sync.setAndshareMyStatus(this.blockchain.lastBlock);
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
		this.account = wallet.accounts[0];
		this.rewardAddresses.validator = wallet.accounts[0].address;
		this.rewardAddresses.miner = wallet.accounts[1].address;
	}
	async createAndShareMyBlockCandidate() {
		try {
			this.updateState("creating block candidate");
			const myCandidate = await BlockUtils.createAndSignBlockCandidate(this);
			if (!myCandidate) throw new Error('Failed to create block candidate');

			const updated = this.miner.updateBestCandidate(myCandidate);
			if (!updated) throw new Error('The miner rejected the created block candidate');
			
			const serialized = serializer.serialize.block(myCandidate, 'candidate');
			this.p2p.broadcast(serialized, { topic: 'block_candidate' });
			this.callbacks.onBroadcastNewCandidate?.(myCandidate);
			this.wsCallbacks.onBroadcastNewCandidate?.execute(BlockUtils.getCandidateBlockHeader(myCandidate), undefined);
		} catch (/** @type {any} */ error) { this.logger.log(error.stack, (m, c) => console.error(m, c)); }
		
		this.updateState("idle", "creating block candidate");
	}
	
	// INTERNALS ------------------------------------------------------------------------
	async #startStackExecution() {
		while (this.running) {
			await this.#executeNextTask();
			await this.miner.tick();
			await new Promise(r => setTimeout(r, 10));
		}
	}
	/** @param {string} senderId @param {Uint8Array} data @param {number} HOPS */
	#onBlockCandidate = async (senderId, data, HOPS) => {
		try { // ignore block candidates that are not the next block
			const block = serializer.deserialize.blockCandidate(data);
			if (this.blockchain.currentHeight + 1 !== block.index) return;
			const isLegitimate = await BlockValidation.validateLegitimacy(block, this.vss, 'candidate');
			if (isLegitimate) this.taskQueue.push('NewCandidate', block);
		} catch (/** @type {any} */ error) { this.logger.log(`[SYNC] -onBlockCandidate- Error deserializing block candidate from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	/** @param {string} senderId @param {Uint8Array} data @param {number} HOPS */
	#onBlockFinalized = (senderId, data, HOPS) => {
		this.taskQueue.push('DigestBlock', data);
	}
	/** @param {string} senderId @param {string} data */
	#onAddressLedgerRequest = async (senderId, data) => {
		try {
			/** @type {string} */
			const address = data;
			if (!ADDRESS.checkConformity(address)) throw new Error('Invalid address format');
			
			const ledger = this.blockchain.ledgersStorage.getAddressLedger(address);
			if (!ledger) throw new Error('Ledger not found for address: ' + address);
			// CLEAR REDUNDANT DATA & SEND RESPONSE
			delete ledger.historyBytes;
			delete ledger.utxosBuffer;
			this.p2p.messager.sendUnicast(senderId, ledger, 'address_ledger');
		} catch (/** @type {any} */ error) { this.logger.log(`-onAddressLedgerRequest- Error processing address ledger request from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	#executeNextTask = async () => {
		const task = this.taskQueue.nextTask;
		if (!task) { this.miner.canProceedMining = true; return; } // no task to process

		if (task.type === 'PushTxs') 			// as batch of transactions
			for (const tx of task.data) this.memPool.pushTransaction(this, tx);
		else if (task.type === 'NewCandidate') 	//@ts-ignore: task.data = BlockCandidate
			this.miner.updateBestCandidate(task.data);
		else if (task.type === 'DigestBlock') 	//@ts-ignore: task.data = BlockFinalizedSerialized
			await this.blockchain.digestFinalizedBlock(this, task.data);
	}
}