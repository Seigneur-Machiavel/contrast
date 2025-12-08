/**
 * @typedef {import('./transaction.mjs').Transaction} Transaction
 */

export class BlockHeader {
	/** @param {number} index - The block height @param {number} supply - The total supply before the coinbase reward @param {number} coinBase - The coinbase reward @param {number} difficulty - The difficulty of the block @param {number} legitimacy - The legitimacy of the validator who created the block candidate @param {string} prevHash - The hash of the previous block @param {number} posTimestamp - The timestamp of the block creation @param {number | undefined} [timestamp] - The timestamp of the block @param {string | undefined} [hash] - The hash of the block @param {number | undefined} [nonce] - The nonce of the block */
	constructor(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce) {
		this.index = index;
		this.supply = supply;
		this.coinBase = coinBase;
		this.difficulty = difficulty;
		this.legitimacy = legitimacy;
		this.prevHash = prevHash;
		this.posTimestamp = posTimestamp;
		this.timestamp = timestamp;
		this.hash = hash;
		this.nonce = nonce;
	}
}
export class BlockData extends BlockHeader {
	/** @param {number} index - The index of the block @param {number} supply - The total supply before the coinbase reward @param {number} coinBase - The coinbase reward @param {number} difficulty - The difficulty of the block @param {number} legitimacy - The legitimacy of the validator who created the block candidate @param {string} prevHash - The hash of the previous block @param {import('./transaction.mjs').Transaction[]} Txs - The transactions in the block @param {number | undefined} posTimestamp - The timestamp of the block creation @param {number | undefined} timestamp - The timestamp of the block @param {string | undefined} hash - The hash of the block @param {number | undefined} nonce - The nonce of the block @param {number | undefined} [powReward] - The reward for the proof of work (only in candidate) */
	constructor(index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, timestamp, hash, nonce, powReward) {
		super(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce);
		this.Txs = Txs;
		this.powReward = powReward;
	}
}

export class BlockInfo {
	/** @param {BlockHeader} header @param {number} totalFees @param {number} lowerFeePerByte @param {number} higherFeePerByte @param {number} blockBytes @param {number} nbOfTxs */
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
	BlockHeader,
	BlockData,
	BlockInfo,
	BlockMiningData,
};