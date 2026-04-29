// @ts-check
import { Sync } from '../../node/src/sync.mjs';
import { serializer, BinaryReader } from '../../utils/serializer.mjs';
import { PendingRequest } from '../../utils/networking.mjs';
import { BlockFinalized, BlockFinalizedHeader } from '../../types/block.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../config/blockchain-settings.mjs';

/**
 * @typedef {import("../../node_modules/hive-p2p/core/unicast.mjs").DirectMessage} DirectMessage
 * @typedef {import("../../node_modules/hive-p2p/core/gossip.mjs").GossipMessage} GossipMessage
 * @typedef {import("../../storage/ledgers-store.mjs").AddressLedger} AddressLedger
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../types/transaction.mjs").TxId} TxId
 */

export class ConnectorP2P {
	/** @type {PendingRequest | null} */		pendingLedgerRequest = null;
	/** @type {PendingRequest | null} */		pendingBlocksHeadersRequest = null;
	/** @type {PendingRequest | null} */		pendingTransactionsRequest = null;
	/** @type {PendingRequest | null} */		pendingRoundsLegitimaciesRequest = null;
	/** @type {Record<string, Function[]>} */	listeners = {};

	get height() { return this.sync.consensusMerger.best?.blockHeight || -1; }
	get hash() { return this.sync.consensusMerger.best?.blockHash || ''; }
	get isConsensusRobust() { return this.sync.consensusMerger.best?.isRobust || false; }
	get prevHash() { return this.blocks.finalized[this.hash]?.prevHash; }
	get lastBlock() { return this.blocks.finalized[this.hash]; }
	p2pNode;
	sync;

	// BLOCKS STORAGE
	blocksHashesByHeight = /** @type {Object<number, string[]>} */ ({});
	blockWeightByHash = /** @type {Object<string, number>} */ ({});
	blocks = {
		finalized: /** @type {Object<string, BlockFinalized>} */ ({}),
	}

	// TXS STORAGE
	/** @type {Map<string, { address: string, amount: number, rule: string }>} */
	utxosByAnchors = new Map();
	/** @type {Map<string, Transaction>} */
	txsById = new Map();

	/** @param {import('hive-p2p').Node} p2pNode */
	constructor(p2pNode) {
		this.p2pNode = p2pNode;
		this.sync = new Sync({ p2p: p2pNode, blockchain: undefined }); // blockchain is not needed for the visualizer, but Sync expects it in the constructor
		//p2pNode.onGossipData = (msg) => this.#handleMessage(msg);
		p2pNode.onPeerConnect(this.#onPeerConnect);
		p2pNode.onPeerDisconnect(this.#onPeerDisconnect);
		p2pNode.gossip.on('block_finalized', this.#onBlockFinalized);
		p2pNode.messager.on('transactions', this.#onTransactions);
		p2pNode.messager.on('address_ledger', this.#onAddressLedger);
		p2pNode.messager.on('blocks_headers', this.#onBlocksHeaders);
		p2pNode.messager.on('rounds_legitimacies', this.#onRoundsLegitimacies);
		this.#consensusChangeDetectionLoop();
	}
	getBlockConfirmationTimestampApproximation(blockHeight = 0) {
		const lastBlockTimestamp = this.blocks.finalized[this.hash]?.timestamp;
		if (!lastBlockTimestamp) return null;

		const heightDifference = this.height - blockHeight;
		const approxTimestamp = lastBlockTimestamp - heightDifference * BLOCKCHAIN_SETTINGS.targetBlockTime;
		return approxTimestamp;
	}
	/** @param {string} type @param {Function} callback */
	on(type, callback) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(callback);
	}
	/** @param {number} [height] */
	async getMissingBlock(height = this.height) {
		const peersToAsk = this.sync.getUpdatedPeersToAskList();
		for (const peerId of peersToAsk) {
			const blockBytes = await this.sync.fetchBlockFromPeer(peerId, height);
			if (!blockBytes) continue;

			const block = this.#storeBlock(blockBytes);
			if (block) return block;
		}
	}
	/** @param {number} height */
	async getBlockRelatedToCurrentConsensus(height) {
		if (height < 0 || height > this.height) return;

		let h = this.hash;
		let i = this.height;
		while (i > -1) {
			const block = this.blocks.finalized[h];
			if (!block) break; // fetch needed
			if (i === height) return block;
			h = block.prevHash;
			i--;
		}

		// IF ONLY ONE BLOCK AT THIS HEIGHT, RETURN IT
		const hashesAtHeight = this.blocksHashesByHeight[height];
		if (hashesAtHeight && hashesAtHeight.length === 1) return this.blocks.finalized[hashesAtHeight[0]];

		// NOT FOUND, FETCH FROM PEERS
		return this.getMissingBlock(height);
	}
	/** @param {string} address */
	async getAddressLedger(address, timeout = 3000) {
		const peersToAsk = this.sync.getUpdatedPeersToAskList();
		for (const peerId of peersToAsk) {
			this.pendingLedgerRequest = new PendingRequest(peerId, 'address_ledger', timeout);
			this.p2pNode.messager.sendUnicast(peerId, address, 'address_ledger_request');
			try {
				/** @type {AddressLedger} */
				const response = await this.pendingLedgerRequest.promise;
				return response;
			} catch (error) {}
		}
	}
	/** @param {TxId[]} txIds */
	async getTransactions(txIds, timeout = 5000, force = false) {
		// only fetch transactions for which we don't have the implied UTXOs (which means we don't have the transaction details)
		const txIdsToFetch = force ? txIds : txIds.filter(txId => !this.utxosByAnchors.has(txId));
		const peersToAsk = this.sync.getUpdatedPeersToAskList();
		for (const peerId of peersToAsk) {
			console.log(`Requesting transactions ${txIdsToFetch} from peer ${peerId}`);
			const serializedTxIds = serializer.serialize.txsIdsArray(txIdsToFetch);
			this.pendingTransactionsRequest = new PendingRequest(peerId, 'transactions', timeout);
			this.p2pNode.messager.sendUnicast(peerId, serializedTxIds, 'transactions_request');
			try {
				const serialized = await this.pendingTransactionsRequest.promise;
				const r = serializer.deserialize.transactionsResponse(serialized);
				for (const anchor in r.impliedUtxos) this.utxosByAnchors.set(anchor, r.impliedUtxos[anchor]);
				for (const txId in r.txs) this.txsById.set(txId, r.txs[txId]);
				break; // stop after the first successful response
			} catch (/** @type {any} */ error) { console.log(`Unable to fetch transactions from peer ${peerId}:`, error.stack || error.message || error); }
		}

		/** @type {Transaction[]} */
		const txs = [];
		for (const txId of txIds) // @ts-ignore
			if (this.txsById.has(txId)) txs.push(this.txsById.get(txId));
			else throw new Error(`Transaction with id ${txId} not found after fetching from peers`);

		return txs;
	}
	/** Max number of blocks: 60 @param {number} [fromHeight] default: 0 @param {number} [toHeight] default: this.height */
	async getBlocksHeaders(fromHeight = 0, toHeight = this.height, timeout = 3000) {
		const t = Math.min(toHeight, this.height);
		const min = Math.max(0, t - 59);
		const f = Math.max(min, Math.min(fromHeight, t));
		if (f > t) return null; // invalid range
		const peersToAsk = this.sync.getUpdatedPeersToAskList();
		for (const peerId of peersToAsk) {
			this.pendingBlocksHeadersRequest = new PendingRequest(peerId, 'blocks_headers', timeout);
			const s = serializer.serialize.blocksRangeRequest(f, t);
			this.p2pNode.messager.sendUnicast(peerId, s, 'blocks_headers_request');
			try {
				const response = await this.pendingBlocksHeadersRequest.promise;
				if (!response) throw new Error('No response received');

				const r1 = new BinaryReader(response);
				const serializedHeaders = r1.readPointersAndExtractDataChunks();
				/** @type {BlockFinalizedHeader[]} */ const headers = [];
				for (const headerBuffer of serializedHeaders) {
					const r2 = new BinaryReader(headerBuffer);
					const { index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce } = serializer.deserialize.blockHeader(r2, 'finalized');
					if (!posTimestamp || !timestamp || !hash || !nonce) throw new Error(`Corrupted block header`);
					headers.push(new BlockFinalizedHeader(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce));
				}
				return headers;
			} catch (error) {}
		}
	}
	async getRoundsLegitimacies(timeout = 5000) {
		if (!this.prevHash) return null;

		const peersToAsk = this.sync.getUpdatedPeersToAskList();
		for (const peerId of peersToAsk) {
			this.pendingRoundsLegitimaciesRequest = new PendingRequest(peerId, 'rounds_legitimacies', timeout);
			const s = serializer.converter.hexToBytes(this.prevHash);
			this.p2pNode.messager.sendUnicast(peerId, s, 'rounds_legitimacies_request');
			try {
				const response = await this.pendingRoundsLegitimaciesRequest.promise;
				if (response) return serializer.deserialize.roundsLegitimaciesResponse(response);
			} catch (error) {}
		}
	}
	
	// INTERNAL METHODS
	#lastConsensus = { blockHeight: -1, blockHash: '' };
	async #consensusChangeDetectionLoop() {
		setInterval(() => {
			const best = this.sync.consensusMerger.best;
			if (!best) return; // no consensus at all

			if (best.blockHeight === this.#lastConsensus.blockHeight && best.blockHash === this.#lastConsensus.blockHash) return; // no change in consensus
			this.#lastConsensus = { blockHeight: best.blockHeight, blockHash: best.blockHash };
			console.log(`Consensus height changed #${this.height} | Robust: ${best.isRobust}(c: ${best.count}, r: ${best.ratio})`);

			if (!this.blocks.finalized[this.hash]) this.getMissingBlock();
			for (const handler of this.listeners['consensus_height_change'] || []) handler(this.height);
		}, 200);
	}
	#onPeerConnect = () => {
		console.log(`New peer connected! Total neighbors: ${this.p2pNode.peerStore.neighborsList.length}`);
		for (const handler of this.listeners['peer_connect'] || []) handler();
		if (this.p2pNode.peerStore.neighborsList.length !== 1) return;
		for (const handler of this.listeners['connection_established'] || []) handler();
	};
	#onPeerDisconnect = () => {
		console.log(`Peer disconnected! Total neighbors: ${this.p2pNode.peerStore.neighborsList.length}`);
		this.sync.reset(); // if we just had 0 peer => reset consensus.
		for (const handler of this.listeners['peer_disconnect'] || []) handler();
	}
	/** @param {Uint8Array} serializedBlock */
	#storeBlock(serializedBlock) {
		try {
			const block = serializer.deserialize.blockFinalized(serializedBlock);
			this.blocks.finalized[block.hash] = block;
			if (!this.blocksHashesByHeight[block.index]) this.blocksHashesByHeight[block.index] = [];
			if (!this.blocksHashesByHeight[block.index].includes(block.hash)) this.blocksHashesByHeight[block.index].push(block.hash);
			this.blockWeightByHash[block.hash] = serializedBlock.length;
			return block;
		} catch (error) {}
	}
	/** @param {any} msg */
	#handleMessage = (msg) => {
		console.log('Connector received message:', msg);
		for (const handler of this.listeners[msg.type] || []) handler(msg.data);
	}
	/** @param {GossipMessage} msg */
	#onBlockFinalized = (msg) => {
		if (!(msg.data instanceof Uint8Array)) return; // not the expected data type
		if (!this.#storeBlock(msg.data)) return;
		for (const handler of this.listeners['block_finalized'] || []) handler(msg.data);
	};
	/** @param {DirectMessage} msg */
	#onAddressLedger = (msg) => {
		const { senderId, data } = msg;
		if (this.pendingLedgerRequest?.peerId !== senderId) return; // not the expected sender
		this.pendingLedgerRequest.complete(data);
		this.pendingLedgerRequest = null;
	}
	/** @param {DirectMessage} msg */
	#onTransactions = (msg) => {
		const { senderId, data } = msg;
		if (this.pendingTransactionsRequest?.peerId !== senderId) return; // not the expected sender
		this.pendingTransactionsRequest.complete(data);
		this.pendingTransactionsRequest = null;
	}
	/** @param {DirectMessage} msg */
	#onBlocksHeaders = (msg) => {
		const { senderId, data } = msg;
		if (this.pendingBlocksHeadersRequest?.peerId !== senderId) return; // not the expected sender
		this.pendingBlocksHeadersRequest.complete(data);
		this.pendingBlocksHeadersRequest = null;
	}
	/** @param {DirectMessage} msg */
	#onRoundsLegitimacies = (msg) => {
		const { senderId, data } = msg;
		if (this.pendingRoundsLegitimaciesRequest?.peerId !== senderId) return; // not the expected sender
		this.pendingRoundsLegitimaciesRequest.complete(data);
		this.pendingRoundsLegitimaciesRequest = null;
	}
}