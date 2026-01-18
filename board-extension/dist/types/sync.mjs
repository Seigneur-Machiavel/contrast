
/**
 * @typedef {string} BlockHeightHashStr
 */

export class BlockHeightHash {
	/** @param {number} blockHeight @param {string} blockHash */
	constructor(blockHeight, blockHash) {
		this.blockHeight = blockHeight;
		this.blockHash = blockHash;
	}

	static toString(height, hash) { return `${height}:${hash}`; }
	static fromString(s) {
		const [heightStr, hash] = s.split(':');
		return new BlockHeightHash(parseInt(heightStr, 10), hash);
	}
}