// @ts-check
import { BlockUtils } from './block.mjs';
import { CURRENCY } from '../../utils/currency.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { mining } from '../../utils/conditionals.mjs';
import { MinerWorker } from '../workers/miner-worker-wrapper.mjs';
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';

/**
 * @typedef {import("./node.mjs").ContrastNode} ContrastNode
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("./websocketCallback.mjs").WebSocketCallBack} WebSocketCallBack */

export class Miner {
	node;
	address;
	version = 1;
	nbOfWorkers = 1;
	terminated = false;
	useBetTimestamp = true;
	logger = new MiniLogger('miner');
	
	/** @type {string[]} */								addressOfCandidatesBroadcasted = [];
	/** @type {Object<string, WebSocketCallBack>} */	wsCallbacks = {};
	/** @type {BlockCandidate | null} */				bestCandidate = null;
	/** @type {MinerWorker[]} */						workers = [];
	/** @type {number[]} */								bets = [];
	/** @type {{min: number, max: number}} will bet between 70% and 90% of the expected blockTime */
	betRange = { min: .7, max: .9 };
	powBroadcastState = { foundHeight: -1, sentTryCount: 0, maxTryCount: 1 };
	canProceedMining = true;
	hashPeriodStart = 0;
	hashCount = 0;
	hashRate = 0; // hash rate in H/s

    /** @param {ContrastNode} node */
    constructor(node) {
        this.node = node;
        this.address = node.rewardAddresses.miner;
    }

    get bestCandidateIndex() { return this.bestCandidate ? this.bestCandidate.index : -1; }
    get bestCandidateLegitimacy() { return this.bestCandidate ? this.bestCandidate.legitimacy : 0; }

	// API METHODS
    /** @param {BlockCandidate} block */
    updateBestCandidate(block) {
		if (!block) throw new Error('Candidate is null or undefined');
		
		const validatorPubKey = block.Txs[0].witnesses[0].split(':')[1];
		const validatorAddress = block.Txs[0].outputs[0].address;
        const isMyBlock = validatorPubKey === this.node.account?.pubKey;
        const posReward = block.Txs[0].outputs[0].amount;
        const powReward = block.powReward;
        if (!posReward || !powReward) throw new Error(`Invalid candidate (#${block.index} | v:${validatorAddress}) | posReward = ${posReward} | powReward = ${powReward}`);
		if (Math.abs(posReward - powReward) > 1) throw new Error(`Invalid candidate (#${block.index} | v:${validatorAddress}) | posReward = ${posReward} | powReward = ${powReward} | Math.abs(posReward - powReward) > 1`);

        const prevHash = this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : '0000000000000000000000000000000000000000000000000000000000000000';
        if (block.prevHash !== prevHash) throw new Error(`Invalid candidate prevHash (#${block.index} | v:${validatorAddress}) | expected: ${prevHash} | got: ${block.prevHash}`);
        
        let reasonChange = 'none';
        if (!this.bestCandidate)
            reasonChange = '(no best candidate, set first)';
        else if (block.index > this.bestCandidate.index)
            reasonChange = '(replacing by higher block height)';
        else if (this.bestCandidate.prevHash !== prevHash)
            reasonChange = '(replacing invalid prevHash)';
        else if (block.index === this.bestCandidate.index) {
            const newCandidateFinalDiff = mining.getBlockFinalDifficulty(block).finalDifficulty;
            const bestCandidateFinalDiff = mining.getBlockFinalDifficulty(this.bestCandidate).finalDifficulty;
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

        if (this.node.verb > 2) this.logger.log(`[MINER] Best block candidate changed${reasonChange}:
from #${this.bestCandidate ? this.bestCandidate.index : null} (leg: ${this.bestCandidate ? this.bestCandidate.legitimacy : null})
to #${block.index} (leg: ${block.legitimacy})${isMyBlock ? ' (my block)' : ''}`, (m, c) => console.info(m, c));
        
        // if block is different than the highest block index, then reset the addressOfCandidatesBroadcasted
        if (block.index !== this.bestCandidateIndex) this.addressOfCandidatesBroadcasted = [];
        this.bestCandidate = block;
        
        this.#prepareBets();
        if (this.wsCallbacks.onBestBlockCandidateChange) this.wsCallbacks.onBestBlockCandidateChange.execute(block);
        return true;
    }
	async tick() {
		if (this.terminated) return;

		const rewardAddress = this.node.rewardAddresses.miner;
		const blockCandidate = this.bestCandidate;
		if (!rewardAddress || !blockCandidate) return;
		if (blockCandidate.index !== this.bestCandidateIndex) {
			if (this.node.verb > 2) this.logger.log(`[MINER] Block candidate is not the highest block candidate: #${blockCandidate.index} < #${this.bestCandidateIndex}`, (m, c) => console.info(m, c));
			return;
		}

		this.#togglePausedWorkers();
		await this.#terminateUnusedWorkers();
		const readyWorkers = await this.#createMissingWorkers(rewardAddress);
		this.hashRate = this.#getAverageHashrate();
		
		const timings = { start: Date.now(), workersUpdate: 0, updateInfo: 0 }
		for (let i = 0; i < readyWorkers; i++) await this.workers[i].updateCandidate(blockCandidate);
		
		timings.workersUpdate = Date.now();
		for (let i = 0; i < readyWorkers; i++) {
			if (!this.node.time) return;
			const blockBet = this.bets?.[i] || 0;
			const timeOffset = Date.now() - this.node.time;
			this.workers[i].updateInfo(rewardAddress, blockBet, timeOffset);
		}
		timings.updateInfo = Date.now();

		for (let i = 0; i < readyWorkers; i++) {
			const worker = this.workers[i];
			if (worker.isWorking) continue;
			if (worker.result !== null) {
				const finalizedBlock = worker.getResultAndClear();
				if (this.node.verb > 2) this.logger.log(`[MINER] Worker ${i} pow! #${finalizedBlock.index})`, (m, c) => console.info(m, c));
				await this.#broadcastFinalizedBlock(finalizedBlock);
			}

			if (!this.canProceedMining) continue;
			worker.mineUntilValid();
		}
		
		const endTimestamp = Date.now();
		const timeSpent = endTimestamp - timings.start;
		if (timeSpent < 1000) return;

		if (this.node.verb > 1) this.logger.log(`[MINER] Abnormal time spent: ${timeSpent}ms
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
    #prepareBets(nbOfBets = 32) {
        if (!this.useBetTimestamp) { this.bets = []; return }

        const { min, max } = this.betRange;
        const bets = [];
        for (let i = 0; i < nbOfBets; i++) bets.push(mining.betPowTime(min, max));

        this.bets = bets;
    }
    #getAverageHashrate() {
        let totalHashRate = 0;
        for (const worker of this.workers) { totalHashRate += worker.hashRate; }
        return totalHashRate;
    }
    /** @param {BlockFinalized} block */
    async #broadcastFinalizedBlock(block) {
        // Avoid sending the block pow if a higher block candidate is available to be mined
        if (this.bestCandidateIndex > block.index) {
            if (this.node.verb > 2) this.logger.log(`[MINER] Block finalized is not the highest block candidate: #${block.index} < #${this.bestCandidateIndex}`, (m, c) => console.info(m, c));
            return;
        }
        
        const validatorAddress = block.Txs[1].inputs[0].split(':')[0];
		const minerAddress = block.Txs[0].outputs[0].address;
        if (this.addressOfCandidatesBroadcasted.includes(validatorAddress)) {
        	if (this.node.verb > 2) this.logger.log(`[MINER] Block finalized already sent (Height: ${block.index})`, (m, c) => console.info(m, c));
            return;
        }

        // Avoid sending the same block multiple times
        const isNewHeight = block.index > this.powBroadcastState.foundHeight;
        const maxTryReached = this.powBroadcastState.sentTryCount >= this.powBroadcastState.maxTryCount;
        if (maxTryReached && !isNewHeight) {
			if (this.node.verb > 1) this.logger.log(`[MINER] Max try reached for block (Height: ${block.index})`, (m, c) => console.warn(m, c));
			return;
		}
        
        if (isNewHeight) this.powBroadcastState.sentTryCount = 0;
        this.powBroadcastState.foundHeight = block.index;
        this.powBroadcastState.sentTryCount++;

		// Ensure the block timestamp is not in the future
		const t = this.node.time || Date.now();
		if (block.timestamp > t + 990) await new Promise((resolve) => setTimeout(resolve, block.timestamp - (t + 990)));
        if (this.node.verb > 2) this.logger.log(`[MINER] SENDING: Block finalized, validator: ${validatorAddress} | miner: ${minerAddress}
			(Height: ${block.index}) | Diff = ${block.difficulty} | coinBase = ${CURRENCY.formatNumberAsCurrency(block.coinBase)}`, (m, c) => console.info(m, c));
			if (this.node.verb > 2) this.logger.log(`[MINER] -POW- #${block.index} | V:${validatorAddress} | M:${minerAddress} | ${block.difficulty} | ${CURRENCY.formatNumberAsCurrency(block.coinBase)}`, (m, c) => console.info(m, c));        
		
		// THEN SHARE THE FINALIZED BLOCK
		const serialized = serializer.serialize.block(block, 'finalized');
        this.node.p2p.broadcast(serialized, { topic: 'block_finalized' });
		//console.log(`[MINER:${minerAddress}] Broadcasted #${block.index}`); // DEBUG
        this.addressOfCandidatesBroadcasted.push(validatorAddress);
		//const deserializedBlock = serializer.deserialize.blockFinalized(serialized); // DEBUG
		this.node.taskQueue.pushFirst('DigestBlock', serialized);
        if (this.wsCallbacks.onBroadcastFinalizedBlock) this.wsCallbacks.onBroadcastFinalizedBlock.execute(BlockUtils.getFinalizedBlockHeader(block));
    }
	/** @param {string} rewardAddress */
    async #createMissingWorkers(rewardAddress) {
		if (!this.node.time) return 0;

        const missingWorkers = this.nbOfWorkers - this.workers.length;
        let readyWorkers = this.workers.length;
        if (missingWorkers <= 0) return readyWorkers;

        for (let i = 0; i < missingWorkers; i++) {
            const workerIndex = readyWorkers + i;
            const blockBet = this.bets?.[workerIndex] || 0;
			const timeOffset = Date.now() - this.node.time;
            this.workers.push(new MinerWorker(rewardAddress, blockBet, timeOffset));
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