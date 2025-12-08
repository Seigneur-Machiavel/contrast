import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';
import { BlockData, BlockInfo, BlockHeader } from '../../types/block.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { HashFunctions } from './conCrypto.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { TxValidation } from './tx-validation.mjs';
import { serializer } from '../../utils/serializer.mjs';

/**
* @typedef {import("./node.mjs").ContrastNode} ContrastNode
* @typedef {import("./utxo-cache.mjs").UtxoCache} UtxoCache
* @typedef {import("../../types/transaction.mjs").Transaction} Transaction
*/

export class BlockUtils {
    /** @param {BlockData} blockData @param {boolean} excludeCoinbaseAndPos */
    static async getBlockTxsHash(blockData, excludeCoinbaseAndPos = false) {
        const txsIDStrArray = blockData.Txs.map(tx => tx.id).filter(id => id);

        let firstTxIsCoinbase = blockData.Txs[0] ? Transaction_Builder.isMinerOrValidatorTx(blockData.Txs[0]) : false;
        if (excludeCoinbaseAndPos && firstTxIsCoinbase) txsIDStrArray.shift();
        firstTxIsCoinbase = blockData.Txs[0] ? Transaction_Builder.isMinerOrValidatorTx(blockData.Txs[0]) : false;
        if (excludeCoinbaseAndPos && firstTxIsCoinbase) txsIDStrArray.shift();

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
        if (!isPosHash) signatureStr += blockData.timestamp;

        return await HashFunctions.SHA256(signatureStr);
    }
    /** @param {BlockData} blockData */
    static async getMinerHash(blockData) {
        if (typeof blockData.Txs[0].inputs[0] !== 'string') throw new Error('Invalid coinbase nonce');
        const signatureHex = await this.getBlockSignature(blockData);
        const headerNonce = blockData.nonce;
        const coinbaseNonce = blockData.Txs[0].inputs[0];
        const nonce = `${headerNonce}${coinbaseNonce}`;
        const argon2Fnc = HashFunctions.Argon2;
        const blockHash = await mining.hashBlockSignature(argon2Fnc, signatureHex, nonce);
        if (!blockHash) throw new Error('Invalid block hash');

        return { hex: blockHash.hex, bitsArrayAsString: blockHash.bitsString };
    }
    /** @param {BlockData} blockData @param {Transaction} coinbaseTx */
    static setCoinbaseTransaction(blockData, coinbaseTx) {
        if (Transaction_Builder.isMinerOrValidatorTx(coinbaseTx) === false) {
			console.error('Invalid coinbase transaction');
			return false;
		}

        this.removeExistingCoinbaseTransaction(blockData);
        blockData.Txs.unshift(coinbaseTx);
    }
    /** @param {BlockData} blockData */
    static removeExistingCoinbaseTransaction(blockData) {
        if (blockData.Txs.length === 0) return;

        const secondTx = blockData.Txs[1]; // if second tx isn't fee Tx : there is no coinbase
        if (!secondTx || !Transaction_Builder.isMinerOrValidatorTx(secondTx)) return;

        const firstTx = blockData.Txs[0];
        if (firstTx && Transaction_Builder.isMinerOrValidatorTx(firstTx)) { blockData.Txs.shift(); }
    }
    /** @param {UtxoCache} utxoCache @param {Transaction[]} Txs */
    static #calculateTxsTotalFees(utxoCache, Txs) {
        const involvedUTXOs = utxoCache.extractInvolvedUTXOsOfTxs(Txs);
        if (!involvedUTXOs) throw new Error('At least one UTXO not found in utxoCache');
        
        let totalFees = 0;
        for (const Tx of Txs)
            if (Transaction_Builder.isMinerOrValidatorTx(Tx)) continue;
            else totalFees += TxValidation.calculateRemainingAmount(involvedUTXOs, Tx);

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
	/** @param {ContrastNode} node */
	static calculateAverageBlockTimeAndDifficulty(node) {
        const lastBlock = node.blockchain.lastBlock;
        if (!lastBlock) return { averageBlockTime: BLOCKCHAIN_SETTINGS.targetBlockTime, newDifficulty: MINING_PARAMS.initialDifficulty };
        
        const olderBlock = node.blockchain.getBlock(Math.max(0, lastBlock.index - MINING_PARAMS.blocksBeforeAdjustment));
        const averageBlockTime = mining.calculateAverageBlockTime(lastBlock, olderBlock);
        const newDifficulty = mining.difficultyAdjustment(lastBlock, averageBlockTime);
        return { averageBlockTime, newDifficulty };
    }
    /** @param {BlockData} blockData */
    static dataAsJSON(blockData) {
        return JSON.stringify(blockData);
    }
    /** @param {string} blockDataJSON */
    static blockDataFromJSON(blockDataJSON) {
        if (!blockDataJSON) throw new Error('Invalid blockDataJSON');
        if (typeof blockDataJSON !== 'string') throw new Error('Invalid blockDataJSON');

        const parsed = JSON.parse(blockDataJSON);
        const { index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, timestamp, hash, nonce } = parsed;
        return new BlockData(index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, timestamp, hash, nonce);
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
        return new BlockHeader(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce);
    }
    /** @param {UtxoCache} utxoCache @param {BlockData} blockData */
    static getFinalizedBlockInfo(utxoCache, blockData, totalFees) {
        /** @type {BlockInfo} */
        const blockInfo = {
            header: this.getBlockHeader(blockData),
            totalFees: totalFees || this.#calculateTxsTotalFees(utxoCache, blockData.Txs),
            lowerFeePerByte: 0,
            higherFeePerByte: 0,
            blockBytes: serializer.serialize.block(blockData).length,
            nbOfTxs: blockData.Txs.length
        };
        
        const firstTx = blockData.Txs[2];
        const lastTx = blockData.Txs.length - 1 <= 2 ? firstTx : blockData.Txs[blockData.Txs.length - 1];

        if (firstTx) {
            const involvedUTXOs = utxoCache.extractInvolvedUTXOsOfTx(firstTx);
            if (!involvedUTXOs) throw new Error('At least one UTXO not found in utxoCache');

            //const specialTx = Transaction_Builder.isMinerOrValidatorTx(firstTx);
            //const firstTxWeight = Transaction_Builder.getTxWeight(firstTx, specialTx);
            //blockInfo.higherFeePerByte = specialTx ? 0 : Math.round(TxValidation.calculateRemainingAmount(involvedUTXOs, firstTx) / firstTxWeight);
        }
        
        if (lastTx) {
            const involvedUTXOs = utxoCache.extractInvolvedUTXOsOfTx(lastTx);
            if (!involvedUTXOs) throw new Error('At least one UTXO not found in utxoCache');

        	//const specialTx = Transaction_Builder.isMinerOrValidatorTx(firstTx);
            //const lastTxWeight = Transaction_Builder.getTxWeight(lastTx, specialTx);
            //blockInfo.lowerFeePerByte = specialTx ? 0 : Math.round(TxValidation.calculateRemainingAmount(involvedUTXOs, lastTx) / lastTxWeight);
        }

        return blockInfo;
    }
    /** @param {BlockData} blockData @param {Object<string, string>} blockPubKeysAddresses */
    static getFinalizedBlockTransactionsReferencesSortedByAddress(blockData, blockPubKeysAddresses) {
        /** @type {Object<string, string[]>} */
        const txRefsRelatedToAddress = {};
        for (const Tx of blockData.Txs) {
            const addressesRelatedToTx = {};
            for (const witness of Tx.witnesses) {
                const pubKey = witness.split(':')[1];
                const address = blockPubKeysAddresses[pubKey];
                if (addressesRelatedToTx[address]) continue; // no duplicates
                addressesRelatedToTx[address] = true;
            }

            for (const output of Tx.outputs)
                if (addressesRelatedToTx[output.address]) continue; // no duplicates
                else addressesRelatedToTx[output.address] = true;
            
            for (const address of Object.keys(addressesRelatedToTx)) {
                if (!txRefsRelatedToAddress[address]) txRefsRelatedToAddress[address] = [];
                txRefsRelatedToAddress[address].push(`${blockData.index}:${Tx.id}`);
            }
        }

        // CONTROL
        for (const address in txRefsRelatedToAddress) {
            const addressTxsRefs = txRefsRelatedToAddress[address];
            const txsRefsDupiCounter = {};
            let duplicate = 0;
            for (let i = 0; i < addressTxsRefs.length; i++)
                if (txsRefsDupiCounter[addressTxsRefs[i]]) duplicate++;
                else txsRefsDupiCounter[addressTxsRefs[i]] = true;
				
            if (duplicate > 0) console.warn(`[DB] ${duplicate} duplicate txs references found for address ${address}`);
        }

        return txRefsRelatedToAddress;
    }
	/** Aggregates transactions from mempool, creates a new block candidate (Genesis block if no lastBlock)
	 * @param {ContrastNode} node @param {number} [blockReward] @param {number} [initDiff] */
	static async createBlockCandidate(node, blockReward = BLOCKCHAIN_SETTINGS.blockReward, initDiff = MINING_PARAMS.initialDifficulty) {
		const { blockchain, memPool, utxoCache, vss, account, miner, time } = node;
		const posTimestamp = blockchain.lastBlock ? blockchain.lastBlock.timestamp + 1 : time;
		if (!blockchain.lastBlock) return new BlockData(0, 0, blockReward, initDiff, 0, '0000000000000000000000000000000000000000000000000000000000000000', [], posTimestamp);
		
		const prevHash = blockchain.lastBlock.hash;
		const myLegitimacy = await vss.getAddressLegitimacy(account.address, prevHash);
		node.info.lastLegitimacy = myLegitimacy;

		// THIS PART SHOULD BE SEPARATED
		let maxLegitimacyToBroadcast = vss.maxLegitimacyToBroadcast;
		/*if (roles.includes('miner') && miner.bestCandidateIndex() === blockchain.lastBlock.index + 1)
			maxLegitimacyToBroadcast = Math.min(maxLegitimacyToBroadcast, miner.bestCandidateLegitimacy());
		
		if (myLegitimacy > maxLegitimacyToBroadcast) return null;*/
		// END OF PART THAT SHOULD BE SEPARATED

		const { averageBlockTime, newDifficulty } = this.calculateAverageBlockTimeAndDifficulty(node);
		node.info.averageBlockTime = averageBlockTime;
		const coinBaseReward = mining.calculateNextCoinbaseReward(blockchain.lastBlock);
		const Txs = memPool.getMostLucrativeTransactionsBatch(utxoCache);
		return new BlockData(blockchain.lastBlock.index + 1, blockchain.lastBlock.supply + blockchain.lastBlock.coinBase, coinBaseReward, newDifficulty, myLegitimacy, prevHash, Txs, posTimestamp);
	}
	/** Adds POS reward transaction to the block candidate and signs it
	 * @param {ContrastNode} node @param {BlockData} blockCandidate */
	static async signBlockCandidate(node, blockCandidate) {
		const { utxoCache, rewardAddresses, account } = node;
		if (!rewardAddresses.validator || !account.address) return null;

		const { powReward, posReward } = BlockUtils.calculateBlockReward(utxoCache, blockCandidate);
		const posFeeTx = await Transaction_Builder.createPosReward(posReward, blockCandidate, rewardAddresses.validator, account.address);
		const signedPosFeeTx = account.signTransaction(posFeeTx);
		blockCandidate.Txs.unshift(signedPosFeeTx);
		blockCandidate.powReward = powReward; // Reward for the miner
		return blockCandidate;
	}
	/** @param {ContrastNode} node @param {number} [blockReward] @param {number} [initDiff] */
	static async createAndSignBlockCandidate(node, blockReward = BLOCKCHAIN_SETTINGS.blockReward, initDiff = MINING_PARAMS.initialDifficulty) {
		const blockCandidate = await this.createBlockCandidate(node, blockReward, initDiff);
		if (!blockCandidate) return null;
		return await this.signBlockCandidate(node, blockCandidate);
	}
}