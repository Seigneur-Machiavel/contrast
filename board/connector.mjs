// @ts-check
import { Sync } from '../node/src/sync.mjs';

export class Connector {
	/** @type {Record<string, Function[]>} */
	listeners = {};
	p2pNode;
	sync;

	/** @param {import('hive-p2p').Node} p2pNode */
	constructor(p2pNode) {
		this.p2pNode = p2pNode;
		this.sync = new Sync({ p2p: p2pNode });
		//p2pNode.onGossipData = (msg) => this.#handleMessage(msg);
		p2pNode.gossip.on('block_finalized', this.#onBlockFinalized);
	}

	/** @param {string} type @param {Function} callback */
	on(type, callback) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(callback);
	}

	// INTERNAL METHODS
	/** @param {any} msg */
	#handleMessage = (msg) => {
		console.log('Connector received message:', msg);
		for (const handler of this.listeners[msg.type] || []) handler(msg.data);
	}
	/** @param {string} senderId @param {Uint8Array} data @param {number} HOPS */
	#onBlockFinalized = (senderId, data, HOPS) => {
		console.log('Connector received block_finalized from', senderId, 'HOPS:', HOPS);
		//this.taskQueue.push('DigestBlock', data);
	};
}