import { BlockData, BlockUtils } from './block-classes.mjs';
import { MinerWorker } from '../workers/workers-classes.mjs';
import utils from './utils.mjs';

/**
 * @typedef {import("./wallet.mjs").Account} Account
 * @typedef {import("./node.mjs").Node} Node
 * @typedef {import("./OpStack.mjs").OpStack} OpStack
 * @typedef {import("./websocketCallback.mjs").WebSocketCallBack} WebSocketCallBack
 * @typedef {import("../plugins/time.mjs").TimeSynchronizer} TimeSynchronizer
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

        this.highestBlockIndex = -1;
        this.useDevArgon2 = false;
        /** @type {MinerWorker[]} */
        this.workers = [];
        this.nbOfWorkers = 1;

        /** @type {Object<string, number[]>} */
        this.bets = {};
        /** @type {{min: number, max: number}} */
        this.betRange = { min: .4, max: .8 }; // will bet between 40% and 80% of the expected blockTime
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
    /** @param {BlockData} blockCandidate */
    updateBestCandidate(blockCandidate) {
        // check if powReward is coherent
        const posReward = blockCandidate.Txs[0].outputs[0].amount;
        const powReward = blockCandidate.powReward;
        if (!posReward || !powReward) { console.info(`[MINER] Invalid block candidate pushed (#${blockCandidate.index} | v:${validatorAddress.slice(0,6 )}) | posReward = ${posReward} | powReward = ${powReward}`); return; }
        if (Math.abs(posReward - powReward) > 1) { console.info(`[MINER] Invalid block candidate pushed (#${blockCandidate.index} | v:${validatorAddress.slice(0,6 )}) | posReward = ${posReward} | powReward = ${powReward} | Math.abs(posReward - powReward) > 1`); return; }

        const changed = this.#setBestCandidateIfChanged(blockCandidate);
        if (!changed) { return; }

        // check if block is higher than the highest block
        if (blockCandidate.index > this.highestBlockIndex) {
            this.addressOfCandidatesBroadcasted = [];
        }
        
        this.highestBlockIndex = blockCandidate.index;
        this.bets[blockCandidate.index] = this.bets[blockCandidate.index] || this.#betPowTime();

        if (this.wsCallbacks.onBestBlockCandidateChange) {
            this.wsCallbacks.onBestBlockCandidateChange.execute(blockCandidate);
        }
    }
    #betPowTime(nbOfBets = 32) {
        const bets = [];
        for (let i = 0; i < nbOfBets; i++) {
            if (!this.useBetTimestamp) { bets.push(0); continue; }
            const targetBlockTime = utils.SETTINGS.targetBlockTime;
            const betBasis = targetBlockTime * this.betRange.min;
            const betRandom = Math.random() * (this.betRange.max - this.betRange.min) * targetBlockTime;
            const bet = Math.floor(betBasis + betRandom);

            bets.push(bet);
        }

        return bets;
    }
    /** @param {BlockData} blockCandidate */
    #setBestCandidateIfChanged(blockCandidate) {
        if (this.bestCandidate !== null) {
            const candidateValidatorAddress = blockCandidate.Txs[0].inputs[0].split(':')[0];
            const bestCandidateValidatorAddress = this.bestCandidate.Txs[0].inputs[0].split(':')[0];

            const bestCandidateIndexChanged = this.bestCandidate.index !== blockCandidate.index;
            const bestCandidateValidatorAddressChanged = bestCandidateValidatorAddress !== candidateValidatorAddress;
            if (!bestCandidateIndexChanged && !bestCandidateValidatorAddressChanged) { return false; }
        }

        if (this.bestCandidate && blockCandidate.index === this.bestCandidate.index) {
            const newCandidateFinalDiff = utils.mining.getBlockFinalDifficulty(blockCandidate);
            const bestCandidateFinalDiff = utils.mining.getBlockFinalDifficulty(this.bestCandidate);
            if (newCandidateFinalDiff.finalDifficulty >= bestCandidateFinalDiff.finalDifficulty) { return; }
            console.info(`[MINER] easier block, final diffs: before = ${bestCandidateFinalDiff.finalDifficulty} | after = ${newCandidateFinalDiff.finalDifficulty}`);
        }

        console.info(`[MINER] Best block candidate changed:
from #${this.bestCandidate ? this.bestCandidate.index : null} | leg: ${this.bestCandidate ? this.bestCandidate.legitimacy : null}
to #${blockCandidate.index} | leg: ${blockCandidate.legitimacy}`);

        this.bestCandidate = blockCandidate;

        return true;
    }
    #getAverageHashrate() {
        let totalHashRate = 0;
        for (const worker of this.workers) {
            //totalHashRate += worker.getHashRate();
            totalHashRate += worker.hashRate;
        }

        return totalHashRate;
    }
    /** @param {BlockData} finalizedBlock */
    async broadcastFinalizedBlock(finalizedBlock) {
        // Avoid sending the block pow if a higher block candidate is available to be mined
        if (this.highestBlockIndex > finalizedBlock.index) {
            console.info(`[MINER-${this.address.slice(0, 6)}] Block finalized is not the highest block candidate: #${finalizedBlock.index} < #${this.highestBlockIndex}`);
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
        console.info(`[MINER-${this.address.slice(0, 6)}] SENDING: Block finalized, validator: ${validatorId} | miner: ${minerId}
(Height: ${finalizedBlock.index}) | Diff = ${finalizedBlock.difficulty} | coinBase = ${utils.convert.number.formatNumberAsCurrency(finalizedBlock.coinBase)}`);
        
        this.addressOfCandidatesBroadcasted.push(validatorAddress);

        await this.node.p2pBroadcast('new_block_finalized', finalizedBlock);
        if (this.roles.includes('validator')) { this.opStack.pushFirst('digestPowProposal', finalizedBlock); };
        
        if (this.wsCallbacks.onBroadcastFinalizedBlock) { this.wsCallbacks.onBroadcastFinalizedBlock.execute(BlockUtils.getBlockHeader(finalizedBlock)); }
    }
    async createMissingWorkers() {
        const missingWorkers = this.nbOfWorkers - this.workers.length;
        let readyWorkers = this.workers.length;
        if (missingWorkers <= 0) { return readyWorkers }

        for (let i = 0; i < missingWorkers; i++) {
            const workerIndex = readyWorkers + i;
            const blockBet = this.bets && this.bets[this.highestBlockIndex] ? this.bets[this.highestBlockIndex][workerIndex] : 0;
            this.workers.push(new MinerWorker(
                this.address,
                blockBet,
                this.timeSynchronizer.offset
            ));

            readyWorkers++;
        }

        // let time to start workers
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return readyWorkers;
    }
    async terminateUnusedWorkers() {
        for (let i = this.nbOfWorkers; i < this.workers.length; i++) {
            await this.workers[i].terminateAsync();
        }
        this.workers = this.workers.slice(0, this.nbOfWorkers);
    }
    /** DON'T AWAIT THIS FUNCTION */
    async startWithWorker() {
        const delayBetweenUpdate = this.roles.includes('validator') ? 200 : 100;
        while (!this.terminated) {
            await new Promise((resolve) => setTimeout(resolve, delayBetweenUpdate));
            await this.terminateUnusedWorkers();
            const readyWorkers = await this.createMissingWorkers();
            this.hashRate = this.#getAverageHashrate();
            
            const blockCandidate = this.bestCandidate;
            if (!blockCandidate) { continue; }
            if (blockCandidate.index !== this.highestBlockIndex) {
                console.info(`[MINER-${this.address.slice(0, 6)}] Block candidate is not the highest block candidate`);
                continue;
            }
            
            const timings = {
                start: Date.now(),
                workersUpdate: 0,
                updateInfo: 0
            }

            for (let i = 0; i < readyWorkers; i++) {
                const worker = this.workers[i];
                await worker.updateCandidate(blockCandidate);
            }
            timings.workersUpdate = Date.now();
            
            for (let i = 0; i < readyWorkers; i++) {
                const worker = this.workers[i];
                const blockBet = this.bets && this.bets[this.highestBlockIndex] ? this.bets[this.highestBlockIndex][i] : 0;
                await worker.updateInfo(this.address, blockBet, this.timeSynchronizer.offset);
            }
            timings.updateInfo = Date.now();

            for (let i = 0; i < readyWorkers; i++) {
                const worker = this.workers[i];
                if (worker.isWorking) { continue; }
                if (worker.result !== null) {
                    const finalizedBlock = worker.getResultAndClear();
                    //console.info(`[MINER-${this.address.slice(0, 6)}] Worker ${i} pow! #${finalizedBlock.index})`);
                    await this.broadcastFinalizedBlock(finalizedBlock);
                }

                if (!this.canProceedMining) { continue; }
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
    async terminate() {
        //this.workers.forEach(worker => worker.terminateAsync());
        for (const worker of this.workers) {
            await worker.terminateAsync();
        }
        this.terminated = true;
    }
}