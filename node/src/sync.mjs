// @ts-check
import { BlockHeightHash } from '../../types/sync.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { PendingRequest } from '../../utils/networking.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';

/**
 * @typedef {import("../../node_modules/hive-p2p/core/unicast.mjs").DirectMessage} DirectMessage
 * @typedef {import("../../node_modules/hive-p2p/core/gossip.mjs").GossipMessage} GossipMessage
 * 
 * @typedef {Object} MinimalContrastNode
 * @property {import('hive-p2p').Node} p2p
 * @property {undefined} blockchain
 * 
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("./blockchain.mjs").Blockchain} Blockchain
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("../../types/sync.mjs").BlockHeightHashStr} BlockHeightHashStr */

export class Sync {
	logger = new MiniLogger('sync');
	/** @type {PendingRequest | null} */
	pendingBlockRequest = null;
	/** @type {Uint8Array | null} */
	myStatusSerialized = null;
	/** Key: peerId, value: BHH @type {Object<string, BlockHeightHashStr>} */
	peersStatus = {};
	/** Key: BHH, value: peerId @type {Object<string, Set<string>>} */
	peersByBHH = {}; // NOT INCLUDE SELF
	node;

	/** @param {ContrastNode | MinimalContrastNode} node */
	constructor(node) {
		this.node = node;	// @ts-ignore
		node.p2p.onPeerConnect(() => setTimeout(() => this.shareMyStatus(1), 1_000));
		node.p2p.gossip.on('sync_status', this.#onSyncStatus);
		node.p2p.messager.on('block_request', this.#onBlockRequest);
		node.p2p.messager.on('block', this.#onBlock);
	}

	// API METHODS
	get isSynced() {
		const c = this.getConsensus();
		if (c.equality || c.count === 0) return false;
		if (!this.node.blockchain?.lastBlock) return false;
		return c.blockHash === this.node.blockchain.lastBlock.hash;
	}
	/** Strategy: rollback to consensus block, then fetch missing blocks from random peers
	* - If a peer fails or sends invalid data, remove it and retry with another 
	* - On digestion failure, undo last block and retry from previous block
	* - Stop when consensus is reached or max attempts reached
	* @param {number} [maxAttempts] Default: 10 */
	async catchUpWithNetwork(maxAttempts = 10) {
		if (!this.node.blockchain) return;

		const bc = this.node.blockchain;
		let attempts = 0;
		do {	// UPDATE CONSENSUS STATUS
			const c = this.getConsensus();
			if (attempts && c.blockHash === bc.lastBlock?.hash) this.logger.log(`IN CONSENSUS at block #${c.blockHeight}`, (m, c) => console.log(m, c));
			if (c.equality || c.count === 0) return; // No clear consensus
			if (c.blockHash === bc.lastBlock?.hash) return; // We are in consensus
			if (bc.currentHeight === c.blockHeight + 1) return; // We are just ahead

			// ROLLBACK UNTIL CONSENSUS BLOCK AND CATCH UP
			const peersToAsk = this.getPeersToAskList(c.blockHeight, c.blockHash);
			await bc.undoBlock(true); // ROLLBACK AT LEAST ONE BLOCK TO AVOID STUCKING
			while (bc.currentHeight > c.blockHeight) await bc.undoBlock(true);

			if (!attempts) this.logger.log(`Catching up with network to h:${c.blockHeight} (hash: ${c.blockHash}) from ${peersToAsk.length} peers`, (m, c) => console.log(m, c));
			attempts++;

			// DOWNLOAD AND APPLY BLOCKS UNTIL REASONABLE GAP
			/** @type {string | null} */
			let peerIdToRestore = null;
			this.node.updateState(`Syncing from #${bc.currentHeight} to #${c.blockHeight}`);
			while (bc.currentHeight < c.blockHeight) {
				if (c.count < 6) { // Small network: tolerance to fetching from the same peer multiple times.
					if (peerIdToRestore) peersToAsk.push(peerIdToRestore);
					peerIdToRestore = null;
				}

				const nextHeight = bc.currentHeight + 1;
				const index = Math.floor(Math.random() * peersToAsk.length);
				const peerId = peersToAsk[index];
				if (!peerId || (peerIdToRestore && peerId === peerIdToRestore)) {
					await new Promise(r => setTimeout(r, 2000)); // wait a bit before retrying
					break;
				}
				
				peersToAsk.splice(index, 1); // Don't use same peer for next block
				if (peerIdToRestore) peersToAsk.push(peerIdToRestore); // restore previously removed peer (if any) to try again later

				this.logger.log(`Fetching block #${nextHeight} from peer ${peerId}`, (m, c) => console.log(m, c));
				const blockBytes = await this.fetchBlockFromPeer(peerId, nextHeight);
				if (!blockBytes) { // failed to fetch block from this peer, try another
					this.logger.log(`Fetch failure for block #${nextHeight} from peer ${peerId}`, (m, c) => console.error(m, c));
					continue;
				}

				const success = await bc.digestFinalizedBlock(this.node, blockBytes, { isSync: true });
				if (success) { peerIdToRestore = peerId; continue; } // Able to digest > continue routine.

				// Unable to digest >  undo last block, retry from previous
				this.logger.log(`Failed #${nextHeight} digest => undo one block`, (m, c) => console.error(m, c));
				await bc.undoBlock(true); // if undo fails, just reset everything to be sure
			}
		} while (attempts < maxAttempts);
	}
	getConsensus() {
		/** @type {Object<BlockHeightHashStr, number>} */
		const occurences = {};
		for (const peerId in this.peersStatus) {
			const bhh = this.peersStatus[peerId];
			occurences[bhh] = (occurences[bhh] || 0) + 1;
		}

		const myBHH = this.peersStatus[this.node?.p2p.id];
		const myBhhObj = myBHH ? BlockHeightHash.fromString(myBHH) : null;
		const result = { blockHeight: -1, blockHash: '', count: 0, equality: false };
		for (const bhh in occurences) {
			if (occurences[bhh] < result.count) continue;

			// PREFER HIGHER BLOCK HEIGHT IN CASE OF TIE
			const bhhObj = BlockHeightHash.fromString(bhh);
			const equality = occurences[bhh] === result.count;
			if (equality && bhhObj.blockHeight < result.blockHeight) continue;

			// PREFER OWN CHAIN IN CASE OF SAME HEIGHT TIE
			const sameHeight = bhhObj.blockHeight === result.blockHeight;
			if (sameHeight && myBhhObj?.blockHeight === bhhObj.blockHeight)
				if (myBhhObj?.blockHash !== bhhObj.blockHash) continue; // prefer own status in case of tie
			
			result.blockHeight = bhhObj.blockHeight;
			result.blockHash = bhhObj.blockHash;
			result.count = occurences[bhh];
			result.equality = equality;
		}

		return result;
	}
	/** @param {number} blockHeight @param {string} blockHash */
	getPeersToAskList(blockHeight, blockHash) {
		const bhh = BlockHeightHash.toString(blockHeight, blockHash);
		const peersToAsk = []; // All consensus peers except self
		for (const peerId of this.peersByBHH[bhh] || new Set())
			if (peerId !== this.node.p2p.id) peersToAsk.push(peerId); // Don't ask self
		return peersToAsk;
	}
	/** @param {string} peerId @param {number} height @returns {Promise<Uint8Array | undefined>} */
	async fetchBlockFromPeer(peerId, height, timeout = 3000) {
		try {
			this.pendingBlockRequest = new PendingRequest(peerId, 'block', timeout);
			const heightInt32 = serializer.converter.numberTo4Bytes(height);
			this.node.p2p.messager.sendUnicast(peerId, heightInt32, 'block_request', 1);
			const serializedBlock = await this.pendingBlockRequest.promise;
			return serializedBlock;
		} catch (error) {}
		this.pendingBlockRequest = null;
	}
	/** @param {BlockFinalized} block */
	setAndshareMyStatus(block) {
		this.myStatusSerialized = serializer.serialize.blockHeightHash(block.index, block.hash);
		this.peersStatus[this.node.p2p.id] = BlockHeightHash.toString(block.index, block.hash);
		this.shareMyStatus();
	}
	/** @param {number} [HOPS] */
	shareMyStatus(HOPS) {
		if (!this.myStatusSerialized) return;
		const options = { topic: 'sync_status' }; // @ts-ignore
		if (HOPS) options.HOPS = HOPS;
		this.node.p2p.broadcast(this.myStatusSerialized, options);
	}

	// INTERNAL HANDLERS
	/** @param {GossipMessage} msg */
	#onSyncStatus = (msg) => {
		const { senderId, data, HOPS } = msg;
		if (!(data instanceof Uint8Array)) return; // not the expected data type
		try {
			const { blockHeight, blockHash } = serializer.deserialize.blockHeightHash(data);
			const oldBHH = this.peersStatus[senderId];
			if (oldBHH) { // remove old status
				this.peersByBHH[oldBHH]?.delete(senderId);
				if (this.peersByBHH[oldBHH]?.size === 0) delete this.peersByBHH[oldBHH];
			}

			const bhh = BlockHeightHash.toString(blockHeight, blockHash);
			if (!this.peersByBHH[bhh]) this.peersByBHH[bhh] = new Set();
			this.peersByBHH[bhh].add(senderId);
			this.peersStatus[senderId] = bhh;
		} catch (/** @type {any} */ error) { this.logger.log(`[SYNC] -onSyncStatus- Error deserializing sync status from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	/** @param {DirectMessage} msg */
	#onBlockRequest = async (msg) => {
		if (!this.node.blockchain) return;

		const { senderId, data, route } = msg;
		this.logger.log(`[SYNC] Received block request from ${senderId} (${route})`, (m, c) => console.log(m, c));
		
		if (!(data instanceof Uint8Array) || data.length !== 4) return; // invalid request
		const height = serializer.converter.bytes4ToNumber(data);
		const b = this.node.blockchain.blockStorage.getBlockBytes(height, false)?.blockBytes;
		if (b) this.node.p2p.messager.sendUnicast(senderId, b, 'block', 1);
		if (b) this.logger.log(`[SYNC] Sent block #${height} to ${senderId}`, (m, c) => console.log(m, c));
	}
	/** @param {DirectMessage} msg */
	#onBlock = async (msg) => {
		const { senderId, data, route } = msg;
		this.logger.log(`[SYNC] Received block data from ${senderId} (${route})`, (m, c) => console.log(m, c));

		if (this.pendingBlockRequest?.peerId !== senderId) return; // not the expected sender
		if (!(data instanceof Uint8Array)) return; // invalid data type
		this.pendingBlockRequest.complete(data);
		this.pendingBlockRequest = null;
	}
}