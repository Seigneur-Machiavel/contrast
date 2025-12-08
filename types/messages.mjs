
/**
 * @typedef {import('../types/block.mjs').BlockData} BlockData
 */

export class BLOCK_CANDIDATE_MSG {
	/** @param {BlockData} blockCandidate */
	constructor(blockCandidate) {
		this.type = 'blockCandidate';
		this.data = blockCandidate;
	}
}

export class BLOCK_FINALIZED_MSG {
	/** @param {BlockData} finalizedBlock */
	constructor(finalizedBlock) {
		this.type = 'new_block_finalized';
		this.data = finalizedBlock;
	}
}

export const MESSAGE = {
	VERSION: 1,
	BLOCK_CANDIDATE_MSG,
}