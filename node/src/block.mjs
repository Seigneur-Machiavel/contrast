// @ts-check
import { BLOCKCHAIN_SETTINGS, SOLVING } from '../../config/blockchain-settings.mjs';
import { BlockFinalizedHeader, BlockFinalized, BlockCandidate } from '../../types/block.mjs';
import { solving } from '../../utils/conditionals.mjs';
import { HashFunctions } from './conCrypto.mjs';
import { TxValidation } from './tx-validation.mjs';
import { Transaction_Builder } from './transaction.mjs';
import { serializer, SIZES } from '../../utils/serializer.mjs';
import { Transaction, UTXO, UtxoState } from '../../types/transaction.mjs';

/**
* @typedef {import("./node.mjs").ContrastNode} ContrastNode
*/

export class BlockUtils {
	// PRIVATE STATIC METHODS
    /** @param {BlockCandidate | BlockFinalized} block @param {boolean} excludeCoinbaseAndPos */
    static #getBlockTxsHash(block, excludeCoinbaseAndPos = false) {
		const txsSignables = [];
		for (const tx of block.Txs)
			txsSignables.push(Transaction_Builder.getTransactionSignable(tx).hashHex);

		if (excludeCoinbaseAndPos) {
			const firstTxIsSolver = block.Txs[0] ? Transaction_Builder.isSolverOrValidatorTx(block.Txs[0]) === 'solver' : undefined;
			const secondTxIsValidator = block.Txs[1] ? Transaction_Builder.isSolverOrValidatorTx(block.Txs[1]) === 'validator' : undefined;
			if (firstTxIsSolver) txsSignables.shift();
			if (secondTxIsValidator) txsSignables.shift();
		}

        const txsIDStr = txsSignables.join('');
        return HashFunctions.SHA512(txsIDStr);
    };
	/** @param {Object<string, UTXO>} involvedUTXOs @param {Transaction[]} Txs */
    static #calculateTxsTotalFees(involvedUTXOs, Txs) {
        let totalFees = 0;
        for (const tx of Txs)
            if (!Transaction_Builder.isSolverOrValidatorTx(tx))
            	totalFees += TxValidation.calculateRemainingAmount(involvedUTXOs, tx);

        return totalFees;
    }
	/** Adds POS reward transaction to the block candidate and signs it
	 * @param {ContrastNode} node @param {BlockCandidate} block */
	static async signBlockCandidate(node, block) {
		if (!node.wallet?.hybridKey) throw new Error('Node wallet not set');

		const involvedAnchors = BlockUtils.extractInvolvedAnchors(block, 'blockCandidate').involvedAnchors;
		const involvedUTXOs = node.blockchain.getUtxos(involvedAnchors, true);
		if (!involvedUTXOs) throw new Error('Unable to extract involved UTXOs for block candidate');

		const resolution = this.#resolveIdentitiesOfValidatorTx(node);
		const { validatorAddress, rewardAddress, identityEntries, useExistingRootAccount } = resolution;

		// CALCULATE REWARD => CREATE & SIGN VALIDATOR REWARD TX => ADD IT TO BLOCK CANDIDATE
		const { powReward, posReward } = BlockUtils.calculateBlockReward(involvedUTXOs, block);
		const validatorFeeTx = Transaction_Builder.createValidatorReward(posReward, block, validatorAddress, rewardAddress, identityEntries);
		// USE ACCOUNT.ADDRESS or TEMPORARY ADDRESS TO SIGN THE TX.
		const signedValidatorFeeTx = await node.wallet.signTransaction(validatorFeeTx, useExistingRootAccount ? 0 : validatorAddress);
		block.Txs.unshift(signedValidatorFeeTx);
		block.powReward = powReward; // Reward for the solver
	}
	/** @param {ContrastNode} node */
	static #resolveIdentitiesOfValidatorTx(node) {
		const { blockchain, rewardsInfo, wallet } = node;
		const { identityStore, ownershipStorage } = blockchain;
		const { vAddress, vPubkeys } = rewardsInfo;
		if (!vAddress && !vPubkeys) throw new Error('Node reward addresses/pubkey not set');
		if (!wallet?.hybridKey) throw new Error('Node wallet not set');

		const walletIds = { // SEARCH FOR WALLET RECORD ON THE BLOCKCHAIN
			validator: ownershipStorage.getOwnedRootAddress([wallet.hybridKeyHex]),
			reward: vPubkeys ? ownershipStorage.getOwnedRootAddress(vPubkeys) : null
		}
		
		if (walletIds.validator) wallet.assignRootAddress(walletIds.validator);

		// VERIFY VALIDATOR IDENTITY CORRESPONDANCE => IF NOT IDENTIFY => CREATE IDENTITY
		// PRE-GENERATE 2 ADDRESSES IN CASE BOTH VALIDATOR AND REWARD ADDRESS NEED TO BE CREATED
		/** @type {Uint8Array[]} */
		const identityEntries = [];
		const nextRootAddresses = identityStore.nextRootAddressToCreate('C', 2);
		const useExistingRootAccount = !!wallet.accounts[0]?.address;
		const validatorAddress = wallet.accounts[0]?.address ? wallet.accounts[0].address : nextRootAddresses[0]; // IF NO ACCOUNT ADDRESS, CREATE ONE FOR THE VALIDATOR IDENTITY (vout:65535)
		const status1 = identityStore.verify(validatorAddress, [wallet.hybridKeyHex]);
		if (status1 === 'MISMATCH') throw new Error('Validator address known but pubkey(s) mismatch in identity store');
		if (status1 === 'UNKNOWN') identityEntries.push(identityStore.buildEntry([wallet.hybridKeyHex]));

		const pubKeyMatch = vPubkeys?.length === 1 && vPubkeys[0] === wallet.hybridKeyHex;
		const rewardAddress = vAddress || (pubKeyMatch ? validatorAddress : nextRootAddresses[1]);
		if (rewardAddress === nextRootAddresses[1]) { // CREATE REWARD IDENTITY IF NEEDED
			const rewardPubkeys = (vPubkeys?.length || 0) > 0 ? vPubkeys : undefined;
			const status2 = identityStore.verify(rewardAddress, rewardPubkeys);
			if (status2 === 'MISMATCH') throw new Error('Reward address known but pubkey(s) mismatch in identity store');
			if (status2 === 'UNKNOWN') {
				if (!rewardPubkeys) throw new Error('Reward address unknown but no pubkey provided, cannot create identity for block signing');
				if (rewardPubkeys.length !== 1) throw new Error('Reward address unknown but multiple pubkeys provided, cannot determine threshold for identity creation');
				identityEntries.push(identityStore.buildEntry(rewardPubkeys));
			}
		}

		return { validatorAddress, rewardAddress, identityEntries, useExistingRootAccount };
	}

	// PUBLIC STATIC METHODS
    /** Get the block signature used for solving
     * @param {BlockCandidate | BlockFinalized} block
     * @param {boolean} isPosHash - if true, exclude coinbase/pos Txs and blockTimestamp */
    static getBlockSignature(block, isPosHash = false) {
        const txsHash = this.#getBlockTxsHash(block, isPosHash).hashHex;
        const { index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp } = block;
        let signatureStr = `${index}${supply}${coinBase}${difficulty}${legitimacy}${prevHash}${posTimestamp}${txsHash}`;
        if (!isPosHash && 'timestamp' in block) signatureStr += block.timestamp;

        return HashFunctions.SHA512(signatureStr).hashHex;
    }
    /** @param {BlockFinalized} block */
    static async getSolverHash(block) {
        if (typeof block.Txs[0].inputs[0] !== 'string') throw new Error('Invalid coinbase nonce');
        const signatureHex = this.getBlockSignature(block);
        const headerNonce = block.nonce;
        const coinbaseNonce = block.Txs[0].inputs[0];
        const nonce = `${headerNonce}${coinbaseNonce}`;
		//console.log(`%c${signatureHex}:${nonce}`, 'color: orange;');
        const argon2Fnc = HashFunctions.Argon2;
        const blockHash = await solving.hashBlockSignature(argon2Fnc, signatureHex, nonce);
        if (!blockHash) throw new Error('Invalid block hash');

        return { hex: blockHash.hex, bitsArrayAsString: blockHash.bitsString };
    }
    /** @param {BlockCandidate | BlockFinalized} block @param {Transaction} coinbaseTx */
    static setCoinbaseTransaction(block, coinbaseTx) {
        if (Transaction_Builder.isSolverOrValidatorTx(coinbaseTx) !== 'solver')
			throw new Error('Invalid coinbase transaction');

		// REMOVE EXISTING COINBASE IF ANY
		const isFirstTxSolver = block.Txs[0] && Transaction_Builder.isSolverOrValidatorTx(block.Txs[0]) === 'solver';
		if (isFirstTxSolver) block.Txs.shift();

		// SET NEW COINBASE TX
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
	static calculateAdjustedDifficulty(node, logs = false) {
        const lastBlock = node.blockchain.lastBlock;
        if (!lastBlock) return SOLVING.initialDifficulty;

		if (lastBlock.index === 0) return lastBlock.difficulty; // Genesis block, keep initial difficulty
		if (lastBlock.index % SOLVING.blocksBeforeAdjustment !== 0) return lastBlock.difficulty; // Not time for adjustment yet, keep current difficulty
		
		const periodBlocks = node.blockchain.blockStorage.getBlocksHeaders(lastBlock.index - SOLVING.blocksBeforeAdjustment, lastBlock.index);
		if (!periodBlocks || periodBlocks.length === 0) throw new Error('Unable to retrieve period blocks for difficulty adjustment');
		return solving.difficultyAdjustment(periodBlocks, undefined, logs);
    }
	/** @param {BlockFinalized} block */
	static getFinalizedBlockHeader(block) {
		const { index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce } = block;
		return new BlockFinalizedHeader(index, supply, coinBase, difficulty, legitimacy, prevHash, posTimestamp, timestamp, hash, nonce);
	}
	/** Aggregates transactions from mempool, creates a new block candidate (Genesis block if no lastBlock)
	 * @param {ContrastNode} node @param {number} [blockReward] @param {number} [initDiff] */
	static async createBlockCandidate(node, blockReward = BLOCKCHAIN_SETTINGS.blockReward, initDiff = SOLVING.initialDifficulty) {
		const { blockchain, memPool, wallet, solver, time } = node;
		if (typeof time !== 'number') throw new Error('Invalid node time');
		if (!wallet?.hybridKey) throw new Error('Node wallet not set');

		const posTimestamp = blockchain.lastBlock?.timestamp ? blockchain.lastBlock.timestamp + 1 : time;
		if (!blockchain.lastBlock) return new BlockCandidate(0, 0, blockReward, initDiff, 0, '00'.repeat(SIZES.hash.bytes), [], posTimestamp);
		
		// CHOOSE TO RETURN NULL IF NOT ELIGIBLE TO MINE
		const prevHash = blockchain.lastBlock.hash;
		const solverBestIndex = solver.bestCandidateIndex !== -1 ? solver.bestCandidateIndex : null;
		const validatorAddress = wallet.accounts[0]?.address || 'CZZZZZZ'; // IF NO ACCOUNT ADDRESS, USE A PLACEHOLDER THAT WILL NOT BE FOUND IN THE IDENTITY STORE
		const myLegitimacy = await blockchain.vss.getAddressLegitimacy(validatorAddress, prevHash);
		node.info.lastLegitimacy = myLegitimacy;

		if (solverBestIndex !== null)
			if (solverBestIndex > blockchain.lastBlock.index + 1) return false; // TOO FAR AHEAD, WAIT FOR OTHER BLOCKS TO CATCH UP
			else if (solverBestIndex < blockchain.lastBlock.index) return false;// ALREADY BEHIND, WAIT FOR OTHER BLOCKS TO CATCH UP
		if (myLegitimacy > BLOCKCHAIN_SETTINGS.validatorsPerRound) return false;// TOO LOW LEGITIMACY, DON'T WASTE RESOURCES
		
		const newDifficulty = BlockUtils.calculateAdjustedDifficulty(node, true);
		const coinBaseReward = solving.calculateNextCoinbaseReward(blockchain.lastBlock);
		const { txs, totalFee } = memPool.getMostLucrativeTransactionsBatch(node);
		// totalFee => available for callers
		return new BlockCandidate(blockchain.lastBlock.index + 1, blockchain.lastBlock.supply + blockchain.lastBlock.coinBase, coinBaseReward, newDifficulty, myLegitimacy, prevHash, txs, posTimestamp);
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
	/** @param {BlockFinalized} block @returns {UtxoState[]} */
	static buildUtxosStatesOfFinalizedBlock(block) {
		const utxosStates = [];
		for (let i = 0; i < block.Txs.length; i++)
			for (let j = 0; j < block.Txs[i].outputs.length; j++)
				utxosStates.push(new UtxoState(i, j, false));
		return utxosStates;
	}
}