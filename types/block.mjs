// @ts-check
/**
 * @typedef {import('./transaction.mjs').Transaction} Transaction
 */

export class BlockCandidateHeader {
	/** @param {number} index - The block height @param {number} supply - The total supply before the coinbase reward @param {number} coinBase - The coinbase reward @param {number} difficulty - The difficulty of the block @param {number} legitimacy - The legitimacy of the validator who created the block candidate @param {string} prevHash - The hash of the previous block @param {number} posTimestamp - The timestamp of the block creation */
	constructor(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp) {
		this.index = index;
		this.supply = supply;
		this.coinBase = coinBase;
		this.difficulty = difficulty;
		this.legitimacy = legitimacy;
		this.prevHash = prevHash;
		this.posTimestamp = posTimestamp;
	}
}

export class BlockFinalizedHeader extends BlockCandidateHeader {
	/** @param {number} index - The block height @param {number} supply - The total supply before the coinbase reward @param {number} coinBase - The coinbase reward @param {number} difficulty - The difficulty of the block @param {number} legitimacy - The legitimacy of the validator who created the block candidate @param {string} prevHash - The hash of the previous block @param {number} posTimestamp - The timestamp of the block creation @param {number} timestamp - The timestamp of the block @param {string} hash - The hash of the block @param {string} nonce - The nonce of the block */
	constructor(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce) {
		super(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp);
		this.timestamp = timestamp;
		this.hash = hash;
		this.nonce = nonce;
	}
}

export class BlockCandidate extends BlockCandidateHeader {
	/** @param {number} index - The block height @param {number} supply - The total supply before the coinbase reward @param {number} coinBase - The coinbase reward @param {number} difficulty - The difficulty of the block @param {number} legitimacy - The legitimacy of the validator who created the block candidate @param {string} prevHash - The hash of the previous block @param {import('./transaction.mjs').Transaction[]} Txs - The transactions in the block @param {number} posTimestamp - The timestamp of the block creation @param {number} [powReward] - The reward for the proof of work (only in candidate) */
	constructor(index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, powReward) {
		super(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp);
		this.Txs = Txs;
		this.powReward = powReward;
	}
}

export class BlockFinalized extends BlockFinalizedHeader {
	/** @param {number} index - The block height @param {number} supply - The total supply before the coinbase reward @param {number} coinBase - The coinbase reward @param {number} difficulty - The difficulty of the block @param {number} legitimacy - The legitimacy of the validator who created the block candidate @param {string} prevHash - The hash of the previous block @param {import('./transaction.mjs').Transaction[]} Txs - The transactions in the block @param {number} posTimestamp - The timestamp of the block creation @param {number} timestamp - The timestamp of the block @param {string} hash - The hash of the block @param {string} nonce - The nonce of the block */
	constructor(index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, timestamp, hash, nonce) {
		super(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce);
		this.Txs = Txs;
	}

	// HELPERS
	/** @param {BlockFinalized} block */
	static minerAddress(block) { return block.Txs[0].outputs[0].address; }
	/** @param {BlockFinalized} block */
	static validatorAddress(block) { return block.Txs[1].outputs[0].address; }
	/** @param {BlockFinalized} block */
	static calculateRewards(block) {
		const powReward = block.Txs[0].outputs[0].amount; // Coinbase tx
		const posReward = block.Txs[1].outputs[0].amount; // Validator tx
		const totalReward = powReward + posReward;
		const totalFees = totalReward - block.coinBase;
		return { powReward, posReward, totalReward, totalFees };
	}
}

export class BlockInfo {
	/** @param {BlockCandidateHeader | BlockFinalizedHeader} header @param {number} totalFees @param {number} lowerFeePerByte @param {number} higherFeePerByte @param {number} blockBytes @param {number} nbOfTxs */
	constructor(header, totalFees, lowerFeePerByte, higherFeePerByte, blockBytes, nbOfTxs) {
		this.header = header;
		this.totalFees = totalFees;
		this.lowerFeePerByte = lowerFeePerByte;
		this.higherFeePerByte = higherFeePerByte;
		this.blockBytes = blockBytes;
		this.nbOfTxs = nbOfTxs;
	}
}

export class BlockMiningData {
	/** @param {number} index - The block height @param {number} difficulty - The difficulty of the block @param {number} timestamp - The timestamp of the block @param {number} posTimestamp - The timestamp of the block's creation */
	constructor(index, difficulty, timestamp, posTimestamp) {
		this.index = index;
		this.difficulty = difficulty;
		this.timestamp = timestamp;
		this.posTimestamp = posTimestamp;
	}
}

export const BLOCK = {
	VERSION: 1,
	BlockCandidateHeader,
	BlockFinalizedHeader,
	BlockCandidate,
	BlockFinalized,
	BlockInfo,
	BlockMiningData,
};