const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

//#region Libs imports and type definitions
import { conditionnals } from '../../utils/conditionnals.mjs';
import { convert } from '../../utils/converters.mjs';
import { typeValidation } from '../../utils/type-validation.mjs';
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';

async function msgPackLib() {
    if (isNode) {
        const m = await import('../../libs/msgpack.min.js');
        return m.default;
    }
    return MessagePack;
};
const msgpack = await msgPackLib();

/**
* @typedef {import("./block-classes.mjs").Block} Block
* @typedef {import("./block-classes.mjs").BlockData} BlockData
* @typedef {import("./transaction.mjs").Transaction} Transaction
*/
//#endregion

const compression = {
    msgpack_Zlib: {
        rawData: {
            toBinary_v1(rawData, compress = false) {
                const encoded = msgpack.encode(rawData);
                /** @type {Uint8Array} */
                const readyToReturn = compress ? new Compressor.Zlib.Gzip(encoded).compress() : encoded;
                return readyToReturn;
            },
            /** @param {Uint8Array} binary */
            fromBinary_v1(binary, isCompressed = false) {
                const readyToDecode = isCompressed ? new Decompressor.Zlib.Gunzip(binary).decompress() : binary;
                const decoded = msgpack.decode(readyToDecode);

                return decoded;
            }
        },
        transaction: {
            /** @param {Transaction} tx */
            toBinary_v1(tx) {
                const prepared = compression.msgpack_Zlib.prepareTransaction.toBinary_v1(tx);
                const encoded = msgpack.encode(prepared);
                /** @type {Uint8Array} */
                const compressed = new Compressor.Zlib.Gzip(encoded).compress();
                return compressed;
            },
            /** @param {Uint8Array} binary */
            fromBinary_v1(binary) {
                const decompressed = new Decompressor.Zlib.Gunzip(binary).decompress();
                /** @type {Transaction} */
                const decoded = msgpack.decode(decompressed);
                const finalized = compression.msgpack_Zlib.prepareTransaction.fromBinary_v1(decoded);
                return finalized;
            }
        },
        prepareTransaction: { // ugly, remove if serializer.transaction.[...]_v2 is working
            /** @param {Transaction} tx */
            toBinary_v1(tx) {
                if (typeValidation.hex(tx.id) === false) {
                    throw new Error('Invalid tx.id');
                }
                tx.id = convert.hex.toUint8Array(tx.id); // safe type: hex
                for (let i = 0; i < tx.witnesses.length; i++) {
                    const signature = tx.witnesses[i].split(':')[0];
                    const publicKey = tx.witnesses[i].split(':')[1];
                    tx.witnesses[i] = [convert.hex.toUint8Array(signature), convert.hex.toUint8Array(publicKey)]; // safe type: hex
                }
                for (let j = 0; j < tx.inputs.length; j++) {
                    /*if (isMinerOrValidatorTx) {
                        tx.inputs[j] = convert.hex.toUint8Array(tx.inputs[j]); // case of coinbase/posReward: input = nonce/validatorHash
                        continue;
                    }*/

                    //for (const key in input) { if (input[key] === undefined) { delete input[key]; } } // should not append
                };
                for (let j = 0; j < tx.outputs.length; j++) {
                    const output = tx.outputs[j];
                    for (const key in output) { if (output[key] === undefined) { delete tx.outputs[j][key]; } }
                };

                return tx;
            },
            /** @param {Transaction} decodedTx */
            fromBinary_v1(decodedTx) {
                const tx = decodedTx;
                tx.id = convert.uint8Array.toHex(tx.id); // safe type: uint8 -> hex
                for (let i = 0; i < tx.witnesses.length; i++) {
                    const signature = convert.uint8Array.toHex(tx.witnesses[i][0]); // safe type: uint8 -> hex
                    const publicKey = convert.uint8Array.toHex(tx.witnesses[i][1]); // safe type: uint8 -> hex
                    tx.witnesses[i] = `${signature}:${publicKey}`;
                }
                for (let j = 0; j < tx.inputs.length; j++) {
                    const input = tx.inputs[j];
                    if (typeof input === 'string') { continue; }
                    if (typeValidation.uint8Array(input)) {
                        tx.inputs[j] = convert.uint8Array.toHex(input); // case of coinbase/posReward: input = nonce/validatorHash
                        continue;
                    }
                };

                return tx;
            }
        },
        proposalBlock: {
            /** @param {BlockData} blockData */
            toBinary_v1(blockData) {
                // first block prevHash isn't Hex
                blockData.prevHash = blockData.index !== 0 ? convert.hex.toUint8Array(blockData.prevHash) : blockData.prevHash;
                for (let i = 0; i < blockData.Txs.length; i++) {
                    //const isMinerOrValidatorTx = Transaction_Builder.isMinerOrValidatorTx(blockData.Txs[i]);
                    blockData.Txs[i] = compression.msgpack_Zlib.prepareTransaction.toBinary_v1(blockData.Txs[i]);
                };

                const encoded = msgpack.encode(blockData);
                /** @type {Uint8Array} */
                const compressed = new Compressor.Zlib.Gzip(encoded).compress();
                return compressed;
            },
            /** @param {Uint8Array} binary */
            fromBinary_v1(binary) {
                const decompressed = new Decompressor.Zlib.Gunzip(binary).decompress();
                /** @type {BlockData} */
                const decoded = msgpack.decode(decompressed);

                // first block prevHash isn't Hex
                decoded.prevHash = decoded.index !== 0 ? convert.uint8Array.toHex(decoded.prevHash) : decoded.prevHash;
                for (let i = 0; i < decoded.Txs.length; i++) {
                    decoded.Txs[i] = compression.msgpack_Zlib.prepareTransaction.fromBinary_v1(decoded.Txs[i]);
                };

                return decoded;
            }
        },
        finalizedBlock: {
            /** 
             * @param {BlockData} blockData */
            toBinary_v1(blockData, compress = false) {
                // first block prevHash isn't Hex
                blockData.prevHash = blockData.index !== 0 ? convert.hex.toUint8Array(blockData.prevHash) : blockData.prevHash;
                blockData.hash = convert.hex.toUint8Array(blockData.hash); // safe type: hex
                blockData.nonce = convert.hex.toUint8Array(blockData.nonce); // safe type: hex

                for (let i = 0; i < blockData.Txs.length; i++) {
                    //const isMinerOrValidatorTx = Transaction_Builder.isMinerOrValidatorTx(blockData.Txs[i], i);
                    blockData.Txs[i] = compression.msgpack_Zlib.prepareTransaction.toBinary_v1(blockData.Txs[i]);
                };

                const encoded = msgpack.encode(blockData);
                /** @type {Uint8Array} */
                //const compressed = new Compressor.Zlib.Gzip(encoded).compress();
                const readyToReturn = compress ? new Compressor.Zlib.Gzip(encoded).compress() : encoded;
                return readyToReturn;
            },
            /** @param {Uint8Array} binary */
            fromBinary_v1(binary, compress = false) {
                const readyToDecode = compress ? new Decompressor.Zlib.Gunzip(binary).decompress() : binary;
                /** @type {BlockData} */
                const decoded = msgpack.decode(readyToDecode);

                // first block prevHash isn't Hex
                decoded.prevHash = decoded.index !== 0 ? convert.uint8Array.toHex(decoded.prevHash) : decoded.prevHash;
                decoded.hash = convert.uint8Array.toHex(decoded.hash); // safe type: uint8 -> hex
                decoded.nonce = convert.uint8Array.toHex(decoded.nonce); // safe type: uint8 -> hex

                for (let i = 0; i < decoded.Txs.length; i++) {
                    decoded.Txs[i] = compression.msgpack_Zlib.prepareTransaction.fromBinary_v1(decoded.Txs[i]);
                };

                return decoded;
            }
        }
    },
    Gzip: {
        compress(data) {
            const compressed = new Compressor.Zlib.Gzip(data).compress();
            return compressed;
        },
        decompress(data) {
            const decompressed = new Decompressor.Zlib.Gunzip(data).decompress();
            return decompressed;
        }
    }
};
const mining = {
    /**
    * @param {BlockData} lastBlock
    * @returns {number} - New difficulty
    */
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
        const periodInterval = lastBlock.timestamp - olderBlock.posTimestamp;
        return periodInterval / MINING_PARAMS.blocksBeforeAdjustment;
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
    decomposeDifficulty: (difficulty = 1) => {
        const zeros = Math.floor(difficulty / 16);
        const adjust = difficulty % 16;
        return { zeros, adjust };
    },
    /** @param {string} HashBitsAsString @param {BlockData} blockData */
    verifyBlockHashConformToDifficulty: (HashBitsAsString = '', blockData) => {
        if (typeof HashBitsAsString !== 'string') { throw new Error('Invalid HashBitsAsString'); }

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

const utils = {
    compression,
    mining
};

export default utils;