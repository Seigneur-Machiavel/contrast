// @ts-check
import { Sync } from '../node/src/sync.mjs';
import { serializer } from '../utils/serializer.mjs';

/**
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized
 */

export class Connector {
	/** @type {Record<string, Function[]>} */
	listeners = {};
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
		p2pNode.gossip.on('block_finalized', this.#onBlockFinalized);
		this.#consensusChangeDetectionLoop();
	}

	/** @param {string} type @param {Function} callback */
	on(type, callback) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(callback);
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

			if (!this.blocks.finalized[this.hash]) this.getMissingBlock(this.height, this.hash);
			for (const handler of this.listeners['consensus_height_change'] || []) handler(this.height);
		}
	}
	/** @param {number} height @param {string} hash */
	async getMissingBlock(height, hash) {
		const peersToAsk = this.sync.getPeersToAskList(height, hash);
		for (const peerId of peersToAsk) {
			const blockBytes = await this.sync.fetchBlockFromPeer(peerId, height);
			if (this.#storeBlock(blockBytes)) return true;
		}
	}
	/** @param {Uint8Array} serializedBlock */
	#storeBlock(serializedBlock) {
		try {
			const block = serializer.deserialize.blockFinalized(serializedBlock);
			this.blocks.finalized[block.hash] = block;
			if (!this.blocksHashesByHeight[block.index]) this.blocksHashesByHeight[block.index] = [];
			if (!this.blocksHashesByHeight[block.index].includes(block.hash)) this.blocksHashesByHeight[block.index].push(block.hash);
			this.blockWeightByHash[block.hash] = serializedBlock.length;
			return true;
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
}