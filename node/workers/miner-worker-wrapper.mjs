import { newWorker } from './unified-worker-initializer.mjs';

/**
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized */

export class MinerWorker {
	/** @type {BlockCandidate} */	blockCandidate = null;
	/** @type {BlockFinalized} */	result = null;

	terminate = false;
	isWorking = false;
	paused = false;
	hashRate = 0;

	constructor(rewardAddress = '', bet = 0, timeOffset = 0) {
		this.rewardAddress = rewardAddress;
		this.bet = bet;
		this.timeOffset = timeOffset;
		this.worker = newWorker('./miner-worker-nodejs.mjs');
		this.worker.addEventListener('message', this.#onMessage);
	}

	#onMessage = (event) => {
		const message = event.data || event;
		if (message.paused === true || message.paused === false) {
			this.paused = message.paused;
			console.log('MinerWorker paused new state:', message.paused);
			return;
		}
		if (message.hashRate) { this.hashRate = message.hashRate; return; }
		if (message.result?.error) console.error(message.result.error);
		if (message.result && !message.result.error) this.result = message.result;
		this.isWorking = false;
	}
	/** @param {BlockCandidate} block */
	#isSameBlockCandidate(block) {
		if (this.blockCandidate === null) return false;

		const sameIndex = this.blockCandidate.index === block.index;
		const samePrevHash = this.blockCandidate.prevHash === block.prevHash;
		const newCandidateValidatorAddress = block.Txs[0].outputs[0].address;
		const currentCandidateValidatorAddress = this.blockCandidate.Txs[0].outputs[0].address;
		const sameValidatorAddress = currentCandidateValidatorAddress === newCandidateValidatorAddress;
		return sameIndex && samePrevHash && sameValidatorAddress;
	}
	
	/** @param {string} rewardAddress @param {number} bet @param {number} timeOffset */
	updateInfo(rewardAddress, bet, timeOffset) {
		if (this.terminate) return;
		
		const isSame = this.rewardAddress === rewardAddress && this.bet === bet && this.timeOffset === timeOffset;
		if (isSame) return;

		this.rewardAddress = rewardAddress;
		this.bet = bet;
		this.timeOffset = timeOffset;
		this.worker.postMessage({ type: 'updateInfo', rewardAddress, bet, timeOffset });
	}
	/** @param {BlockCandidate} blockCandidate */
	async updateCandidate(blockCandidate) {
		if (this.terminate) return;
		if (this.#isSameBlockCandidate(blockCandidate)) return;

		this.blockCandidate = blockCandidate;
		this.worker.postMessage({ type: 'newCandidate', blockCandidate });

		await new Promise(resolve => setTimeout(resolve, 200));
	}
	mineUntilValid() {
		if (this.terminate) return;
		if (this.isWorking) return;
		
		this.isWorking = true;
		this.result = null;

		this.worker.postMessage({
			type: 'mineUntilValid',
			rewardAddress: this.rewardAddress,
			bet: this.bet,
			timeOffset: this.timeOffset
		});
	}
	getResultAndClear() {
		const finalizedBlock = this.result;
		this.result = null;
		return finalizedBlock;
	}
	pause() { this.worker.postMessage({ type: 'pause' }); }
	resume() { this.worker.postMessage({ type: 'resume' }); }
	terminateAsync() {
		this.terminate = true;

		// BROWSER SHUTDOWN
		if (typeof window !== 'undefined') {
			this.worker.removeEventListener('message', this.#onMessage);
			this.worker.terminate();
			return Promise.resolve();
		}

		// NODEJS GRACEFUL SHUTDOWN
		return new Promise((resolve) => {
			const forceTerminate = setTimeout(async () => {
				console.error('MinerWorker timeout -> forcing termination');
				await this.worker.terminate();
				resolve();
			}, 10000);

			this.worker.addEventListener('exit', () => {
				clearTimeout(forceTerminate);
				this.worker.removeEventListener('message', this.#onMessage);
				console.log('MinerWorker exited gracefully');
				resolve();
			});

			this.worker.postMessage({ type: 'terminate' });
		});
	}
}