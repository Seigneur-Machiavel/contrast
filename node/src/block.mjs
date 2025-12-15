// @ts-check
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';
import { BlockInfo, BlockFinalizedHeader, BlockFinalized,
	BlockCandidateHeader, BlockCandidate } from '../../types/block.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { HashFunctions } from './conCrypto.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { TxValidation } from './tx-validation.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { Transaction, UTXO } from '../../types/transaction.mjs';

/**
* @typedef {import("./node.mjs").ContrastNode} ContrastNode
*/

export class BlockUtils {
    /** @param {BlockCandidate | BlockFinalized} block @param {boolean} excludeCoinbaseAndPos */
    static async #getBlockTxsHash(block, excludeCoinbaseAndPos = false) {
		const txsSignables = [];
		for (const tx of block.Txs)
			txsSignables.push(Transaction_Builder.getTransactionSignableString(tx));

        let firstTxIsCoinbase = block.Txs[0] ? Transaction_Builder.isMinerOrValidatorTx(block.Txs[0]) : false;
        if (excludeCoinbaseAndPos && firstTxIsCoinbase) txsSignables.shift();
        firstTxIsCoinbase = block.Txs[0] ? Transaction_Builder.isMinerOrValidatorTx(block.Txs[0]) : false;
        if (excludeCoinbaseAndPos && firstTxIsCoinbase) txsSignables.shift();

        const txsIDStr = txsSignables.join('');
        return await HashFunctions.SHA256(txsIDStr);
    };
	/** @param {BlockCandidate} block */
    static #removeExistingCoinbaseTransaction(block) {
        if (block.Txs.length === 0) return;

        const secondTx = block.Txs[1]; // if second tx isn't fee Tx : there is no coinbase
        if (!secondTx || !Transaction_Builder.isMinerOrValidatorTx(secondTx)) return;

        const firstTx = block.Txs[0];
        if (firstTx && Transaction_Builder.isMinerOrValidatorTx(firstTx)) block.Txs.shift();
    }
	/** @param {Object<string, UTXO>} involvedUTXOs @param {Transaction[]} Txs */
    static #calculateTxsTotalFees(involvedUTXOs, Txs) {
        let totalFees = 0;
        for (const Tx of Txs)
            if (Transaction_Builder.isMinerOrValidatorTx(Tx)) continue;
            else totalFees += TxValidation.calculateRemainingAmount(involvedUTXOs, Tx);

        return totalFees;
    }

    /** Get the block signature used for mining
     * @param {BlockCandidate | BlockFinalized} block
     * @param {boolean} isPosHash - if true, exclude coinbase/pos Txs and blockTimestamp
     * @returns {Promise<string>} signature Hex */
    static async getBlockSignature(block, isPosHash = false) {
        const txsHash = await this.#getBlockTxsHash(block, isPosHash);
        const { index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp } = block;
        let signatureStr = `${index}${supply}${coinBase}${difficulty}${legitimacy}${prevHash}${posTimestamp}${txsHash}`;
        if (!isPosHash && 'timestamp' in block) signatureStr += block.timestamp;

        return await HashFunctions.SHA256(signatureStr);
    }
    /** @param {BlockFinalized} block */
    static async getMinerHash(block) {
        if (typeof block.Txs[0].inputs[0] !== 'string') throw new Error('Invalid coinbase nonce');
        const signatureHex = await this.getBlockSignature(block);
        const headerNonce = block.nonce;
        const coinbaseNonce = block.Txs[0].inputs[0];
        const nonce = `${headerNonce}${coinbaseNonce}`;
        const argon2Fnc = HashFunctions.Argon2;
        const blockHash = await mining.hashBlockSignature(argon2Fnc, signatureHex, nonce);
        if (!blockHash) throw new Error('Invalid block hash');

        return { hex: blockHash.hex, bitsArrayAsString: blockHash.bitsString };
    }
    /** @param {BlockCandidate} block @param {Transaction} coinbaseTx */
    static setCoinbaseTransaction(block, coinbaseTx) {
        if (Transaction_Builder.isMinerOrValidatorTx(coinbaseTx) === false) {
			console.error('Invalid coinbase transaction');
			return false;
		}

        this.#removeExistingCoinbaseTransaction(block);
        block.Txs.unshift(coinbaseTx);
    }
    /** @param {Object<string, UTXO>} involvedUTXOs @param {BlockFinalized | BlockCandidate} block */
    static calculateBlockReward(involvedUTXOs, block) {
        const totalFees = this.#calculateTxsTotalFees(involvedUTXOs, block.Txs);
        const totalReward = totalFees + block.coinBase;
        const powReward = Math.floor(totalReward / 2);
        const posReward = totalReward - powReward;
        return { powReward, posReward, totalFees };
    }
	/** @param {ContrastNode} node */
	static calculateAverageBlockTimeAndDifficulty(node) {
        const lastBlock = node.blockchain.lastBlock;
        if (!lastBlock) return { averageBlockTime: BLOCKCHAIN_SETTINGS.targetBlockTime, newDifficulty: MINING_PARAMS.initialDifficulty };
        
		// const olderBlockHeight = lastBlock.index - MINING_PARAMS.blocksBeforeAdjustment;
		// if (olderBlockHeight < 0) return { averageBlockTime: BLOCKCHAIN_SETTINGS.targetBlockTime, newDifficulty: MINING_PARAMS.initialDifficulty };
		
		const olderBlockHeight = Math.max(0, lastBlock.index - MINING_PARAMS.blocksBeforeAdjustment);
        const olderBlock = node.blockchain.getBlock(olderBlockHeight);
        if (!olderBlock) return { averageBlockTime: BLOCKCHAIN_SETTINGS.targetBlockTime, newDifficulty: MINING_PARAMS.initialDifficulty };

		const averageBlockTime = mining.calculateAverageBlockTime(lastBlock, olderBlock);
        const newDifficulty = mining.difficultyAdjustment(lastBlock, averageBlockTime);
        return { averageBlockTime, newDifficulty };
    }
    /** @param {BlockFinalized | BlockCandidate} block */
    static dataAsJSON(block) {
        return JSON.stringify(block);
    }
	/** @param {string} blockDataJSON */
	static candidateBlockFromJSON(blockDataJSON) {
		if (!blockDataJSON || typeof blockDataJSON !== 'string') throw new Error('Invalid blockDataJSON');
		const parsed = JSON.parse(blockDataJSON);
		const { index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, powReward } = parsed;
		return new BlockCandidate(index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, powReward);
	}
	/** @param {string} blockDataJSON */
	static finalizedBlockFromJSON(blockDataJSON) {
		if (!blockDataJSON || typeof blockDataJSON !== 'string') throw new Error('Invalid blockDataJSON');
		const parsed = JSON.parse(blockDataJSON);
		const { index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, timestamp, hash, nonce } = parsed;
		return new BlockFinalized(index, supply, coinBase, difficulty, legitimacy, prevHash, Txs, posTimestamp, timestamp, hash, nonce);
	}
    /** @param {BlockFinalized} block */
    static cloneBlockFinalized(block) {
        return this.finalizedBlockFromJSON(this.dataAsJSON(block));
    }
    /** @param {BlockCandidate} block */
    static cloneBlockCandidate(block) { // TESTING Fnc(), unused
        return this.candidateBlockFromJSON(this.dataAsJSON(block));
    }
	/** @param {BlockCandidate} block */
    static getCandidateBlockHeader(block) {
		const { index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp } = block;
		return new BlockCandidateHeader(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp);
	}
	/** @param {BlockFinalized} block */
	static getFinalizedBlockHeader(block) {
		const { index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce } = block;
		return new BlockFinalizedHeader(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce);
	}
    /** @param {Object<string, UTXO>} involvedUTXOs @param {BlockFinalized} block */
    static getFinalizedBlockInfo(involvedUTXOs, block, totalFees = 0) {
        /** @type {BlockInfo} */
        const blockInfo = {
            header: this.getFinalizedBlockHeader(block),
            totalFees: totalFees || this.#calculateTxsTotalFees(involvedUTXOs, block.Txs),
            lowerFeePerByte: 0,
            higherFeePerByte: 0,
            blockBytes: serializer.serialize.block(block).length,
            nbOfTxs: block.Txs.length
        };
        
        const firstTx = block.Txs[2];
        const lastTx = block.Txs.length - 1 <= 2 ? firstTx : block.Txs[block.Txs.length - 1];

		// THIS IS SHITTY CODE, BUT NOT SENSITIVE - TO REWORK LATER
        if (firstTx) {
            const specialTx = Transaction_Builder.isMinerOrValidatorTx(firstTx);
            const firstTxWeight = serializer.serialize.transaction(firstTx, specialTx || undefined).length;
			blockInfo.higherFeePerByte = specialTx ? 0 : Math.round(TxValidation.calculateRemainingAmount(involvedUTXOs, firstTx) / firstTxWeight);
        }
        
        if (lastTx) {
        	const specialTx = Transaction_Builder.isMinerOrValidatorTx(lastTx);
            const lastTxWeight = serializer.serialize.transaction(lastTx, specialTx || undefined).length;
            blockInfo.lowerFeePerByte = specialTx ? 0 : Math.round(TxValidation.calculateRemainingAmount(involvedUTXOs, lastTx) / lastTxWeight);
        }

        return blockInfo;
    }
    /** @param {BlockFinalized} block @param {Object<string, string>} blockPubKeysAddresses */
    static getFinalizedBlockTransactionsReferencesSortedByAddress(block, blockPubKeysAddresses) {
        /** @type {Object<string, string[]>} */
        const txRefsRelatedToAddress = {};
		for (let i = 0; i < block.Txs.length; i++) {
			/** @type {Object<string, boolean>} */
            const addressesRelatedToTx = {};
			const Tx = block.Txs[i];
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
                txRefsRelatedToAddress[address].push(`${block.index}:${i}`);
            }
        }

        // CONTROL
        for (const address in txRefsRelatedToAddress) {
			/** @type {Object<string, boolean>} */
            const txsRefsDupiCounter = {};
            const addressTxsRefs = txRefsRelatedToAddress[address];
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
		const { blockchain, memPool, vss, account, miner, time } = node;
		if (typeof time !== 'number') throw new Error('Invalid node time');
		if (!account || !account.address) throw new Error('Node account not set');

		const posTimestamp = blockchain.lastBlock?.timestamp ? blockchain.lastBlock.timestamp + 1 : time;
		if (!blockchain.lastBlock) return new BlockCandidate(0, 0, blockReward, initDiff, 0, '0000000000000000000000000000000000000000000000000000000000000000', [], posTimestamp);
		
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
		const Txs = memPool.getMostLucrativeTransactionsBatch();
		return new BlockCandidate(blockchain.lastBlock.index + 1, blockchain.lastBlock.supply + blockchain.lastBlock.coinBase, coinBaseReward, newDifficulty, myLegitimacy, prevHash, Txs, posTimestamp);
	}
	/** Adds POS reward transaction to the block candidate and signs it
	 * @param {ContrastNode} node @param {BlockCandidate} block */
	static async signBlockCandidate(node, block) {
		const { blockchain, rewardAddresses, account } = node;
		if (!rewardAddresses.validator || !account || !account.address) throw new Error('Node reward addresses or account not set');

		const involvedAnchors = BlockUtils.extractInvolvedAnchors(block, 'blockCandidate').involvedAnchors;
		const involvedUTXOs = blockchain.getUtxos(involvedAnchors, true);
		if (!involvedUTXOs) throw new Error('Unable to extract involved UTXOs for block candidate');

		const { powReward, posReward } = BlockUtils.calculateBlockReward(involvedUTXOs, block);
		const posFeeTx = await Transaction_Builder.createPosReward(posReward, block, rewardAddresses.validator, account.address);
		const signedPosFeeTx = account.signTransaction(posFeeTx);
		block.Txs.unshift(signedPosFeeTx);
		block.powReward = powReward; // Reward for the miner
		return block;
	}
	/** @param {ContrastNode} node @param {number} [blockReward] @param {number} [initDiff] */
	static async createAndSignBlockCandidate(node, blockReward = BLOCKCHAIN_SETTINGS.blockReward, initDiff = MINING_PARAMS.initialDifficulty) {
		const blockCandidate = await this.createBlockCandidate(node, blockReward, initDiff);
		return await this.signBlockCandidate(node, blockCandidate);
	}
	/** @param {BlockFinalized | BlockCandidate} block @param {'blockFinalized' | 'blockCandidate'} [mode] Default: 'blockFinalized' */
	static extractInvolvedAnchors(block, mode = 'blockFinalized') {
		/** @type {Object<string, boolean>} */
		const control = {};
		const involvedAnchors = [];
		let repeatedAnchorsCount = 0;
		for (let i = mode === 'blockFinalized' ? 2 : 0; i < block.Txs.length; i++)
			for (const input of block.Txs[i].inputs)
				if (control[input]) repeatedAnchorsCount++;
				else { control[input] = true; involvedAnchors.push(input); }

		return { involvedAnchors, repeatedAnchorsCount };
	}
	/** @param {BlockFinalized} block */
	static extractNewStakesFromFinalizedBlock(block) {
		/** @type {UTXO[]} */ const newStakesOutputs = [];
		for (let txId = 2; txId < block.Txs.length; txId++) // skip coinbase and pos fee Txs
			for (let voudId = 0; voudId < block.Txs[txId].outputs.length; voudId++) {
				const { address, amount, rule } = block.Txs[txId].outputs[voudId];
				if (amount < BLOCKCHAIN_SETTINGS.unspendableUtxoAmount) continue;
				if (rule !== "sigOrSlash") continue;

				newStakesOutputs.push(new UTXO(`${block.index}:${txId}:${voudId}`, amount, rule, address, false));
			}

		return newStakesOutputs;
	}
}