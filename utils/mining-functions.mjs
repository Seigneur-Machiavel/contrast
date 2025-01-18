import { conditionnals } from './conditionnals.mjs';
import { typeValidation } from './type-validation.mjs';
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from './blockchain-settings.mjs';

/**
* @typedef {import("../node/src/block-classes.mjs").BlockData} BlockData
*/

export const mining = {
    /** @param {BlockData} lastBlock @returns {number} - New difficulty */
    difficultyAdjustment: (lastBlock, averageBlockTimeMS, logs = true) => {
        const blockIndex = lastBlock.index;
        const difficulty = lastBlock.difficulty;

        if (typeof difficulty !== 'number') { console.error('Invalid difficulty'); return 1; }
        if (difficulty < 1) { console.error('Invalid difficulty < 1'); return 1; }

        if (typeof blockIndex !== 'number') { console.error('Invalid blockIndex'); return difficulty; }
        if (blockIndex === 0) { return difficulty; }
        if (blockIndex % MINING_PARAMS.blocksBeforeAdjustment !== 0) { return difficulty; }

        const deviation = 1 - (averageBlockTimeMS / BLOCKCHAIN_SETTINGS.targetBlockTime);
        const deviationPercentage = deviation * 100; // over zero = too fast / under zero = too slow

        if (logs) {
            console.log(`BlockIndex: ${blockIndex} | Average block time: ${Math.round(averageBlockTimeMS)}ms`);
            console.log(`Deviation: ${deviation.toFixed(4)} | Deviation percentage: ${deviationPercentage.toFixed(2)}%`);
        }

        const diffAdjustment = Math.floor(Math.abs(deviationPercentage) / MINING_PARAMS.thresholdPerDiffIncrement);
        const capedDiffIncrement = Math.min(diffAdjustment, MINING_PARAMS.maxDiffIncrementPerAdjustment);
        const diffIncrement = deviation > 0 ? capedDiffIncrement : -capedDiffIncrement;
        const newDifficulty = Math.max(difficulty + diffIncrement, 1); // cap at 1 minimum

        if (logs) {
            const state = diffIncrement === 0 ? 'maintained' : diffIncrement > 0 ? 'increased' : 'decreased';
            console.log(`Difficulty ${state} ${state !== 'maintained' ? "by: " + diffIncrement + " => " : ""}${state === 'maintained' ? 'at' : 'to'}: ${newDifficulty}`);
        }

        return newDifficulty;
    },
    /** @param {BlockData} blockData - undefined if genesis block */
    calculateNextCoinbaseReward(blockData) {
        if (!blockData) { throw new Error('Invalid blockData'); }

        const halvings = Math.floor( (blockData.index + 1) / BLOCKCHAIN_SETTINGS.halvingInterval );
        const coinBases = [BLOCKCHAIN_SETTINGS.rewardMagicNb1, BLOCKCHAIN_SETTINGS.rewardMagicNb2];
        for (let i = 0; i < halvings + 1; i++) {
            coinBases.push(coinBases[coinBases.length - 2] - coinBases[coinBases.length - 1]);
        }

        const coinBase = Math.max(coinBases[coinBases.length - 1], BLOCKCHAIN_SETTINGS.minBlockReward);
        const maxSupplyWillBeReached = blockData.supply + coinBase >= BLOCKCHAIN_SETTINGS.maxSupply;
        return maxSupplyWillBeReached ? BLOCKCHAIN_SETTINGS.maxSupply - blockData.supply : coinBase;
    },
    /** @param {BlockData} lastBlock @param {BlockData} olderBlock */
    calculateAverageBlockTime: (lastBlock, olderBlock) => {
        if (!olderBlock) { return BLOCKCHAIN_SETTINGS.targetBlockTime; }
        if (lastBlock.index <= olderBlock.index) { return BLOCKCHAIN_SETTINGS.targetBlockTime; }

        const periodInterval = lastBlock.timestamp - olderBlock.timestamp;
        const blockCount = lastBlock.index - olderBlock.index;
        return periodInterval / blockCount;
    },
    /** @param {number} length - Nonce length in bytes */
    generateRandomNonce: (length = MINING_PARAMS.nonceLength) => {
        const Uint8 = new Uint8Array(length);
        crypto.getRandomValues(Uint8);

        const Hex = Array.from(Uint8).map(b => b.toString(16).padStart(2, '0')).join('');
        return { Uint8, Hex };
    },
    /**
     * This function uses an Argon2 hash function to perform a hashing operation.
     * The Argon2 hash function must follow the following signature:
     * - argon2HashFunction(pass, salt, time, mem, parallelism, type, hashLen)
     *
     *@param {function(string, string, number=, number=, number=, number=, number=): Promise<false | { encoded: string, hash: Uint8Array, hex: string, bitsArray: number[] }>} argon2HashFunction
     *@param {string} blockSignature - Block signature to hash
     *@param {string} nonce - Nonce to hash
    */
    hashBlockSignature: async (argon2HashFunction, blockSignature = '', nonce = '') => {
        const { time, mem, parallelism, type, hashLen } = MINING_PARAMS.argon2;
        const newBlockHash = await argon2HashFunction(blockSignature, nonce, time, mem, parallelism, type, hashLen);
        if (!newBlockHash) { return false; }

        return newBlockHash;
    },
    /** @param {BlockData} blockData */
    getBlockFinalDifficulty: (blockData) => {
        const { difficulty, legitimacy, posTimestamp, timestamp } = blockData;
        const powTimestamp = timestamp || posTimestamp + BLOCKCHAIN_SETTINGS.targetBlockTime;

        if (!typeValidation.numberIsPositiveInteger(posTimestamp)) { throw new Error('Invalid posTimestamp'); }
        if (!typeValidation.numberIsPositiveInteger(powTimestamp)) { throw new Error('Invalid timestamp'); }

        const differenceRatio = (powTimestamp - posTimestamp) / BLOCKCHAIN_SETTINGS.targetBlockTime;
        const timeDiffAdjustment = MINING_PARAMS.maxTimeDifferenceAdjustment - Math.round(differenceRatio * MINING_PARAMS.maxTimeDifferenceAdjustment);
        
        const legitimacyAdjustment = legitimacy * MINING_PARAMS.diffAdjustPerLegitimacy;
        const finalDifficulty = Math.max(difficulty + timeDiffAdjustment + legitimacyAdjustment, 1); // cap at 1 minimum

        return { difficulty, timeDiffAdjustment, legitimacy, finalDifficulty };
    },
    /** @param {number} difficulty */
    decomposeDifficulty: (difficulty = 1) => {
        const zeros = Math.floor(difficulty / 16);
        const adjust = difficulty % 16;
        return { zeros, adjust };
    },
    /** @param {string} HashBitsAsString @param {BlockData} blockData */
    verifyBlockHashConformToDifficulty: (HashBitsAsString = '', blockData) => {
        if (typeof HashBitsAsString !== 'string') { return false; } //throw new Error('Invalid HashBitsAsString'); }

        const { difficulty, timeDiffAdjustment, legitimacy, finalDifficulty } = mining.getBlockFinalDifficulty(blockData);
        const { zeros, adjust } = mining.decomposeDifficulty(finalDifficulty);

        const result = { conform: false, message: 'na', difficulty, timeDiffAdjustment, legitimacy, finalDifficulty, zeros, adjust };

        const condition1 = conditionnals.binaryStringStartsWithZeros(HashBitsAsString, zeros);
        if (!condition1) { result.message = `unlucky--(condition 1)=> hash does not start with ${zeros} zeros | finalDifficulty: ${finalDifficulty} | HashBitsAsString: ${HashBitsAsString}` };

        const next5Bits = HashBitsAsString.substring(zeros, zeros + 5);
        const condition2 = conditionnals.binaryStringSupOrEqual(next5Bits, adjust);
        if (!condition2) { result.message = `unlucky--(condition 2)=> hash does not meet the condition: ${next5Bits} >= ${adjust} | finalDifficulty: ${finalDifficulty} | HashBitsAsString: ${HashBitsAsString}` };

        if (result.message === 'na') { result.conform = true; result.message = 'lucky'; }
        return result;
    }
};