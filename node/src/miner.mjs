import { BlockData, BlockUtils } from './block-classes.mjs';
import { MinerWorker } from '../workers/workers-classes.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { convert } from '../../utils/converters.mjs';
import { mining } from '../../utils/mining-functions.mjs';

/**
 * @typedef {import("./wallet.mjs").Account} Account
 * @typedef {import("./node.mjs").Node} Node
 * @typedef {import("./OpStack.mjs").OpStack} OpStack
 * @typedef {import("./websocketCallback.mjs").WebSocketCallBack} WebSocketCallBack
 * @typedef {import("../../utils/time.mjs").TimeSynchronizer} TimeSynchronizer
 */

export class Miner {
    /** @param {Account} address @param {Node} node */
    //constructor(address, node, roles = ['miner'], opStack = null, timeSynchronizer = null) {
    constructor(address, node) {
        this.terminated = false;
        this.version = 1;
        this.useBetTimestamp = true;

        /** @type {string} */
        this.address = address;
        /** @type {BlockData | null} */
        this.bestCandidate = null;
        this.addressOfCandidatesBroadcasted = [];
        /** @type {Node} */
        this.node = node;

        /** @type {MinerWorker[]} */
        this.workers = [];
        this.nbOfWorkers = 1;

        /** @type {number[]} */
        this.bets = [];
        /** @type {{min: number, max: number}} */
        this.betRange = { min: .7, max: .9 }; // will bet between 70% and 90% of the expected blockTime
        this.powBroadcastState = { foundHeight: -1, sentTryCount: 0, maxTryCount: 3 };

        this.roles = node.roles;
        this.canProceedMining = true;
        this.hashPeriodStart = 0;
        this.hashCount = 0;
        this.hashRate = 0; // hash rate in H/s

        /** @type {OpStack} */
        this.opStack = node.opStack; // only for multiNode (validator + miner)
        /** @type {TimeSynchronizer} */
        this.timeSynchronizer = node.timeSynchronizer;

        /** @type {Object<string, WebSocketCallBack>} */
        this.wsCallbacks = {};
    }

    bestCandidateIndex() { return this.bestCandidate ? this.bestCandidate.index : -1; }
    bestCandidateLegitimacy() { return this.bestCandidate ? this.bestCandidate.legitimacy : 0; }

    /** @param {BlockData} blockCandidate */
    updateBestCandidate(blockCandidate) {
        const posAddress = blockCandidate.Txs[0].inputs[0].split(':')[0];
        const isMyBlock = posAddress === this.node.id;
        // check if powReward is coherent
        const posReward = blockCandidate.Txs[0].outputs[0].amount;
        const powReward = blockCandidate.powReward;
        if (!posReward || !powReward) { console.info(`[MINER-${this.address.slice(0, 6)}] Invalid block candidate pushed (#${blockCandidate.index} | v:${validatorAddress.slice(0,6 )}) | posReward = ${posReward} | powReward = ${powReward}`); return; }
        if (Math.abs(posReward - powReward) > 1) { console.info(`[MINER-${this.address.slice(0, 6)}] Invalid block candidate pushed (#${blockCandidate.index} | v:${validatorAddress.slice(0,6 )}) | posReward = ${posReward} | powReward = ${powReward} | Math.abs(posReward - powReward) > 1`); return; }

        const prevHash = this.node.blockchain.lastBlock ? this.node.blockchain.lastBlock.hash : '0000000000000000000000000000000000000000000000000000000000000000';
        if (blockCandidate.prevHash !== prevHash) return false;
        
        let reasonChange = 'none';
        if (!this.bestCandidate) {
            reasonChange = '(no best candidate, set first)';
        } else if (blockCandidate.index > this.bestCandidate.index) {
            reasonChange = '(replacing by higher block height)';
        } else if (this.bestCandidate.prevHash !== prevHash) {
            reasonChange = '(replacing invalid prevHash)';
        } else if (blockCandidate.index === this.bestCandidate.index) {
            const newCandidateFinalDiff = mining.getBlockFinalDifficulty(blockCandidate).finalDifficulty;
            const bestCandidateFinalDiff = mining.getBlockFinalDifficulty(this.bestCandidate).finalDifficulty;
            if (newCandidateFinalDiff > bestCandidateFinalDiff) return false;
            if (newCandidateFinalDiff < bestCandidateFinalDiff) { reasonChange = `(easier block: ${newCandidateFinalDiff} < ${bestCandidateFinalDiff})`; }
            // if everything is the same, then check the powReward to decide
            if (reasonChange === 'none' && powReward > this.bestCandidate.powReward )
                reasonChange = ` (higher powReward: ${powReward} > ${this.bestCandidate.powReward})`;
            
            // preserve the current best candidate, but update considered as true to encourage re-bradcasting
            if (reasonChange === 'none') return true;
        }

        // preserve the current best candidate, but update considered as true to encourage re-bradcasting
        if (reasonChange === 'none') return true;

        console.info(`[MINER-${this.address.slice(0, 6)}] Best block candidate changed${reasonChange}:
from #${this.bestCandidate ? this.bestCandidate.index : null} (leg: ${this.bestCandidate ? this.bestCandidate.legitimacy : null})
to #${blockCandidate.index} (leg: ${blockCandidate.legitimacy})${isMyBlock ? ' (my block)' : ''}`);
        
        // if block is different than the highest block index, then reset the addressOfCandidatesBroadcasted
        if (blockCandidate.index !== this.bestCandidateIndex()) { this.addressOfCandidatesBroadcasted = []; }
        this.bestCandidate = blockCandidate;
        
        this.#prepareBets();
        if (this.wsCallbacks.onBestBlockCandidateChange) { this.wsCallbacks.onBestBlockCandidateChange.execute(blockCandidate); }
        return true;
    }
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
    /** @param {BlockData} finalizedBlock */
    async broadcastFinalizedBlock(finalizedBlock) {
        // Avoid sending the block pow if a higher block candidate is available to be mined
        if (this.bestCandidateIndex() > finalizedBlock.index) {
            console.info(`[MINER-${this.address.slice(0, 6)}] Block finalized is not the highest block candidate: #${finalizedBlock.index} < #${this.bestCandidateIndex()}`);
            return;
        }
        
        const validatorAddress = finalizedBlock.Txs[1].inputs[0].split(':')[0];
        if (this.addressOfCandidatesBroadcasted.includes(validatorAddress)) {
            console.info(`[MINER-${this.address.slice(0, 6)}] Block finalized already sent (Height: ${finalizedBlock.index})`);
            return;
        }

        // Avoid sending the same block multiple times
        const isNewHeight = finalizedBlock.index > this.powBroadcastState.foundHeight;
        const maxTryReached = this.powBroadcastState.sentTryCount >= this.powBroadcastState.maxTryCount;
        if (maxTryReached && !isNewHeight) { console.warn(`[MINER-${this.address.slice(0, 6)}] Max try reached for block (Height: ${finalizedBlock.index})`); return; }
        
        if (isNewHeight) { this.powBroadcastState.sentTryCount = 0; }
        this.powBroadcastState.foundHeight = finalizedBlock.index;
        this.powBroadcastState.sentTryCount++;

        const validatorId = validatorAddress.slice(0, 6);
        const minerId = this.address.slice(0, 6);
        //console.info(`[MINER-${this.address.slice(0, 6)}] SENDING: Block finalized, validator: ${validatorId} | miner: ${minerId}
//(Height: ${finalizedBlock.index}) | Diff = ${finalizedBlock.difficulty} | coinBase = ${convert.formatNumberAsCurrency(finalizedBlock.coinBase)}`);
        console.info(`[MINER-${this.address.slice(0, 6)}] -POW- #${finalizedBlock.index} | ${validatorId} | ${minerId} | ${finalizedBlock.difficulty} | ${convert.formatNumberAsCurrency(finalizedBlock.coinBase)}`);        

        this.addressOfCandidatesBroadcasted.push(validatorAddress);

        await this.node.p2pBroadcast('new_block_finalized', finalizedBlock);
        if (this.roles.includes('validator')) { this.opStack.pushFirst('digestPowProposal', finalizedBlock); };
        
        if (this.wsCallbacks.onBroadcastFinalizedBlock) { this.wsCallbacks.onBroadcastFinalizedBlock.execute(BlockUtils.getBlockHeader(finalizedBlock)); }
    }
    async #createMissingWorkers() {
        const missingWorkers = this.nbOfWorkers - this.workers.length;
        let readyWorkers = this.workers.length;
        if (missingWorkers <= 0) { return readyWorkers }

        for (let i = 0; i < missingWorkers; i++) {
            const workerIndex = readyWorkers + i;
            const blockBet = this.bets?.[workerIndex] || 0;
            this.workers.push(new MinerWorker(this.address, blockBet, this.timeSynchronizer.offset));
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
        for (let i = this.nbOfWorkers; i < this.workers.length; i++) this.workers[i].terminateAsync();
        this.workers = this.workers.slice(0, this.nbOfWorkers);
    }
    /** DON'T AWAIT THIS FUNCTION */
    async startWithWorker() {
        const delayBetweenUpdate = 10; // previously 100ms
        let countBeforeCleaning = 0;
        while (!this.terminated) {
            await new Promise((resolve) => setTimeout(resolve, delayBetweenUpdate));
            this.#togglePausedWorkers();
            if (countBeforeCleaning > 0) countBeforeCleaning--;
            if (countBeforeCleaning <= 0) {
                await this.#terminateUnusedWorkers();
                countBeforeCleaning = 200;
            }
            const readyWorkers = await this.#createMissingWorkers();
            this.hashRate = this.#getAverageHashrate();
            
            const blockCandidate = this.bestCandidate;
            if (!blockCandidate) { continue; }
            if (blockCandidate.index !== this.bestCandidateIndex()) {
                console.info(`[MINER-${this.address.slice(0, 6)}] Block candidate is not the highest block candidate`);
                continue;
            }
            
            const timings = { start: Date.now(), workersUpdate: 0, updateInfo: 0 }
            for (let i = 0; i < readyWorkers; i++) await this.workers[i].updateCandidate(blockCandidate);
            timings.workersUpdate = Date.now();
            
            for (let i = 0; i < readyWorkers; i++) {
                const blockBet = this.bets?.[i] || 0;
                await this.workers[i].updateInfo(this.address, blockBet, this.timeSynchronizer.offset);
            }
            timings.updateInfo = Date.now();

            for (let i = 0; i < readyWorkers; i++) {
                const worker = this.workers[i];
                if (worker.isWorking) continue;
                if (worker.result !== null) {
                    const finalizedBlock = worker.getResultAndClear();
                    //console.info(`[MINER-${this.address.slice(0, 6)}] Worker ${i} pow! #${finalizedBlock.index})`);
                    await this.broadcastFinalizedBlock(finalizedBlock);
                }

                if (!this.canProceedMining) continue;
                worker.mineUntilValid();
            }
            
            const endTimestamp = Date.now();
            const timeSpent = endTimestamp - timings.start;
            if (timeSpent < 1000) { continue; }

            console.info(`[MINER-${this.address.slice(0, 6)}] Abnormal time spent: ${timeSpent}ms
            - workersUpdate: ${timings.workersUpdate - timings.start}ms
            - updateInfo: ${timings.updateInfo - timings.workersUpdate}ms`);
        }

        console.info(`[MINER-${this.address.slice(0, 6)}] Stopped`);
    }
    async terminateAsync() {
        const promises = [];
        for (const worker of this.workers) { promises.push(worker.terminateAsync()); }
        await Promise.all(promises);
        this.terminated = true;
    }
}