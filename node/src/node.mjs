// @ts-check
import HiveP2P from "hive-p2p";
import { Sync } from './sync.mjs';
import { Solver } from './solver.mjs';
import { MemPool } from './mempool.mjs';
import { BlockUtils } from './block.mjs';
import { TaskQueue } from './task-queue.mjs';
import { Blockchain } from './blockchain.mjs';
import { ADDRESS } from "../../types/address.mjs";
import { NodeController } from "./node-controller.mjs";
import { Transaction_Builder } from "./transaction.mjs";
import { BinaryReader, serializer } from "../../utils/serializer.mjs";
import { BlockValidation } from './block-validation.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { ValidationWorker } from '../workers/validation-worker-wrapper.mjs';
import { BLOCKCHAIN_SETTINGS, SOLVING } from "../../config/blockchain-settings.mjs";

/**
* @typedef {import("../../node_modules/hive-p2p/core/unicast.mjs").DirectMessage} DirectMessage
* @typedef {import("../../node_modules/hive-p2p/core/gossip.mjs").GossipMessage} GossipMessage
* 
* @typedef {import("./wallet.mjs").Wallet} Wallet
* @typedef {import("./account.mjs").Account} Account
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
* @property {string} [serverChachaSeedHex] - A 32bytes hex-encoded seed for key generation (if not set, client-server pubkeys will be exchanged)
* @property {boolean} [unsafeServePubKey] - If true, the node will share its public key with any client that connects to the controller (WARNING: ENABLING THIS CAN EXPOSE TO ATTACKS - ONLY USE IN DEBUG ENVIRONMENTS!)
* @property {string[]} bootstraps - An array of bootstrap node addresses. */

/** @param {NodeOptions} [options] */
export async function createContrastNode(options = { bootstraps: [] }) {
	if (!options.cryptoCodex) throw new Error('Node requires a CryptoCodex instance in options.cryptoCodex');

	const verb = options.verbose !== undefined ? options.verbose : options.cryptoCodex.verbose;
	const asPublic = options.domain !== undefined && options.port !== undefined;
	if (options.autoStart === undefined) options.autoStart = true; // set default autoStart to true
	
	const p2pNode = asPublic ? await HiveP2P.createPublicNode(options) : await HiveP2P.createNode(options);
	const blockchain = new Blockchain(options.storage);
	await blockchain.initialize();
	
	return new ContrastNode(p2pNode, blockchain, verb, options.controllerPort, options.serverChachaSeedHex, options.unsafeServePubKey);
}

export class ContrastNode {
	/** @type {Record<string, Function>} */
	callbacks = {}; // Callbacks used by the script who start the node to hook their functions (no sensitive data)
	controller;		// Callbacks to manage the node and display info via local WebSocket (can imply sensitive data)
	running = true;

	logger = new MiniLogger('node');
	info = { lastLegitimacy: 0, averageBlockTime: 0, state: 'idle' };
	/** @type {{ vAddress: string | undefined, vPubkeys: string[] | undefined, sAddress: string | undefined, sPubkeys: string[] | undefined }} */
	rewardsInfo = { vAddress: undefined, vPubkeys: undefined, sAddress: undefined, sPubkeys: undefined };

	mainStorage; blockchain;
	taskQueue; memPool; p2p;
	solver; sync;
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
	 * @param {Blockchain} blockchain - Blockchain instance for the node.
	 * @param {number | false} [controllerPort] - The port number for the controller to create. (default: 27261 | false to disable)
	 * @param {string} [serverChachaSeedHex] - A 32bytes hex-encoded seed for key generation (if not set, client-server pubkeys will be exchanged)
	 * @param {boolean} [unsafeServePubKey] - If true, the node will share its public key with any client that connects to the controller (WARNING: ENABLING THIS CAN EXPOSE TO ATTACKS - ONLY USE IN DEBUG ENVIRONMENTS!) */
	constructor(p2pNode, blockchain, verb = 2, controllerPort, serverChachaSeedHex, unsafeServePubKey) {
		this.blockchain = blockchain;
		this.mainStorage = blockchain.storage;
		this.memPool = new MemPool(this.blockchain);
		this.taskQueue = new TaskQueue();
		this.verb = verb;
		this.p2p = p2pNode;
		this.solver = new Solver(this);
		this.sync = new Sync(this);
		if (controllerPort !== false) this.controller = new NodeController(this, controllerPort, serverChachaSeedHex, unsafeServePubKey);

		p2pNode.gossip.on('block_candidate', this.#onBlockCandidate);
		p2pNode.gossip.on('block_finalized', this.#onBlockFinalized);
		p2pNode.gossip.on('transaction', this.#onTransaction);
		p2pNode.gossip.on('transactions', this.#onTransactions);
		p2pNode.messager.on('address_ledger_request', this.#onAddressLedgerRequest);
		p2pNode.messager.on('transactions_request', this.#onTransactionsRequest);
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
	async start(wallet) {
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
		for (const timeout in this.timeouts) if (this.timeouts[timeout]) clearTimeout(this.timeouts[timeout]);
		this.p2p.destroy();
		this.running = false;
	}
	async restart() {
		if (this.verb >= 1) this.logger.log(`Restarting Contrast node...`, (m, c) => console.log(m, c));
		await this.stop();
		await this.start();
	}

	/** Associate a wallet with this node (for solver and validator functions) @param {Wallet} wallet */
	associateWallet(wallet) {
		if (!wallet.accounts[0].pubKey || !wallet.accounts[1].pubKey) throw new Error('Wallet accounts must be initialized with pubKeys before associating with the node');
		this.account = wallet.accounts[0];
		this.rewardsInfo.vAddress = wallet.accounts[0].address;
		this.rewardsInfo.vPubkeys = [wallet.accounts[0].pubKey];
		this.rewardsInfo.sAddress = wallet.accounts[1].address;
		this.rewardsInfo.sPubkeys = [wallet.accounts[1].pubKey];
	}
	async createAndShareMyBlockCandidate() {
		try {
			this.updateState("creating block candidate");
			const { blockReward } = BLOCKCHAIN_SETTINGS;
			const { initialDifficulty } = SOLVING;
			const myCandidate = await BlockUtils.createBlockCandidate(this, blockReward, initialDifficulty);
			if (myCandidate === null) throw new Error('Failed to create block candidate');
			if (myCandidate === false) throw new Error('Not eligible to create a block candidate at this time (low legitimacy or already ahead, or too far behind)');

			await BlockUtils.signBlockCandidate(this, myCandidate);

			this.solver.updateBestCandidate(myCandidate); // throw if not updated
			
			const serialized = serializer.serialize.block(myCandidate, 'candidate');
			this.p2p.broadcast(serialized, { topic: 'block_candidate' });
			this.callbacks.onBroadcastNewCandidate?.(myCandidate);
			this.controller?.sendEncryptedMessage('newBlockCandidate', myCandidate);
		} catch (/** @type {any} */ error) {
			if (this.verb >= 2)
				if (error.message.startsWith('Failed')) this.logger.log(error.stack, (m, c) => console.error(m, c));
				else this.logger.log(error.message, (m, c) => console.warn(m, c));
		}
		
		this.updateState("idle", "creating block candidate");
	}
	
	// INTERNALS ------------------------------------------------------------------------
	async #stackExecution() {
		while (this.running) {
			await this.#executeNextTask();
			try { await this.solver.tick(); } catch (/** @type {any} */ error) { if (this.verb >= 2) this.logger.log(`[NODE-STACK] Error in tick: ${error.stack}`, (m, c) => console.error(m, c)); }
			await new Promise(r => setTimeout(r, 10));
		}
	}
	#executeNextTask = async () => {
		const task = this.taskQueue.nextTask;
		if (!task) { this.solver.canProceedSolving = true; return; } // no task to process

		if (task.type === 'PushTxs') 			// as batch of transactions
			for (const tx of task.data)
				try { await this.memPool.pushTransaction(this, tx); }
				catch (/** @type {any} */ error) { this.logger.log(`[P2P->MEMPOOL] -PushTxs- Error pushing transaction to mempool: ${error.message}`, (m, c) => console.error(m, c)); }
		else if (task.type === 'NewCandidate') 	// @ts-ignore: task.data = BlockCandidate
			try {
				const candidate = serializer.deserialize.blockCandidate(task.data);
				const isLegitimate = await BlockValidation.validateLegitimacy(this, candidate, 'candidate');
				if (!isLegitimate) throw new Error('Received block candidate is not legitimate');
				if (this.blockchain.currentHeight + 1 !== candidate.index) return; // check again.
				this.solver.updateBestCandidate(candidate);
			} catch (/** @type {any} */ error) { if (this.verb >= 2) this.logger.log(`[P2P->SOLVER] -NewCandidate- ${error.message}`, (m, c) => console.error(m, c)); }
		else if (task.type === 'DigestBlock') 	// @ts-ignore: task.data = BlockFinalizedSerialized
			await this.blockchain.digestFinalizedBlock(this, task.data);
	}
	/** @param {GossipMessage} msg */
	#onBlockCandidate = async (msg) => {
		const { senderId, data, HOPS } = msg;
		if (!(data instanceof Uint8Array)) {
			this.logger.log(`[SYNC] -onBlockCandidate- Invalid block candidate data type from ${senderId}`, (m, c) => console.error(m, c));
			return;
		}

		const index = serializer.converter.bytes4ToNumber(new Uint8Array(data.slice(2, 6)));
		if (index === this.blockchain.currentHeight + 1) this.taskQueue.push('NewCandidate', data);
		else this.logger.log(`[SYNC] -onBlockCandidate- Received block candidate with invalid index ${index} from ${senderId} (current height: ${this.blockchain.currentHeight})`, (m, c) => console.warn(m, c));
	}
	/** @param {GossipMessage} msg */
	#onBlockFinalized = (msg) => {
		const { senderId, data, HOPS } = msg;
		if (data instanceof Uint8Array) this.taskQueue.push('DigestBlock', data);
		else this.logger.log(`[SYNC] -onBlockFinalized- Invalid block finalized data type from ${senderId}`, (m, c) => console.error(m, c));
	}
	/** @param {GossipMessage} msg */
	#onTransaction = (msg) => {
		const { senderId, data, HOPS } = msg;
		try {
			if (!(data instanceof Uint8Array)) throw new Error('Invalid transaction data type from ' + senderId);
			this.taskQueue.push('PushTxs', [data]);
		} catch (/** @type {any} */ error) { this.logger.log(`[P2P] -onTransaction- Error deserializing transaction from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	/** @param {GossipMessage} msg */
	#onTransactions = (msg) => {
		const { senderId, data, HOPS } = msg;
		try {
			if (!(data instanceof Uint8Array)) throw new Error('Invalid transactions data type from ' + senderId);
			const r = new BinaryReader(data);
			const { pointers, endOfLastDataChunk } = r.readPointers('pointer32');
			if (pointers.length > BLOCKCHAIN_SETTINGS.maxTransactionsBatchSize) throw new Error(`Too many transactions in batch from ${senderId} (count: ${pointers.length}, max: ${BLOCKCHAIN_SETTINGS.maxTransactionsBatchSize})`);
			const txs = r.readFollowingThePointers(pointers, endOfLastDataChunk	);
			if (!r.isReadingComplete) throw new Error('Invalid chunks in transactions');
			this.taskQueue.push('PushTxs', txs);
		} catch (/** @type {any} */ error) { this.logger.log(`[P2P] -onTransactions- Error deserializing transactions from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	/** @param {DirectMessage} msg */
	#onAddressLedgerRequest = async (msg) => {
		const { senderId, data: address } = msg;
		try {
			if (typeof address !== 'string') throw new Error('Invalid address data type');
			if (!ADDRESS.checkConformity(address)) throw new Error('Invalid address format');
			
			const ledger = await this.blockchain.ledgersStorage.getAddressLedger(address);
			if (!ledger) throw new Error('Ledger not found for address: ' + address);
			// CLEAR REDUNDANT DATA & SEND RESPONSE
			delete ledger.historyBytes;
			delete ledger.utxosBuffer;
			this.p2p.messager.sendUnicast(senderId, ledger, 'address_ledger');
		} catch (/** @type {any} */ error) { this.logger.log(`-onAddressLedgerRequest- Error processing address ledger request from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	/** @param {DirectMessage} msg */
	#onTransactionsRequest = async (msg) => {
		const { senderId, data } = msg;
		try {
			if (!(data instanceof Uint8Array)) throw new Error('Invalid transactions request data type');
			const request = serializer.deserialize.txsIdsArray(data);
			if (!Array.isArray(request)) throw new Error('Invalid transactions request format');
			if (request.length === 0) throw new Error('Empty transactions request');
			if (request.length > 10) throw new Error('Too many transactions requested at once (max 10)');

			const txs = this.blockchain.blockStorage.getTransactionsByIds(request);
			const impliedAnchors = [];
			for (const tx in txs)
				if (Transaction_Builder.isSolverOrValidatorTx(txs[tx])) continue;
				else impliedAnchors.push(...txs[tx].inputs);
				
			const impliedUtxos = this.blockchain.blockStorage.getUtxos(impliedAnchors);
			if (!impliedUtxos) throw new Error('Failed to retrieve implied UTXOs for the requested transactions');
			const s = serializer.serialize.transactionsResponse(txs, impliedUtxos);
			this.p2p.messager.sendUnicast(senderId, s, 'transactions');
		} catch (/** @type {any} */ error) { this.logger.log(`-onTransactionsRequest- Error processing transactions request from ${senderId}: ${error.stack}`, (m, c) => console.error(m, c)); }
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