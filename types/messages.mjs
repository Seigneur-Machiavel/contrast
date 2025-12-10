
/**
 * @typedef {import('../types/block.mjs').BlockCandidate} BlockCandidate
 * @typedef {import('../types/block.mjs').BlockFinalized} BlockFinalized
 */

export class BLOCK_CANDIDATE_MSG {
	/** @param {BlockCandidate} blockCandidate */
	constructor(blockCandidate) {
		this.type = 'blockCandidate';
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

export const MESSAGE = {
	VERSION: 1,
	BLOCK_CANDIDATE_MSG,
}