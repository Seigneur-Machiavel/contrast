// @ts-check
import HiveP2P from "hive-p2p";
import { Vss } from './vss.mjs';
import { Sync } from './sync.mjs';
import { Miner } from './miner.mjs';
import { MemPool } from './mempool.mjs';
import { BlockUtils } from './block.mjs';
import { TaskQueue } from './task-queue.mjs';
import { Blockchain } from './blockchain.mjs';
import { ADDRESS } from "../../types/address.mjs";
import { NodeController } from "./node-controller.mjs";
import { serializer } from "../../utils/serializer.mjs";
import { BlockValidation } from './block-validation.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { ValidationWorker } from '../workers/validation-worker-wrapper.mjs';

/**
* @typedef {import("../../node_modules/hive-p2p/core/unicast.mjs").DirectMessage} DirectMessage
* @typedef {import("../../node_modules/hive-p2p/core/gossip.mjs").GossipMessage} GossipMessage
* 
* @typedef {import("./wallet.mjs").Wallet} Wallet
* @typedef {import("./wallet.mjs").Account} Account
* @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
* 
* @typedef {Object} NodeOptions
* @property {import('hive-p2p').CryptoCodex} [cryptoCodex] - A hiveP2P CryptoCodex instance (works as Identity).
* @property {import('../../storage/storage.mjs').ContrastStorage} [storage] - ContrastStorage instance for node data persistence.
* @property {number} [verbose] - Verbosity level for logging.
* @property {boolean} [autoStart] - Whether to automatically start the node upon creation. (default: true)
* @property {string} [domain] - The domain name for the node (Public only).
* @property {number} [port] - The port number for the node to listen on (Public only).
* @property {number | false} [controllerPort] - The port number for the controller to create. (default: 27261 | false to disable)
* @property {string[]} bootstraps - An array of bootstrap node addresses. */

/** @param {NodeOptions} [options] */
export async function createContrastNode(options = { bootstraps: [] }) {
	if (!options.cryptoCodex) throw new Error('Node requires a CryptoCodex instance in options.cryptoCodex');

	const verb = options.verbose !== undefined ? options.verbose : options.cryptoCodex.verbose;
	const asPublic = options.domain !== undefined && options.port !== undefined;
	if (options.autoStart === undefined) options.autoStart = true; // set default autoStart to true
	
	const p2pNode = asPublic ? await HiveP2P.createPublicNode(options) : await HiveP2P.createNode(options);
	return new ContrastNode(p2pNode, options.storage, verb, options.controllerPort);
}

export class ContrastNode {
	/** @type {Object<string, Function>} */
	callbacks = {}; // Callbacks used by the script who start the node to hook their functions (no sensitive data)
	controller;		// Callbacks to manage the node and display info via local WebSocket (can imply sensitive data)
	running = true;

	logger = new MiniLogger('node');
	info = { lastLegitimacy: 0, averageBlockTime: 0, state: 'idle' };
	/** @type {{ validator: string | null, miner: string | null }} */
	rewardAddresses = { validator: null, miner: null };

	mainStorage; blockchain;
	taskQueue; memPool; p2p;
	miner; sync;
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
	 * @param {import('../../storage/storage.mjs').ContrastStorage} [storage] - ContrastStorage instance for node data persistence.
	 * @param {number | false} [controllerPort] - The port number for the controller to create. (default: 27261 | false to disable) */
	constructor(p2pNode, storage, verb = 2, controllerPort) {
		this.blockchain = new Blockchain(storage);
		this.memPool = new MemPool(this.blockchain);
		this.taskQueue = new TaskQueue();
		this.mainStorage = storage;
		this.verb = verb;
		this.p2p = p2pNode;
		this.miner = new Miner(this);
		this.sync = new Sync(this);
		if (controllerPort !== false) this.controller = new NodeController(this, controllerPort);

		p2pNode.gossip.on('block_candidate', this.#onBlockCandidate);
		p2pNode.gossip.on('block_finalized', this.#onBlockFinalized);
		p2pNode.gossip.on('transaction', this.#onTransactionReceived);
		p2pNode.messager.on('address_ledger_request', this.#onAddressLedgerRequest);
		p2pNode.messager.on('blocks_timestamps_request', this.#onBlocksTimestampsRequest);
		p2pNode.messager.on('rounds_legitimacies_request', this.#onRoundsLegitimaciesRequest);
	}

	// GETTERS --------------------------------------------------------------------------
	get time() { return this.p2p.time; }
	get neighborsCount() { return this.p2p.peerStore.neighborsList.length; }

	// API ------------------------------------------------------------------------------
	/** Register a p2p callback. @param {'onBlockConfirmed' | 'onStateUpdate' | 'onBroadcastNewCandidate'} event @param {Function} callback */
	on(event, callback) { this.callbacks[event] = callback; }
	/** Update the node state and notify websocket clients. @param {string} newState @param {string} [onlyFrom] Updates only if current state matches */
	updateState(newState, onlyFrom) {
        const state = this.info.state;
        if (onlyFrom && !(state === onlyFrom || state.includes(onlyFrom))) return;
        this.info.state = newState;
		this.callbacks.onStateUpdate?.(newState);
		this.controller?.sendEncryptedMessage('stateUpdate', newState);
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
		
		this.#stackExecution();
		await this.createAndShareMyBlockCandidate();
		if (this.blockchain.lastBlock) // SHARE MY STATUS IF ANY BLOCK EXISTS
			this.sync.setAndshareMyStatus(this.blockchain.lastBlock);
		
		this.updateState("idle");
		this.logger.log(`Contrast node started. Current height: ${this.blockchain.currentHeight}`, (m, c) => console.log(m, c));
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

			//const updated = this.miner.updateBestCandidate(myCandidate);
			//if (!updated) throw new Error('The miner rejected the created block candidate');
			this.miner.updateBestCandidate(myCandidate); // throw if not updated
			
			const serialized = serializer.serialize.block(myCandidate, 'candidate');
			this.p2p.broadcast(serialized, { topic: 'block_candidate' });
			this.callbacks.onBroadcastNewCandidate?.(myCandidate);
			this.controller?.sendEncryptedMessage('newBlockCandidate', myCandidate);
		} catch (/** @type {any} */ error) { this.logger.log(error.stack, (m, c) => console.error(m, c)); }
		
		this.updateState("idle", "creating block candidate");
	}
	
	// INTERNALS ------------------------------------------------------------------------
	async #stackExecution() {
		while (this.running) {
			await this.#executeNextTask();
			await this.miner.tick();
			await new Promise(r => setTimeout(r, 10));
		}
	}
	#executeNextTask = async () => {
		const task = this.taskQueue.nextTask;
		if (!task) { this.miner.canProceedMining = true; return; } // no task to process

		if (task.type === 'PushTxs') 			// as batch of transactions
			for (const tx of task.data)
				try { this.memPool.pushTransaction(this, tx); }
				catch (/** @type {any} */ error) { this.logger.log(`[P2P->MEMPOOL] -PushTxs- Error pushing transaction to mempool: ${error.message}`, (m, c) => console.error(m, c)); }
		else if (task.type === 'NewCandidate') 	//@ts-ignore: task.data = BlockCandidate
			try { this.miner.updateBestCandidate(task.data); }
			catch (/** @type {any} */ error) { this.logger.log(`[P2P->MINER] -NewCandidate- ${error.message}`, (m, c) => console.error(m, c)); }
		else if (task.type === 'DigestBlock') 	//@ts-ignore: task.data = BlockFinalizedSerialized
			await this.blockchain.digestFinalizedBlock(this, task.data);
	}
	/** @param {GossipMessage} msg */
	#onBlockCandidate = async (msg) => {
		const { senderId, data, HOPS } = msg;
		try { // ignore block candidates that are not the next block
			if (!(data instanceof Uint8Array)) throw new Error('Invalid block candidate data type');
			const block = serializer.deserialize.blockCandidate(data);
			if (this.blockchain.currentHeight + 1 !== block.index) return;
			const isLegitimate = await BlockValidation.validateLegitimacy(block, this.blockchain.vss, 'candidate');
			if (isLegitimate) this.taskQueue.push('NewCandidate', block);
		} catch (/** @type {any} */ error) { this.logger.log(`[SYNC] -onBlockCandidate- Error deserializing block candidate from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	/** @param {GossipMessage} msg */
	#onBlockFinalized = (msg) => {
		const { senderId, data, HOPS } = msg;
		this.taskQueue.push('DigestBlock', data);
	}
	/** @param {GossipMessage} msg */
	#onTransactionReceived = (msg) => {
		const { senderId, data, HOPS } = msg;
		this.taskQueue.push('PushTx', data);
	}
	/** @param {DirectMessage} msg */
	#onAddressLedgerRequest = async (msg) => {
		const { senderId, data: address } = msg;
		try {
			if (typeof address !== 'string') throw new Error('Invalid address data type');
			if (!ADDRESS.checkConformity(address)) throw new Error('Invalid address format');
			
			const ledger = this.blockchain.ledgersStorage.getAddressLedger(address);
			if (!ledger) throw new Error('Ledger not found for address: ' + address);
			// CLEAR REDUNDANT DATA & SEND RESPONSE
			delete ledger.historyBytes;
			delete ledger.utxosBuffer;
			this.p2p.messager.sendUnicast(senderId, ledger, 'address_ledger');
		} catch (/** @type {any} */ error) { this.logger.log(`-onAddressLedgerRequest- Error processing address ledger request from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	/** @param {DirectMessage} msg */
	#onBlocksTimestampsRequest = async (msg) => {
		const { senderId, data } = msg;
		if (!(data instanceof Uint8Array)) return; // not the expected data type
		try {
			const request = serializer.deserialize.blocksTimestampsRequest(data);
			const t = this.blockchain.blockStorage.getBlocksTimestamps(request.fromHeight, request.toHeight);
			if (!t) throw new Error(`No timestamps found between heights ${request.fromHeight} and ${request.toHeight}`);
			const s = serializer.serialize.blocksTimestampsResponse(t.heights, t.timestamps);
			this.p2p.messager.sendUnicast(senderId, s, 'blocks_timestamps');
		} catch (/** @type {any} */ error) { this.logger.log(`-onBlocksTimestampsRequest- Error processing blocks timestamps request from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	/** @param {DirectMessage} msg */
	#onRoundsLegitimaciesRequest = async (msg) => {
		const { senderId, data } = msg;
		if (!(data instanceof Uint8Array)) return; // not the expected data type
		try {
			const h = serializer.converter.bytesToHex(data);
			const rl = this.blockchain.vss.getRoundForExplorerIfExists(h);
			if (!rl) throw new Error(`No round legitimacies found for block hash ${h}`);

			const s = serializer.serialize.roundsLegitimaciesResponse(rl);
			this.p2p.messager.sendUnicast(senderId, s, 'rounds_legitimacies');
		} catch (/** @type {any} */ error) { this.logger.log(`-onRoundsLegitimaciesRequest- Error processing rounds legitimacies request from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
}