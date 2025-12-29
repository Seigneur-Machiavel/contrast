
/**
 * @typedef {import('../types/block.mjs').BlockCandidate} BlockCandidate
 * @typedef {import('../types/block.mjs').BlockFinalized} BlockFinalized
 * @typedef {import('../node/src/sync.mjs').BlockInfo} BlockInfo
 */

// PROBABLY DEPRECATING THAT ENTIRE FILE

export class BLOCK_CANDIDATE_MSG {
	/** @param {BlockCandidate} blockCandidate */
	constructor(blockCandidate) {
		this.type = 'block_candidate';
		this.data = blockCandidate;
	}
}

export class BLOCK_FINALIZED_MSG {
	/** @param {BlockFinalized} finalizedBlock */
	constructor(finalizedBlock) {
		this.type = 'new_block_finalized';
		this.data = finalizedBlock;
	}
}

export class PEER_STATUS_MSG {
	/** @param {Uint8Array} blockInfo */
	constructor(height, blockHash) {
	}
}

export const MESSAGE = {
	VERSION: 1,
	BLOCK_CANDIDATE_MSG,
}