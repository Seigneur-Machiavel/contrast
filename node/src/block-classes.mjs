import { mining } from '../../utils/mining-functions.mjs';
import { HashFunctions } from './conCrypto.mjs';
import { Transaction_Builder, Transaction } from './transaction.mjs';
import { TxValidation } from './validations-classes.mjs';
import { serializer } from '../../utils/serializer.mjs';

/**
* @typedef {import("./utxoCache.mjs").UtxoCache} UtxoCache
 */

/**
 * @typedef {Object} BlockHeader
 * @property {number} index - The block height
 * @property {number} supply - The total supply before the coinbase reward
 * @property {number} coinBase - The coinbase reward
 * @property {number} difficulty - The difficulty of the block
 * @property {number} legitimacy - The legitimacy of the validator who created the block candidate
 * @property {string} prevHash - The hash of the previous block
 * @property {number} posTimestamp - The timestamp of the block creation
 * @property {number | undefined} timestamp - The timestamp of the block
 * @property {string | undefined} hash - The hash of the block
 * @property {number | undefined} nonce - The nonce of the block
 */
/**
 * @param {number} index - The block height
 * @param {number} supply - The total supply before the coinbase reward
 * @param {number} coinBase - The coinbase reward
 * @param {number} difficulty - The difficulty of the block
 * @param {number} legitimacy - The legitimacy of the validator who created the block candidate
 * @param {string} prevHash - The hash of the previous block
 * @param {number} posTimestamp - The timestamp of the block creation
 * @param {number | undefined} timestamp - The timestamp of the block
 * @param {string | undefined} hash - The hash of the block
 * @param {number | undefined} nonce - The nonce of the block
 * @returns {BlockHeader}
 */
export const BlockHeader = (index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce) => {
    return {
        index,
        supply,
        coinBase,
        difficulty,
        legitimacy,
        prevHash,
        posTimestamp,
        timestamp,
        hash,
        nonce,
    };
};

/**
 * @typedef {Object} BlockInfo
 * @property {BlockHeader} header
 * @property {number} totalFees
 * @property {number} lowerFeePerByte
 * @property {number} higherFeePerByte
 * @property {number} blockBytes
 * @property {number} nbOfTxs
 */
/**
 * @param {BlockHeader} header
 * @param {number} totalFees
 * @param {number} lowerFeePerByte
 * @param {number} higherFeePerByte
 * @param {number} blockBytes
 * @param {number} nbOfTxs
 * @returns {BlockInfo}
 */
export const BlockInfo = (header, totalFees, lowerFeePerByte, higherFeePerByte, blockBytes, nbOfTxs) => {
    header,
    totalFees,
    lowerFeePerByte,
    higherFeePerByte,
    blockBytes, 
    nbOfTxs
};

/**
* @typedef {Object} BlockMiningData
* @property {number} index - The block height
* @property {number} difficulty - The difficulty of the block
* @property {number} timestamp - The timestamp of the block
* @property {number} posTimestamp - The timestamp of the block's creation
*/
/**
* @param {number} index - The block height
* @param {number} difficulty - The difficulty of the block
* @param {number} timestamp - The timestamp of the block
* @param {number} posTimestamp - The timestamp of the block's creation
* @returns {BlockMiningData}
 */
export const BlockMiningData = (index, difficulty, timestamp, posTimestamp) => {
    return {
        index,
        difficulty,
        timestamp,
        posTimestamp
    };
}

/**
* @typedef {Object} BlockData
* @property {number} index - The index of the block
* @property {number} supply - The total supply before the coinbase reward
* @property {number} coinBase - The coinbase reward
* @property {number} difficulty - The difficulty of the block
* @property {number} legitimacy - The legitimacy of the validator who created the block candidate
* @property {string} prevHash - The hash of the previous block
* @property {Transaction[]} Txs - The transactions in the block
* @property {number} posTimestamp - The timestamp of the block creation
* @property {number | undefined} timestamp - The timestamp of the block
* @property {string | undefined} hash - The hash of the block
* @property {number | undefined} nonce - The nonce of the block
* @property {number | undefined} powReward - The reward for the proof of work (only in candidate)

* @property {string | undefined} minerAddress - The address of the miner (only from API)
* @property {string | undefined} validatorAddress - The address of the validator (only from API)
* @property {number | undefined} posReward - The reward for the proof of stake (only from API)
* @property {number | undefined} totalFees - The total fees of the block (only from API)
* @property {number | undefined} lowerFeePerByte - The lower fee per byte of the block (only from API)
* @property {number | undefined} higherFeePerByte - The higher fee per byte of the block (only from API)
* @property {number | undefined} nbOfTxs - The number of transactions in the block (only from API)
* @property {number | undefined} blockBytes - The size of the block in bytes (only from API)
*/
/**
 * @param {number} index - The index of the block
 * @param {number} supply - The total supply before the coinbase reward
 * @param {number} coinBase - The coinbase reward
 * @param {number} difficulty - The difficulty of the block
 * @param {string} prevHash - The hash of the previous block
 * @param {Transaction[]} Txs - The transactions in the block
 * @param {number | undefined} timestamp - The timestamp of the block
 * @param {string | undefined} hash - The hash of the block
 * @param {number | undefined} nonce - The nonce of the block
 * @returns {BlockData}
 */
export const BlockData = (index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, timestamp, hash, nonce) => {
    return {
        index,
        supply,
        coinBase,
        difficulty,
        legitimacy,
        prevHash,

        // Proof of stake dependent
        posTimestamp, // timestamp of the block's creation
        
        // Proof of work dependent
        timestamp, // timestamp of the block's confirmation
        hash,
        nonce,
        
        Txs
    };
}
export class BlockUtils {
    /** @param {BlockData} blockData @param {boolean} excludeCoinbaseAndPos */
    static async getBlockTxsHash(blockData, excludeCoinbaseAndPos = false) {
        const txsIDStrArray = blockData.Txs.map(tx => tx.id).filter(id => id);

        let firstTxIsCoinbase = blockData.Txs[0] ? Transaction_Builder.isMinerOrValidatorTx(blockData.Txs[0]) : false;
        if (excludeCoinbaseAndPos && firstTxIsCoinbase) { txsIDStrArray.shift(); }
        firstTxIsCoinbase = blockData.Txs[0] ? Transaction_Builder.isMinerOrValidatorTx(blockData.Txs[0]) : false;
        if (excludeCoinbaseAndPos && firstTxIsCoinbase) { txsIDStrArray.shift(); }

        const txsIDStr = txsIDStrArray.join('');
        return await HashFunctions.SHA256(txsIDStr);
    };
    /** Get the block signature used for mining
     * @param {BlockData} blockData
     * @param {boolean} isPosHash - if true, exclude coinbase/pos Txs and blockTimestamp
     * @returns {Promise<string>} signature Hex */
    static async getBlockSignature(blockData, isPosHash = false) {
        const txsHash = await this.getBlockTxsHash(blockData, isPosHash);
        const { index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp } = blockData;
        
        let signatureStr = `${index}${supply}${coinBase}${difficulty}${legitimacy}${prevHash}${posTimestamp}${txsHash}`;
        if (!isPosHash) { signatureStr += blockData.timestamp; }

        return await HashFunctions.SHA256(signatureStr);
    }
    /** @param {BlockData} blockData */
    static async getMinerHash(blockData, useDevArgon2 = false) {
        if (typeof blockData.Txs[0].inputs[0] !== 'string') { throw new Error('Invalid coinbase nonce'); }
        const signatureHex = await this.getBlockSignature(blockData);

        const headerNonce = blockData.nonce;
        const coinbaseNonce = blockData.Txs[0].inputs[0];
        const nonce = `${headerNonce}${coinbaseNonce}`;

        const argon2Fnc = useDevArgon2 ? HashFunctions.devArgon2 : HashFunctions.Argon2;
        const blockHash = await mining.hashBlockSignature(argon2Fnc, signatureHex, nonce);
        if (!blockHash) { throw new Error('Invalid block hash'); }

        return { hex: blockHash.hex, bitsArrayAsString: blockHash.bitsArray.join('') };
    }
    /** @param {BlockData} blockData @param {Transaction} coinbaseTx */
    static setCoinbaseTransaction(blockData, coinbaseTx) {
        if (Transaction_Builder.isMinerOrValidatorTx(coinbaseTx) === false) { console.error('Invalid coinbase transaction'); return false; }

        this.removeExistingCoinbaseTransaction(blockData);
        blockData.Txs.unshift(coinbaseTx);
    }
    /** @param {BlockData} blockData */
    static removeExistingCoinbaseTransaction(blockData) {
        if (blockData.Txs.length === 0) { return; }

        const secondTx = blockData.Txs[1]; // if second tx isn't fee Tx : there is no coinbase
        if (!secondTx || !Transaction_Builder.isMinerOrValidatorTx(secondTx)) { return; }

        const firstTx = blockData.Txs[0];
        if (firstTx && Transaction_Builder.isMinerOrValidatorTx(firstTx)) { blockData.Txs.shift(); }
    }
    /** @param {UtxoCache} utxoCache @param {Transaction[]} Txs */
    static #calculateTxsTotalFees(utxoCache, Txs) {
        const involvedUTXOs = utxoCache.extractInvolvedUTXOsOfTxs(Txs);
        if (!involvedUTXOs) { throw new Error('At least one UTXO not found in utxoCache'); }
        
        let totalFees = 0;
        for (const Tx of Txs) {
            if (Transaction_Builder.isMinerOrValidatorTx(Tx)) { continue; }

            const fee = TxValidation.calculateRemainingAmount(involvedUTXOs, Tx);
            totalFees += fee;
        }

        return totalFees;
    }
    /** @param {UtxoCache} utxoCache @param {BlockData} blockData */
    static calculateBlockReward(utxoCache, blockData) {
        const totalFees = this.#calculateTxsTotalFees(utxoCache, blockData.Txs);
        const totalReward = totalFees + blockData.coinBase;
        const powReward = Math.floor(totalReward / 2);
        const posReward = totalReward - powReward;

        return { powReward, posReward, totalFees };
    }
    /** @param {BlockData} blockData */
    static dataAsJSON(blockData) {
        return JSON.stringify(blockData);
    }
    /** @param {string} blockDataJSON */
    static blockDataFromJSON(blockDataJSON) {
        if (!blockDataJSON) { throw new Error('Invalid blockDataJSON'); }
        if (typeof blockDataJSON !== 'string') { throw new Error('Invalid blockDataJSON'); }

        const parsed = JSON.parse(blockDataJSON);
        const { index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, timestamp, hash, nonce } = parsed;
        return BlockData(index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, timestamp, hash, nonce);
    }
    /** @param {BlockData} blockData */
    static cloneBlockData(blockData) {
        const JSON = this.dataAsJSON(blockData);
        return this.blockDataFromJSON(JSON);
    }
    /** @param {BlockData} blockData */
    static cloneBlockCandidate(blockData) { // TESTING Fnc(), unused
        const JSON = this.dataAsJSON(blockData);
        const jsonClone = this.blockDataFromJSON(JSON);

        return jsonClone;
    }
    /** @param {BlockData} blockData */
    static getBlockHeader(blockData) {
        const { index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce } = blockData;
        return BlockHeader(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce);
    }
    /** @param {UtxoCache} utxoCache @param {BlockData} blockData */
    static getFinalizedBlockInfo(utxoCache, blockData, totalFees) {
        /** @type {BlockInfo} */
        const blockInfo = {
            header: this.getBlockHeader(blockData),
            totalFees: totalFees || this.#calculateTxsTotalFees(utxoCache, blockData.Txs),
            lowerFeePerByte: 0,
            higherFeePerByte: 0,
            blockBytes: serializer.serialize.block_finalized(blockData).length,
            nbOfTxs: blockData.Txs.length
        };
        
        const firstTx = blockData.Txs[2];
        const lastTx = blockData.Txs.length - 1 <= 2 ? firstTx : blockData.Txs[blockData.Txs.length - 1];

        if (firstTx) {
            const involvedUTXOs = utxoCache.extractInvolvedUTXOsOfTx(firstTx);
            if (!involvedUTXOs) { throw new Error('At least one UTXO not found in utxoCache'); }

            const specialTx = Transaction_Builder.isMinerOrValidatorTx(firstTx);
            const firstTxWeight = Transaction_Builder.getTxWeight(firstTx, specialTx);
            blockInfo.higherFeePerByte = specialTx ? 0 : Math.round(TxValidation.calculateRemainingAmount(involvedUTXOs, firstTx) / firstTxWeight);
        }
        
        if (lastTx) {
            const involvedUTXOs = utxoCache.extractInvolvedUTXOsOfTx(lastTx);
            if (!involvedUTXOs) { throw new Error('At least one UTXO not found in utxoCache'); }

            const specialTx = Transaction_Builder.isMinerOrValidatorTx(firstTx);
            const lastTxWeight = Transaction_Builder.getTxWeight(lastTx, specialTx);
            blockInfo.lowerFeePerByte = specialTx ? 0 : Math.round(TxValidation.calculateRemainingAmount(involvedUTXOs, lastTx) / lastTxWeight);
        }

        return blockInfo;
    }
    /** @param {BlockData} blockData @param {Object<string, string>} blockPubKeysAddresses */
    static getFinalizedBlockTransactionsReferencesSortedByAddress(blockData, blockPubKeysAddresses) {
        /** @type {Object<string, string[]>} */
        const txRefsRelatedToAddress = {};
        for (const Tx of blockData.Txs) {
            //const addressesRelatedToTx = [];
            const addressesRelatedToTx = {};
            for (const witness of Tx.witnesses) {
                const pubKey = witness.split(':')[1];
                const address = blockPubKeysAddresses[pubKey];
                if (addressesRelatedToTx[address]) { continue; } // no duplicates
                addressesRelatedToTx[address] = true;
            }

            for (const output of Tx.outputs) {
                if (addressesRelatedToTx[output.address]) { continue; } // no duplicates
                addressesRelatedToTx[output.address] = true;
            }
            
            for (const address of Object.keys(addressesRelatedToTx)) {
                if (!txRefsRelatedToAddress[address]) { txRefsRelatedToAddress[address] = []; }
                txRefsRelatedToAddress[address].push(`${blockData.index}:${Tx.id}`);
            }
        }

        // CONTROL
        for (const address in txRefsRelatedToAddress) {
            const addressTxsRefs = txRefsRelatedToAddress[address];
            const txsRefsDupiCounter = {};
            let duplicate = 0;
            for (let i = 0; i < addressTxsRefs.length; i++) {
                const txRef = addressTxsRefs[i];
                if (txsRefsDupiCounter[txRef]) { duplicate++; }
                
                txsRefsDupiCounter[txRef] = true;
            }
            if (duplicate > 0) {
                    console.warn(`[DB] ${duplicate} duplicate txs references found for address ${address}`); }
        }

        return txRefsRelatedToAddress;
    }
}