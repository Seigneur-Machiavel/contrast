// @ts-check
import { ADDRESS } from '../../types/address.mjs';
import { CURRENCY } from '../../utils/currency.mjs';
import { solving } from '../../utils/conditionals.mjs';
import { hybridKeyHint } from '../../utils/common.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import { serializer, SIZES } from '../../utils/serializer.mjs';
import { SolverWorker } from '../workers/solver-worker-wrapper.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../config/blockchain-settings.mjs';

/**
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized */

export class Solver {
	node;
	version = 1;
	nbOfWorkers = 1;
	minNbOfWorkers = 1;
	maxNbOfWorkers = 4;
	terminated = false;
	useBetTimestamp = true;
	logger = new MiniLogger('solver');
	
	/** @type {string[]} */								addressOfCandidatesBroadcasted = [];
	/** @type {BlockCandidate | null} */				bestCandidate = null;
	/** @type {SolverWorker[]} */						workers = [];
	/** @type {number[]} */								bets = [];
	/** @type {{min: number, max: number}} will bet between 70% and 95% of the expected blockTime */
	betRange = { min: .7, max: .95 };
	powBroadcastState = { foundHeight: -1, sentTryCount: 0, maxTryCount: 1 };
	canProceedSolving = true;
	hashPeriodStart = 0;
	networkPower = 0;
	hashCount = 0;
	/** @type {{raw: number, effective: number}} */
	hashRateStats = { raw: 0, effective: 0 }; // V2

    /** @param {ContrastNode} node */
    constructor(node) { this.node = node; }

    get bestCandidateIndex() { return this.bestCandidate ? this.bestCandidate.index : -1; }
    get bestCandidateLegitimacy() { return this.bestCandidate ? this.bestCandidate.legitimacy : 0; }

	// API METHODS
	get estimatedDailyReward() {
		if (!this.hashRateStats.effective || !this.networkPower || !this.bestCandidate) return 0;
		const expectedBlocksPerDay = 24 * 3600 / ( BLOCKCHAIN_SETTINGS.targetBlockTime * .001 );
		const expectedRewardPerBlock = this.bestCandidate.coinBase / 2; // 50/50 between pow and pos reward
		const myPowerShare = Math.min(1, this.hashRateStats.effective / this.networkPower);
		return Math.round(myPowerShare * expectedBlocksPerDay * expectedRewardPerBlock);
	}
    /** @param {BlockCandidate} block */
    updateBestCandidate(block) {
		if (!block) throw new Error('Candidate is null or undefined');
		
		const hint = block.Txs[0].witnesses[0][1];
		const validatorAddress = block.Txs[0].outputs[0].address;
        const isMyBlock = this.node.wallet?.pubKey ? hint === hybridKeyHint(this.node.wallet.pubKey) : false;
        const posReward = block.Txs[0].outputs[0].amount;
        const powReward = block.powReward;
        if (!posReward || !powReward) throw new Error(`Invalid candidate (#${block.index} | v:${validatorAddress}) | posReward = ${posReward} | powReward = ${powReward}`);
		if (Math.abs(posReward - powReward) > 1) throw new Error(`Invalid candidate (#${block.index} | v:${validatorAddress}) | posReward = ${posReward} | powReward = ${powReward} | Math.abs(posReward - powReward) > 1`);

        const prevHash = this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : '00'.repeat(SIZES.hash.bytes);
		if (block.prevHash !== prevHash) throw new Error(`Invalid candidate prevHash (#${block.index} | v:${validatorAddress}) | expected: ${prevHash.slice(0, 4)}... | got: ${block.prevHash.slice(0, 4)}...`);
        
        let reasonChange = 'none';
        if (!this.bestCandidate)
            reasonChange = '(no best candidate, set first)';
        else if (block.index > this.bestCandidate.index)
            reasonChange = '(replacing by higher block height)';
        else if (this.bestCandidate.prevHash !== prevHash)
            reasonChange = '(replacing invalid prevHash)';
        else if (block.index === this.bestCandidate.index) {
            const newCandidateFinalDiff = solving.getBlockFinalDifficulty(block).finalDifficulty;
            const bestCandidateFinalDiff = solving.getBlockFinalDifficulty(this.bestCandidate).finalDifficulty;
            if (newCandidateFinalDiff > bestCandidateFinalDiff) throw new Error(`Ignored candidate (#${block.index} | v:${validatorAddress}) | new final diff ${newCandidateFinalDiff} > best final diff ${bestCandidateFinalDiff}`);
            if (newCandidateFinalDiff < bestCandidateFinalDiff) reasonChange = `(easier block: ${newCandidateFinalDiff} < ${bestCandidateFinalDiff})`;
            // if everything is the same, then check the powReward to decide
            if (reasonChange === 'none' && powReward > (this.bestCandidate?.powReward || 0))
                reasonChange = ` (higher powReward: ${powReward} > ${this.bestCandidate?.powReward || 0})`;
            
            // preserve the current best candidate, but update considered as true to encourage re-bradcasting
            if (reasonChange === 'none') return true;
        }

        // preserve the current best candidate, but update considered as true to encourage re-bradcasting
        if (reasonChange === 'none') return true;

        if (this.node.verb > 2) this.logger.log(`[SOLVER] Best block candidate changed${reasonChange}:
from #${this.bestCandidate ? this.bestCandidate.index : null} (leg: ${this.bestCandidate ? this.bestCandidate.legitimacy : null})
to #${block.index} (leg: ${block.legitimacy})${isMyBlock ? ' (my block)' : ''}`, (m, c) => console.info(m, c));
        
        // if block is different than the highest block index, then reset the addressOfCandidatesBroadcasted
        if (block.index !== this.bestCandidateIndex) this.addressOfCandidatesBroadcasted = [];
        this.bestCandidate = block;
        
        this.#prepareBets();
        return true;
    }
	decreaseThreads() { if (this.nbOfWorkers > this.minNbOfWorkers) this.nbOfWorkers--; }
	increaseThreads() { if (this.nbOfWorkers < this.maxNbOfWorkers) this.nbOfWorkers++; }
	async tick() {
		if (this.terminated || !this.canProceedSolving) return;

		const blockCandidate = this.bestCandidate;
		if (!blockCandidate) return;

		const validatorAddress = blockCandidate.Txs[0].inputs[0].split(':')[0];
		const validatorRewardAddress = blockCandidate.Txs[0].outputs[0].address;
		if (!validatorAddress || !validatorRewardAddress) throw new Error('Invalid block candidate: missing validator address or reward address');

		const { sAddress, identityEntries } = this.#getAddressAndDataForRewardTx(validatorAddress, validatorRewardAddress);
		if (!sAddress) throw new Error('Unable to get solver reward address for mining'); 
		if (blockCandidate.index !== this.bestCandidateIndex) {
			if (this.node.verb > 2) this.logger.log(`[SOLVER] Block candidate is not the highest block candidate: #${blockCandidate.index} < #${this.bestCandidateIndex}`, (m, c) => console.info(m, c));
			return;
		}

		this.#togglePausedWorkers();
		await this.#terminateUnusedWorkers();
		const readyWorkers = await this.#createMissingWorkers(sAddress, identityEntries);
		this.hashRateStats = this.#computeHashRateStats();
		
		const timings = { start: Date.now(), workersUpdate: 0, updateInfo: 0 }
		for (let i = 0; i < readyWorkers; i++) await this.workers[i].updateCandidate(blockCandidate);
		
		timings.workersUpdate = Date.now();
		for (let i = 0; i < readyWorkers; i++) {
			if (!this.node.time) return;
			const blockBet = this.bets?.[i] || 0;
			const timeOffset = Date.now() - this.node.time;
			this.workers[i].updateInfo(sAddress, blockBet, timeOffset, identityEntries);
		}
		timings.updateInfo = Date.now();

		for (let i = 0; i < readyWorkers; i++) {
			const worker = this.workers[i];
			if (worker.isWorking) continue;
			if (worker.result !== null) {
				const finalizedBlock = worker.getResultAndClear();
				if (this.node.verb > 2) this.logger.log(`[SOLVER] Worker ${i} pow! #${finalizedBlock.index})`, (m, c) => console.info(m, c));
				await this.#broadcastFinalizedBlock(finalizedBlock);
			}

			if (!this.canProceedSolving) continue;
			worker.mineUntilValid();
		}
		
		const endTimestamp = Date.now();
		const timeSpent = endTimestamp - timings.start;
		if (timeSpent < 1000) return;

		if (this.node.verb > 1) this.logger.log(`[SOLVER] Abnormal time spent: ${timeSpent}ms
		- workersUpdate: ${timings.workersUpdate - timings.start}ms
		- updateInfo: ${timings.updateInfo - timings.workersUpdate}ms`, (m, c) => console.info(m, c));
    }
    async terminateAsync() {
        const promises = [];
        for (const worker of this.workers) { promises.push(worker.terminateAsync()); }
        await Promise.all(promises);
        this.terminated = true;
    }

	// INTERNAL METHODS
	/** @param {string} validatorAddress @param {string} validatorRewardAddress */
	#getAddressAndDataForRewardTx(validatorAddress, validatorRewardAddress) {
		// VERIFY IDENTITY CORRESPONDANCE => IF NOT IDENTIFY => CREATE IDENTITY
		const { sAddress, sPubkeys } = this.node.rewardsInfo;
		const { identityStore } = this.node.blockchain;
		
		if (!sAddress && !sPubkeys) throw new Error('Both solver reward address and pubkeys are missing, unable to proceed');
		
		// IF NO SOLVER REWARD ADDRESS, CREATE ONE FOR THE SOLVER REWARD IDENTITY (vout:0)
		let nextAddressIndex = 0; // Index of address to use for the solver reward identity (vout:0)
		const nextRootAddresses = identityStore.nextRootAddressToCreate('C', 3);
		const addressesToCheck = validatorAddress === validatorRewardAddress ? [validatorAddress] : [validatorAddress, validatorRewardAddress];
		for (const a of addressesToCheck) {
			const { prefix: p1, rootB58: str1 } = ADDRESS.getAddressRoot(a);
			for (const rootAddress of nextRootAddresses) {
				const { prefix: p2, lastPartBase58: str2 } = ADDRESS.splitAddress(rootAddress);
				if (p1 !== p2) continue; // different prefix, cannot be the same root address
				if (str2 !== str1) continue; // different root address, skip
				nextAddressIndex++; // this root address is already used by the validator identities, so we need to use the next one for the solver reward identity
			}
		}

		const solverAddress = sAddress ? sAddress : nextRootAddresses[nextAddressIndex];
		if (!solverAddress) throw new Error('Unable to determine solver reward address for mining');

		const r = identityStore.verify(solverAddress, sPubkeys);
		if (r === 'MISMATCH') throw new Error('Solver reward address known but pubkey(s) mismatch in identity store');
		if (r === 'MATCH') return { sAddress: solverAddress, identityEntries: undefined };
		
		// 'UNKNOWN' => create the identity entries for the solver reward address.
		if (!sPubkeys) throw new Error('Solver reward address unknown but no pubkey provided, unable to create identity for mining reward');
		if (sPubkeys.length !== 1) throw new Error('Solver reward address unknown but multiple pubkeys provided, cannot determine threshold for identity creation');
		
		return { sAddress: solverAddress, identityEntries: [identityStore.buildEntry(sPubkeys)] };
	}
    #prepareBets(nbOfBets = 32) {
        if (!this.useBetTimestamp) { this.bets = []; return }

        const { min, max } = this.betRange;
        const bets = [];
        for (let i = 0; i < nbOfBets; i++) bets.push(solving.betPowTime(min, max));

        this.bets = bets;
    }
	#computeHashRateStats() {
		let raw = 0, effective = 0;
		for (const worker of this.workers) {
			raw += worker.hashRate;
			effective += worker.hashRate;
			//effective += worker.hashRate * Math.min(worker.difficulty / Math.max(worker.finalDifficulty, 1), 1);
		}
		return { raw, effective };
	}
    /** @param {BlockFinalized} block */
    async #broadcastFinalizedBlock(block) {
        // Avoid sending the block pow if a higher block candidate is available to be mined
        if (this.bestCandidateIndex > block.index) {
            if (this.node.verb > 2) this.logger.log(`[SOLVER] Block finalized is not the highest block candidate: #${block.index} < #${this.bestCandidateIndex}`, (m, c) => console.info(m, c));
            return;
        }
        
        const validatorAddress = block.Txs[1].inputs[0].split(':')[0];
		const solverAddress = block.Txs[0].outputs[0].address;
        if (this.addressOfCandidatesBroadcasted.includes(validatorAddress)) {
        	if (this.node.verb > 2) this.logger.log(`[SOLVER] Block finalized already sent (Height: ${block.index})`, (m, c) => console.info(m, c));
            return;
        }

        // Avoid sending the same block multiple times
        const isNewHeight = block.index > this.powBroadcastState.foundHeight;
        const maxTryReached = this.powBroadcastState.sentTryCount >= this.powBroadcastState.maxTryCount;
        if (maxTryReached && !isNewHeight) {
			if (this.node.verb > 1) this.logger.log(`[SOLVER] Max try reached for block (Height: ${block.index})`, (m, c) => console.warn(m, c));
			return;
		}
        
        if (isNewHeight) this.powBroadcastState.sentTryCount = 0;
        this.powBroadcastState.foundHeight = block.index;
        this.powBroadcastState.sentTryCount++;

		// Ensure the block timestamp is not in the future
		const t = this.node.time || Date.now();
		if (block.timestamp > t + 990) await new Promise((resolve) => setTimeout(resolve, block.timestamp - (t + 990)));
        if (this.node.verb > 2) this.logger.log(`[SOLVER] SENDING: Block finalized, validator: ${validatorAddress} | solver: ${solverAddress}
			(Height: ${block.index}) | Diff = ${block.difficulty} | coinBase = ${CURRENCY.formatNumberAsCurrency(block.coinBase)}`, (m, c) => console.info(m, c));
			if (this.node.verb > 2) this.logger.log(`[SOLVER] -POW- #${block.index} | V:${validatorAddress} | M:${solverAddress} | ${block.difficulty} | ${CURRENCY.formatNumberAsCurrency(block.coinBase)}`, (m, c) => console.info(m, c));        
		
		// THEN SHARE THE FINALIZED BLOCK
		const serialized = serializer.serialize.block(block, 'finalized');
        this.node.p2p.broadcast(serialized, { topic: 'block_finalized' });
		//console.log(`[SOLVER:${solverAddress}] Broadcasted #${block.index}`); // DEBUG
        this.addressOfCandidatesBroadcasted.push(validatorAddress);
		//const deserializedBlock = serializer.deserialize.blockFinalized(serialized); // DEBUG
		this.node.taskQueue.pushFirst('DigestBlock', serialized);
    }
	/** @param {string} sAddress @param {Uint8Array[]} [identityEntries] */
    async #createMissingWorkers(sAddress, identityEntries) {
		if (!this.node.time) return 0;

        const missingWorkers = this.nbOfWorkers - this.workers.length;
        let readyWorkers = this.workers.length;
        if (missingWorkers <= 0) return readyWorkers;

        for (let i = 0; i < missingWorkers; i++) {
            const workerIndex = readyWorkers + i;
            const blockBet = this.bets?.[workerIndex] || 0;
			const timeOffset = Date.now() - this.node.time;
            this.workers.push(new SolverWorker(sAddress, blockBet, timeOffset, identityEntries));
            readyWorkers++;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000)); // let time to start workers
        return readyWorkers;
    }
    async #togglePausedWorkers() {
        for (let i = this.nbOfWorkers; i < this.workers.length; i++)
            if (this.workers[i]?.paused === false) this.workers[i].pause();
        
        for (let i = 0; i < this.nbOfWorkers; i++)
            if (this.workers[i]?.paused === true) this.workers[i].resume();
    }
    async #terminateUnusedWorkers() {
		if (this.workers.length <= this.nbOfWorkers) return;
        for (let i = this.nbOfWorkers; i < this.workers.length; i++)
			await this.workers[i].terminateAsync();
        this.workers = this.workers.slice(0, this.nbOfWorkers);
    }
}