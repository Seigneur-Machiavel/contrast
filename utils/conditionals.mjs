// @ts-check
import { IS_VALID } from '../types/validation.mjs';
import { MiniLogger } from '../miniLogger/mini-logger.mjs';
import { BLOCKCHAIN_SETTINGS, SOLVING } from '../config/blockchain-settings.mjs';

/**
 * @typedef {import("../node/src/conCrypto.mjs").argon2Hash} argon2Hash
 * @typedef {import("../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("../types/block.mjs").BlockFinalizedHeader} BlockFinalizedHeader */

export const conditionnals = {
    /** Check if the string starts with a certain amount of zeros @param {string} string @param {number} zeros */
    binaryStringStartsWithZeros: (string, zeros) => {
        if (typeof string !== 'string') return false;
        if (typeof zeros !== 'number') return false;
        if (zeros < 0) return false;

        const target = '0'.repeat(zeros);
        return string.startsWith(target);
    },
    /** Check if the string as binary is superior or equal to the target @param {string} string @param {number} minValue */
    binaryStringSupOrEqual: (string = '', minValue = 0) => {
        if (typeof string !== 'string') return false;
        if (typeof minValue !== 'number') return false;
        if (minValue < 0) return false;

        const intValue = parseInt(string, 2);
        return intValue >= minValue;
    },
    /** Check if the array contains duplicates @param {any[]} array */
    arrayIncludeDuplicates(array) {
        return (new Set(array)).size !== array.length;
    },
};
 
 const logger = new MiniLogger('solving-functions');
export const solving = {
    /** @param {BlockFinalizedHeader[]} periodBlocks @param {number} [targetBlockTime] */
    difficultyAdjustment: (periodBlocks, targetBlockTime = BLOCKCHAIN_SETTINGS.targetBlockTime, logs = true) => {
        const finalDifficulties = [], difficulties = [];
		for (const block of periodBlocks) {
			finalDifficulties.push(solving.getBlockFinalDifficulty(block).finalDifficulty);
			difficulties.push(block.difficulty);
		}

		const firstBlock = periodBlocks[0];
		const lastBLock = periodBlocks[periodBlocks.length - 1];
		const averageBlockTimeMS = solving.calculateAverageBlockTime(lastBLock, firstBlock);
		//const averageBlockTimeMS = blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length;
		const timeDeviation = 1 - (averageBlockTimeMS / targetBlockTime);

		const avgFinalDifficulty = finalDifficulties.reduce((a, b) => a + b, 0) / finalDifficulties.length;
		const avgDifficulty = difficulties.reduce((a, b) => a + b, 0) / difficulties.length;
		const diffDeviation = Math.round(avgFinalDifficulty - avgDifficulty);

		const diffAdjustment = Math.floor(timeDeviation * 100 / SOLVING.thresholdPerDiffIncrement);
		const diffDevAdjustment = Math.floor(diffDeviation / SOLVING.thresholdPerDiffIncrement);
		const sum = diffAdjustment + diffDevAdjustment;
		const capedDiffIncrement = Math.min(Math.abs(sum), SOLVING.maxDiffIncrementPerAdjustment);
		const diffIncrement = sum > 0 ? capedDiffIncrement : -capedDiffIncrement;
        const newDifficulty = Math.max(lastBLock.difficulty + diffIncrement, 1);
		
		/*const deviation = 1 - (averageBlockTimeMS / targetBlockTime);
        const deviationPercentage = deviation * 100; // over zero = too fast / under zero = too slow

        if (logs) {
            logger.log(`BlockIndex: ${blockIndex} | Average block time: ${Math.round(averageBlockTimeMS)}ms (target: ${targetBlockTime}ms)`, (m, c) => console.info(m, c));
            logger.log(`Deviation: ${deviation.toFixed(4)} | Deviation percentage: ${deviationPercentage.toFixed(2)}%`, (m, c) => console.info(m, c));
        }

        const diffAdjustment = Math.floor(Math.abs(deviationPercentage) / SOLVING.thresholdPerDiffIncrement);
        const capedDiffIncrement = Math.min(diffAdjustment, SOLVING.maxDiffIncrementPerAdjustment);
        const diffIncrement = deviation > 0 ? capedDiffIncrement : -capedDiffIncrement;
        const newDifficulty = Math.max(difficulty + diffIncrement, 1); // cap at 1 minimum*/

        if (logs) {
            const state = diffIncrement === 0 ? 'maintained' : diffIncrement > 0 ? 'increased' : 'decreased';
            logger.log(`Difficulty ${state} ${state !== 'maintained' ? "by: " + diffIncrement + " => " : ""}${state === 'maintained' ? 'at' : 'to'}: ${newDifficulty}`, (m, c) => console.info(m, c));
        }

        return newDifficulty;
    },
    /** @param {BlockCandidate | BlockFinalized} blockData - undefined if genesis block */
    calculateNextCoinbaseReward(blockData) {
        if (!blockData) throw new Error('Invalid blockData');

        const halvings = Math.floor( (blockData.index + 1) / BLOCKCHAIN_SETTINGS.halvingInterval );
        const coinBases = [BLOCKCHAIN_SETTINGS.rewardMagicNb1, BLOCKCHAIN_SETTINGS.rewardMagicNb2];
        for (let i = 0; i < halvings + 1; i++) {
            coinBases.push(coinBases[coinBases.length - 2] - coinBases[coinBases.length - 1]);
        }

        const coinBase = Math.max(coinBases[coinBases.length - 1], BLOCKCHAIN_SETTINGS.minBlockReward);
        const maxSupplyWillBeReached = blockData.supply + coinBase >= BLOCKCHAIN_SETTINGS.maxSupply;
        return maxSupplyWillBeReached ? BLOCKCHAIN_SETTINGS.maxSupply - blockData.supply : coinBase;
    },
    /** @param {BlockFinalized | BlockFinalizedHeader} lastBlock @param {BlockFinalized | BlockFinalizedHeader} [olderBlock] */
    calculateAverageBlockTime: (lastBlock, olderBlock) => {
        if (!olderBlock) return BLOCKCHAIN_SETTINGS.targetBlockTime;
        if (lastBlock.index <= olderBlock.index) return BLOCKCHAIN_SETTINGS.targetBlockTime;

        const periodInterval = lastBlock.timestamp - olderBlock.timestamp;
        const blockCount = lastBlock.index - olderBlock.index;
        return periodInterval / blockCount;
    },
    /** @param {number} length - Nonce length in bytes */
    generateRandomNonce: (length = SOLVING.nonceLength) => {
        const Uint8 = new Uint8Array(length);
        crypto.getRandomValues(Uint8);

        const Hex = Array.from(Uint8).map(b => b.toString(16).padStart(2, '0')).join('');
        return { Uint8, Hex };
    },
    betPowTime: (min = .7, max = .9, targetBlockTime = BLOCKCHAIN_SETTINGS.targetBlockTime) => {
        const random = Math.random() * (max - min) + min; // random number between min and max
        const betTime = Math.round(targetBlockTime * random); // multiply by targetBlockTime to get the bet time in ms
        //logger.log(`Bet time: ${betTime}ms`, (m, c) => console.info(m, c));
        return betTime;
    },
    /** This function uses an Argon2 hash function to perform a hashing operation.
     * @param {argon2Hash} argon2HashFunction
     * @param {string} blockSignature - Block signature to hash
     * @param {string} nonce - Nonce to hash */
    hashBlockSignature: async (argon2HashFunction, blockSignature = '', nonce = '') => {
        const { time, mem, parallelism, type, hashLen } = SOLVING.argon2;
        const newBlockHash = await argon2HashFunction(blockSignature, nonce, mem, time, parallelism, type, hashLen);
        return newBlockHash;
    },
    /** @param {BlockCandidate | BlockFinalized | BlockFinalizedHeader} blockData */
    getBlockFinalDifficulty: (blockData, targetBlockTime = BLOCKCHAIN_SETTINGS.targetBlockTime) => {
        const { difficulty, legitimacy, posTimestamp } = blockData;
		const timestamp = 'timestamp' in blockData ? blockData.timestamp : undefined;
        const powTimestamp = timestamp || (posTimestamp + targetBlockTime);

        if (!IS_VALID.POSITIVE_INTEGER(posTimestamp)) throw new Error('Invalid posTimestamp');
        if (!IS_VALID.POSITIVE_INTEGER(powTimestamp)) throw new Error('Invalid timestamp');

        const differenceRatio = (powTimestamp - posTimestamp) / targetBlockTime;
        const timeDiffAdjustment = SOLVING.maxTimeDifferenceAdjustment - Math.round(differenceRatio * SOLVING.maxTimeDifferenceAdjustment);
        const legitimacyAdjustment = legitimacy * SOLVING.diffAdjustPerLegitimacy;
        const finalDifficulty = Math.max(difficulty + timeDiffAdjustment + legitimacyAdjustment, 1); // cap at 1 minimum
        return { difficulty, timeDiffAdjustment, legitimacy, finalDifficulty };
    },
    /** @param {number} difficulty */
    decomposeDifficulty: (difficulty = 1) => {
        const zeros = Math.floor(difficulty / 16);
        const adjust = difficulty % 16;
        return { zeros, adjust };
    },

    /** @param {string} HashBitsAsString @param {BlockFinalized} block */
    verifyBlockHashConformToDifficulty: (HashBitsAsString = '', block) => {
		const { difficulty, timeDiffAdjustment, legitimacy, finalDifficulty } = solving.getBlockFinalDifficulty(block);
        const { zeros, adjust } = solving.decomposeDifficulty(finalDifficulty);
        const result = { conform: false, message: 'na', difficulty, timeDiffAdjustment, legitimacy, finalDifficulty, zeros, adjust };
		if (typeof HashBitsAsString !== 'string') {
			result.message = 'invalid HashBitsAsString';
			return result;
		}

        const condition1 = conditionnals.binaryStringStartsWithZeros(HashBitsAsString, zeros);
        if (!condition1) result.message = `unlucky--(condition 1)=> hash does not start with ${zeros} zeros | finalDifficulty: ${finalDifficulty} | HashBitsAsString: ${HashBitsAsString}`;

        const next5Bits = HashBitsAsString.substring(zeros, zeros + 5);
        const condition2 = conditionnals.binaryStringSupOrEqual(next5Bits, adjust);
        if (!condition2) result.message = `unlucky--(condition 2)=> hash does not meet the condition: ${next5Bits} >= ${adjust} | finalDifficulty: ${finalDifficulty} | HashBitsAsString: ${HashBitsAsString}`;

        if (result.message === 'na') { result.conform = true; result.message = 'lucky'; }
        return result;
    },
	/** @param {BlockFinalizedHeader[]} blockFinalizedHeaders */
	estimateGlobalHashrate: (blockFinalizedHeaders) => {
		if (blockFinalizedHeaders.length === 0) return 0;

		let totalAttempts = 0;
		for (const block of blockFinalizedHeaders) {
			const { finalDifficulty } = solving.getBlockFinalDifficulty(block);
			totalAttempts += Math.pow(2, finalDifficulty / 16);
		}

		const avgAttempts = totalAttempts / blockFinalizedHeaders.length;
		return avgAttempts / (BLOCKCHAIN_SETTINGS.targetBlockTime / 1000);
	}
};