

export class Connector {
	/** @type {Record<string, Function[]>} */
	listeners = {};
	p2pNode;

	/** @param {import('hive-p2p').Node} p2pNode */
	constructor(p2pNode) {
		this.p2pNode = p2pNode;
		//p2pNode.onGossipData = (msg) => this.#handleMessage(msg);
		p2pNode.gossip.on('block_finalized', this.#onBlockFinalized);
	}

	on(type, callback) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(callback);
	}

	// INTERNAL METHODS
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