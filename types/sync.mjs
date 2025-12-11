

/**
 * @typedef {import("./node.mjs").ContrastNode} Node
 * @typedef {import("@libp2p/interface").PeerId} PeerId
 * @typedef {import("@libp2p/interface").Stream} Stream
 * @typedef {import("./blockchain.mjs").Blockchain} Blockchain
 * 
 * @typedef {Object} SyncRequest
 * @property {string} type - 'getStatus' | 'getBlocks' | 'getCheckpoint'
 * @property {number?} startIndex - Only for 'getBlocks'
 * @property {number?} endIndex - Only for 'getBlocks'
 * @property {boolean?} includesBlockInfo - Only for 'getBlocks'
 * @property {string?} checkpointHash - Only for 'getCheckpoint' -> hash of the checkpoint zip archive
 * @property {number?} bytesStart - start byte of the serialized data to continue uploading
 * 
 * @typedef {Object} CheckpointInfo
 * @property {number} height
 * @property {string} hash
 * 
 * @typedef {Object} GetBlocksAnwser
 * @property {Uint8Array[]} blocks
 * @property {Uint8Array[]} blocksInfo
 * 
 * @typedef {Object} SyncStatus
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 * @property {CheckpointInfo} checkpointInfo
 * 
 * @typedef {Object} PeerStatus
 * @property {string} peerIdStr
 * @property {number} currentHeight
 * @property {string} latestBlockHash
 * @property {CheckpointInfo | null} checkpointInfo
 * 
 * @typedef {Object} Consensus
 * @property {number} height
 * @property {number} peers
 * @property {string} blockHash
 * @property {CheckpointInfo | false} checkpointInfo
 * @property {number} checkpointPeers
 */

export class CheckpointInfo {
	/** @param {number} height @param {string} hash */
	constructor(height, hash) {
		this.height = height;
		this.hash = hash;
	}
}

export class SyncStatus {
	/** @param {number} currentHeight @param {string} latestBlockHash @param {CheckpointInfo} checkpointInfo */
	constructor(currentHeight, latestBlockHash, checkpointInfo) {
		this.currentHeight = currentHeight;
		this.latestBlockHash = latestBlockHash;
		this.checkpointInfo = checkpointInfo;
	}
}