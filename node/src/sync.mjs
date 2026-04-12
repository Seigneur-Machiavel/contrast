// @ts-check
import { BlockHeightHash } from '../../types/sync.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { PendingRequest } from '../../utils/networking.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { CONSENSUS } from '../../config/blockchain-settings.mjs';

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

class SelectedConsensus {
	blockHeight = -1;
	blockHash = '';
	count = 0;
	ratio = 0;
	get isRobust() {
		if (this.count < CONSENSUS.minConsensusPeers) return false;
		if (this.ratio < CONSENSUS.minConsensusRatio) return false;
		return true;
	}
	
	/** @param {BlockHeightHashStr} bhhStr @param {number} count */
	setValues(bhhStr, count) {
		const bhh = BlockHeightHash.fromString(bhhStr);
		this.blockHeight = bhh.blockHeight;
		this.blockHash = bhh.blockHash;
		this.count = count;
	}
	/** If secondBestCount is 0, we consider count as ratio to pass the CONSENSUS requirements. @param {number} secondBestCount */
	calculateRatio(secondBestCount) {
		if (!this.count || !secondBestCount) this.ratio = this.count;
		else this.ratio = this.count / secondBestCount;
	}
}

class ConsensusMerger {
	/** @type {SelectedConsensus | null} */
	#bestSelectedConsensus = null;
	//needsUpdate = false;
	myPeerId;
	/** Key: peerId, value: BHH @type {Object<string, BlockHeightHashStr>} */
	peersStatus = {};
	/** Key: BHH, value: peerId @type {Object<string, Set<string>>} */
	peersByBHH = {}; // NOT INCLUDE SELF

	get best() {
		this.#updateConsensus();
		return this.#bestSelectedConsensus;
	}

	/** @param {string} myPeerId */
	constructor(myPeerId) { this.myPeerId = myPeerId; }

	#updateConsensus() {
		if (this.#bestSelectedConsensus) return;

		/** @type {Record<BlockHeightHashStr, number>} */
		const occurences = {};
		for (const peerId in this.peersStatus) {
			const bhhStr = this.peersStatus[peerId];
			occurences[bhhStr] = (occurences[bhhStr] || 0) + 1;
		}

		const [ best, secondBest ] = [new SelectedConsensus(), new SelectedConsensus()];
		for (const bhhStr in occurences)
			if (occurences[bhhStr] > best.count) best.setValues(bhhStr, occurences[bhhStr]);
			else if (occurences[bhhStr] > secondBest.count) secondBest.setValues(bhhStr, occurences[bhhStr]);

		best.calculateRatio(secondBest.count);
		this.#bestSelectedConsensus = best;
	}
	/** @param {string} peerId @param {number} blockHeight @param {string} blockHash */
	add(peerId, blockHeight, blockHash) {
		const oldBHH = this.peersStatus[peerId];
		if (oldBHH) this.remove(peerId, oldBHH);

		const bhh = BlockHeightHash.toString(blockHeight, blockHash);
		if (!this.peersByBHH[bhh]) this.peersByBHH[bhh] = new Set();
		this.peersByBHH[bhh].add(peerId);
		this.peersStatus[peerId] = bhh;

		//this.needsUpdate = true;
		this.#bestSelectedConsensus = null; // reset best consensus to force recalculation on next access
	}
	/** @param {string} peerId @param {BlockHeightHashStr} bhh */
	remove(peerId, bhh) {
		this.peersByBHH[bhh]?.delete(peerId);
		if (this.peersByBHH[bhh]?.size === 0) delete this.peersByBHH[bhh];
	}
	/** @param {number} blockHeight @param {string} blockHash */
	getPeersToAskList(blockHeight, blockHash) {
		const bhh = BlockHeightHash.toString(blockHeight, blockHash);
		const peersToAsk = []; // All consensus peers except self
		for (const peerId of this.peersByBHH[bhh] || new Set())
			if (peerId !== this.myPeerId) peersToAsk.push(peerId); // Don't ask self
		return peersToAsk;
	}
}

export class Sync {
	logger = new MiniLogger('sync');
	consensusMerger;
	node;

	/** @type {PendingRequest | null} */
	pendingBlockRequest = null;
	/** @type {Uint8Array | null} */
	myStatusSerialized = null;

	/** @param {ContrastNode | MinimalContrastNode} node */
	constructor(node) {
		this.node = node;
		this.consensusMerger = new ConsensusMerger(node.p2p.id);
		node.p2p.onPeerConnect(() => setTimeout(() => this.shareMyStatus(1), 1_000));
		node.p2p.gossip.on('sync_status', this.#onSyncStatus);
		node.p2p.messager.on('block_request', this.#onBlockRequest);
		node.p2p.messager.on('block', this.#onBlock);
	}

	// API METHODS
	get isSynced() {
		if (!this.node.blockchain?.lastBlock) return { sameHeight: false, isRobust: false }; // not synced if we don't have any block

		const best = this.consensusMerger.best;
		const sameHeight = best?.blockHash === this.node.blockchain.lastBlock.hash;
		return { sameHeight, isRobust: best?.isRobust };
	}
	/** Retreive a list of peers to ask for a specific block height and hash.
	 * - Both params need to be filled or left empty together resulting in using the best consensus block height and hash.
	 * @param {number} [height] @param {string} [hash] */
	getUpdatedPeersToAskList(height, hash) {
		const best = this.consensusMerger.best;
		const he = typeof height === 'number' ? height : best?.blockHeight || -1;
		const ha = typeof hash === 'string' ? hash : best?.blockHash || '';
		return this.consensusMerger.getPeersToAskList(he, ha);
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
		do {
			const best = this.consensusMerger.best;
			if (!best?.isRobust) return; // NOT CLEAR CONSENSUS, ABORT SYNC

			const { blockHeight, blockHash, count } = best;
			if (attempts && blockHash === bc.lastBlock?.hash) this.logger.log(`[SYNC-DONE] IN CONSENSUS at block #${blockHeight}`, (m, c) => console.log(m, c));
			if (blockHash === bc.lastBlock?.hash) return; // WE ARE IN CONSENSUS
			if (bc.currentHeight === blockHeight + 1) return; // WE ARE JUST AHEAD, MAYBE BLOCK WILL COME SOON, LET'S NOT RISK ROLLING BACK

			const peersToAsk = this.consensusMerger.getPeersToAskList(blockHeight, blockHash);
			await bc.undoBlock(true); // ROLLBACK AT LEAST ONE BLOCK TO AVOID STUCKING
			while (bc.currentHeight > blockHeight) await bc.undoBlock(true);

			if (!attempts) this.logger.log(`[SYNC-OUT] Catching up with network to h:${blockHeight} (hash: ${blockHash}) from ${peersToAsk.length} peers`, (m, c) => console.log(m, c));
			attempts++;

			// DOWNLOAD AND APPLY BLOCKS UNTIL REASONABLE GAP
			/** @type {string | null} */
			let peerIdToRestore = null;
			this.node.updateState(`Syncing from #${bc.currentHeight} to #${blockHeight}`);
			while (bc.currentHeight < blockHeight) {
				if (count < 6) { // Small network: tolerance to fetching from the same peer multiple times.
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

				this.logger.log(`[SYNC-OUT] Fetching block #${nextHeight} from peer ${peerId}`, (m, c) => console.log(m, c));
				const blockBytes = await this.fetchBlockFromPeer(peerId, nextHeight);
				if (!blockBytes) { // failed to fetch block from this peer, try another
					this.logger.log(`[SYNC-OUT] Fetch failure for block #${nextHeight} from peer ${peerId}`, (m, c) => console.error(m, c));
					continue;
				}

				const success = await bc.digestFinalizedBlock(this.node, blockBytes, { isSync: true });
				if (success) { peerIdToRestore = peerId; continue; } // Able to digest > continue routine.

				// Unable to digest >  undo last block, retry from previous
				this.logger.log(`[SYNC-OUT] Failed #${nextHeight} digest => undo one block`, (m, c) => console.error(m, c));
				await bc.undoBlock(true); // if undo fails, just reset everything to be sure
			}
		} while (attempts < maxAttempts);
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
		this.consensusMerger.add(this.node.p2p.id, block.index, block.hash);
		this.shareMyStatus();
	}
	/** @param {number} [HOPS] */
	shareMyStatus(HOPS) {
		if (!this.myStatusSerialized) return;
		const options = { topic: 'sync_status' }; // @ts-ignore
		if (HOPS) options.HOPS = HOPS;
		this.node.p2p.broadcast(this.myStatusSerialized, options);
	}
	reset() {
		this.consensusMerger = new ConsensusMerger(this.node.p2p.id);
		this.myStatusSerialized = null;
	}

	// INTERNAL HANDLERS
	/** @param {GossipMessage} msg */
	#onSyncStatus = (msg) => {
		const { senderId, data, HOPS } = msg;
		if (!(data instanceof Uint8Array)) return; // not the expected data type
		try {
			const { blockHeight, blockHash } = serializer.deserialize.blockHeightHash(data);
			this.consensusMerger.add(senderId, blockHeight, blockHash);
		} catch (/** @type {any} */ error) { this.logger.log(`[SYNC] -onSyncStatus- Error deserializing sync status from ${senderId}: ${error.message}`, (m, c) => console.error(m, c)); }
	}
	/** @param {DirectMessage} msg */
	#onBlockRequest = async (msg) => {
		if (!this.node.blockchain) return;

		const { senderId, data, route } = msg;
		this.logger.log(`[SYNC-IN] Received block request from ${senderId} (${route})`, (m, c) => console.log(m, c));
		
		if (!(data instanceof Uint8Array) || data.length !== 4) return; // invalid request
		const height = serializer.converter.bytes4ToNumber(data);
		const b = this.node.blockchain.blockStorage.getBlockBytes(height, false)?.blockBytes;
		if (b) this.node.p2p.messager.sendUnicast(senderId, b, 'block', 1);
		if (b) this.logger.log(`[SYNC-IN] Sent block #${height} to ${senderId}`, (m, c) => console.log(m, c));
	}
	/** @param {DirectMessage} msg */
	#onBlock = async (msg) => {
		const { senderId, data, route } = msg;
		this.logger.log(`[SYNC-IN] Received block data from ${senderId} (${route})`, (m, c) => console.log(m, c));

		if (this.pendingBlockRequest?.peerId !== senderId) return; // not the expected sender
		if (!(data instanceof Uint8Array)) return; // invalid data type
		this.pendingBlockRequest.complete(data);
		this.pendingBlockRequest = null;
	}
}