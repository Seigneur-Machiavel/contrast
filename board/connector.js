// @ts-check
import { Sync } from '../node/src/sync.mjs';
import { serializer } from '../utils/serializer.mjs';
import { PendingRequest } from '../utils/networking.mjs';

/**
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("../storage/ledgers-store.mjs").AddressLedger} AddressLedger
 */

export class Connector {
	/** @type {PendingRequest | null} */		pendingLedgerRequest = null;
	/** @type {PendingRequest | null} */		pendingTimestampsRequest = null;
	/** @type {PendingRequest | null} */		pendingRoundsLegitimaciesRequest = null;
	/** @type {Record<string, Function[]>} */	listeners = {};
	get prevHash() { return this.blocks.finalized[this.hash]?.prevHash; }
	isConsensusRobust = false;
	height = -1;
	hash = '';
	p2pNode;
	sync;

	// BLOCKS STORAGE
	blocksHashesByHeight = /** @type {Object<number, string[]>} */ ({});
	blockWeightByHash = /** @type {Object<string, number>} */ ({});
	blocks = {
		finalized: /** @type {Object<string, BlockFinalized>} */ ({}),
	}

	/** @param {import('hive-p2p').Node} p2pNode */
	constructor(p2pNode) {
		this.p2pNode = p2pNode;
		this.sync = new Sync({ p2p: p2pNode });
		//p2pNode.onGossipData = (msg) => this.#handleMessage(msg);
		p2pNode.onPeerConnect(this.#onPeerConnect);
		p2pNode.gossip.on('block_finalized', this.#onBlockFinalized);
		p2pNode.messager.on('address_ledger', this.#onAddressLedger);
		p2pNode.messager.on('blocks_timestamps', this.#onBlocksTimestamps);
		p2pNode.messager.on('rounds_legitimacies', this.#onRoundsLegitimacies);
		this.#consensusChangeDetectionLoop();
	}

	/** @param {string} type @param {Function} callback */
	on(type, callback) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(callback);
	}
	/** @param {number} [height] @param {Object} [consensus] @param {number} consensus.height @param {string} consensus.hash */
	async getMissingBlock(height = this.height, consensus = { height: this.height, hash: this.hash }) {
		const peersToAsk = this.sync.getPeersToAskList(consensus.height, consensus.hash);
		for (const peerId of peersToAsk) {
			const blockBytes = await this.sync.fetchBlockFromPeer(peerId, height);
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
		const peersToAsk = this.sync.getPeersToAskList(this.height, this.hash);
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
	/** Max number of blocks: 120 @param {number} [fromHeight] default: 0 @param {number} [toHeight] default: this.height */
	async getBlocksTimestamps(fromHeight = 0, toHeight = this.height, timeout = 3000) {
		const t = Math.min(toHeight, this.height);
		const min = Math.max(0, t - 119);
		const f = Math.max(min, Math.min(fromHeight, t));
		const peersToAsk = this.sync.getPeersToAskList(this.height, this.hash);
		for (const peerId of peersToAsk) {
			this.pendingTimestampsRequest = new PendingRequest(peerId, 'blocks_timestamps', timeout);
			const s = serializer.serialize.blocksTimestampsRequest(f, t);
			this.p2pNode.messager.sendUnicast(peerId, s, 'blocks_timestamps_request');
			try {
				const response = await this.pendingTimestampsRequest.promise;
				if (response) return serializer.deserialize.blocksTimestampsResponse(response);
			} catch (error) {}
		}
	}
	async getRoundsLegitimacies(timeout = 5000) {
		if (!this.prevHash) return null;

		const peersToAsk = this.sync.getPeersToAskList(this.height, this.hash);
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
	async #consensusChangeDetectionLoop() {
		while(true) {
			await new Promise(r => setTimeout(r, 200));
			const c = this.sync.getConsensus();
			if (this.height === c.blockHeight && this.hash === c.blockHash) continue; // No change
			this.isConsensusRobust = !c.equality && c.count >= 1;
			this.height = c.blockHeight;
			this.hash = c.blockHash;
			console.log(`Consensus height changed #${this.height} | Robust: ${this.isConsensusRobust}(c: ${c.count})`);

			if (!this.blocks.finalized[this.hash]) this.getMissingBlock();
			for (const handler of this.listeners['consensus_height_change'] || []) handler(this.height);
		}
	}
	#onPeerConnect = () => {
		console.log(`New peer connected! Total neighbors: ${this.p2pNode.peerStore.neighborsList.length}`);
		if (this.p2pNode.peerStore.neighborsList.length !== 1) return;
		this.isConsensusRobust = false; this.height = -1; this.hash = ''; // reset consensus data
		for (const handler of this.listeners['connection_established'] || []) handler();
	};
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
	/** @param {string} senderId @param {Uint8Array} data @param {number} HOPS */
	#onBlockFinalized = (senderId, data, HOPS) => {
		if (!this.#storeBlock(data)) return;
		for (const handler of this.listeners['block_finalized'] || []) handler(data);
	};
	/** @param {string} senderId @param {any} data */
	#onAddressLedger = (senderId, data) => {
		if (this.pendingLedgerRequest?.peerId !== senderId) return; // not the expected sender
		this.pendingLedgerRequest.complete(data);
		this.pendingLedgerRequest = null;
	}
	/** @param {string} senderId @param {Uint8Array} data */
	#onBlocksTimestamps = (senderId, data) => {
		if (this.pendingTimestampsRequest?.peerId !== senderId) return; // not the expected sender
		this.pendingTimestampsRequest.complete(data);
		this.pendingTimestampsRequest = null;
	}
	/** @param {string} senderId @param {Uint8Array} data */
	#onRoundsLegitimacies = (senderId, data) => {
		if (this.pendingRoundsLegitimaciesRequest?.peerId !== senderId) return; // not the expected sender
		this.pendingRoundsLegitimaciesRequest.complete(data);
		this.pendingRoundsLegitimaciesRequest = null;
	}
}