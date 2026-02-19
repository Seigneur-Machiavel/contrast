import { NetworkRenderer } from './NetworkRenderer.mjs';

/**
 * @typedef {import('../../node_modules/hive-p2p/core/unicast.mjs').DirectMessage} DirectMessage
 * @typedef {import('../../node_modules/hive-p2p/core/gossip.mjs').GossipMessage} GossipMessage
 */

export class NetworkVisualizer {
	connector; node;
	CryptoCodex;
	lastPeerInfo;
	networkRenderer = new NetworkRenderer();
	peersList = {};

	/** @param {import('../connector.js').Connector} connector @param {import('hive-p2p').CryptoCodex} CryptoCodex @param {boolean} isSimulation */
	constructor(connector, CryptoCodex, updateInfoInterval = 400) {
		this.connector = connector;
		this.node = connector.p2pNode;
		this.CryptoCodex = CryptoCodex;
		this.#initWhileRendererReady(updateInfoInterval);
	}
	
	async #initWhileRendererReady(updateInfoInterval) {
		await this.networkRenderer.initWhileDomReady();

		this.#resetNetwork(connector.p2pNode.id);
		setInterval(() => {
			const info = this.#getPeerInfo();
			this.#updateNetworkFromPeerInfo(info);
			this.networkRenderer.updateStats(this.node.topologist.NEIGHBORS_TARGET);
		}, updateInfoInterval);

		// This one will not work because we needs to handle all msg types,
		// -> but messager.on('..') => return message.data
		//this.node.onMessageData((fromId, message) => this.displayDirectMessageRoute(fromId, message.route));
		//this.node.onGossipData((fromId, message) => this.displayGossipMessageRoute(fromId, message));
		
		// Test
		//this.node.onGossipData((msg) => this.displayGossipMessageRoute(msg.senderId, msg.data));
		
		// Solution => handle specific messages types/topics.
		// If we want to display all messages => refer to 'hive-p2p/simultion/simul-utils.mjs'
		//this.node.onMessageData((msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		//this.node.onPrivateMessageData((msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('message', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('handshake', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('signal_answer', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('signal_offer', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('privacy', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('private_message', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('block', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('address_ledger', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('blocks_timestamps', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));
		this.node.messager.on('rounds_legitimacies', (msg) => this.displayDirectMessageRoute(msg.senderId, msg.route));

		this.node.gossip.on('gossip', (msg) => this.displayGossipMessageRoute(msg.senderId, msg));
		this.node.gossip.on('signal_offer', (msg) => this.displayGossipMessageRoute(msg.senderId, msg));
		this.node.gossip.on('peer_connected', (msg) => this.displayGossipMessageRoute(msg.senderId, msg));
		this.node.gossip.on('peer_disconnected', (msg) => this.displayGossipMessageRoute(msg.senderId, msg));
		this.node.gossip.on('block_candidate', (msg) => this.displayGossipMessageRoute(msg.senderId, msg));
		this.node.gossip.on('block_finalized', (msg) => this.displayGossipMessageRoute(msg.senderId, msg));
		this.node.gossip.on('sync_status', (msg) => this.displayGossipMessageRoute(msg.senderId, msg));
		this.node.gossip.on('transaction', (msg) => this.displayGossipMessageRoute(msg.senderId, msg));
	}

	/** Param: nodeId:string */
	onNodeLeftClick(callback) { this.networkRenderer.onNodeLeftClick = callback; }
	/** Param: nodeId:string */
	onNodeRightClick(callback) { this.networkRenderer.onNodeRightClick = callback; }
	displayDirectMessageRoute(fromId, route) {
		//console.log('Displaying direct message route from', fromId, 'with route:', route);
		this.networkRenderer.displayDirectMessageRoute(fromId, route);
	}
	displayGossipMessageRoute(fromId, data) { 
		//console.log('Displaying gossip message route from', fromId, 'with data:', data);
		this.networkRenderer.displayGossipMessageRoute(fromId, data.senderId, data.topic, data.data);
	}
	onKeyDown(e) {
		if (e.key === 'ArrowUp') console.log('ArrowUp');
		if (e.key === 'ArrowDown') console.log('ArrowDown');
		if (e.code === 'Space') this.networkRenderer.isPhysicPaused = !this.networkRenderer.isPhysicPaused;
	}

	#resetNetwork(nodeId) {
		this.networkRenderer.maxDistance = 0; // reset maxDistance to show all nodes
		this.networkRenderer.avoidAutoZoomUntil = Date.now() + 2000; // avoid auto-zoom for 2 seconds
		this.networkRenderer.lastAutoZoomDistance = 0;
		this.networkRenderer.clearNetwork();
		this.networkRenderer.setCurrentPeer(nodeId);
	}	
	#getPeerInfo() {
		return {
			id: this.node.id,
			store: {
				connected: this.node.peerStore.neighborsList, // ids only
				connecting: Object.keys(this.node.peerStore.connecting), // ids only
				known: this.node.peerStore.known
			}
		}
	}
	#updateNetworkFromPeerInfo(peerInfo) {
		if (!peerInfo) return;
		this.lastPeerInfo = peerInfo;

		const newlyUpdated = {};
		const digestPeerUpdate = (id = 'toto', status = 'unknown', neighbors = []) => {
			const isPublic = this.CryptoCodex.isPublicNode(id);
			this.networkRenderer.addOrUpdateNode(id, status, isPublic, neighbors);
			newlyUpdated[id] = true;
		}

		const getNeighbors = (peerId) => {
			const knownPeer = peerInfo.store.known[peerId];
			return knownPeer ? Object.keys(knownPeer.neighbors || {}) : [];
		}
		
		const knownToIgnore = {};
		knownToIgnore[this.node.id] = true;
		for (const id of peerInfo.store.connecting) knownToIgnore[id] = true;
		for (const id of peerInfo.store.connected) knownToIgnore[id] = true;
		for (const id in peerInfo.store.known)
			if (!knownToIgnore[id]) digestPeerUpdate(id, 'known', getNeighbors(id));
		
		for (const id of peerInfo.store.connecting) digestPeerUpdate(id, 'connecting', getNeighbors(id));
		for (const id of peerInfo.store.connected) digestPeerUpdate(id, 'connected', getNeighbors(id));

		const nodes = this.networkRenderer.nodesStore.store;
		const nodeIds = this.networkRenderer.nodesStore.getNodesIds();
		for (const id of nodeIds) // filter absent nodes
			if (!newlyUpdated[id] && id !== this.node.id) this.networkRenderer.removeNode(id);

		// ensure current peer is updated
		if (peerInfo.id === this.node.id) digestPeerUpdate(peerInfo.id, 'current', getNeighbors(peerInfo.id));

		// Create connections
		const connections = [];
		for (const id in nodes)
			for (const neighborId of nodes[id].neighbors) connections.push([id, neighborId]);

		//console.log(`Updated network map: ${Object.keys(nodes).length} nodes | ${Object.keys(connections).length} connections`);
		this.networkRenderer.digestConnectionsArray(connections);
	}
}