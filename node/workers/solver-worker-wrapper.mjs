import { newWorker } from './unified-worker-initializer.mjs';

/**
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized */

export class SolverWorker {
	/** @type {BlockCandidate} */	blockCandidate = null;
	/** @type {BlockFinalized} */	result = null;

	terminate = false;
	isWorking = false;
	paused = false;
	hashRate = 0;
	sAddress;
	data;

	/** @param {string} sAddress @param {number} bet @param {number} timeOffset @param {Uint8Array} [data] */
	constructor(sAddress, bet, timeOffset, data) {
		this.sAddress = sAddress;
		this.data = data;
		this.bet = bet;
		this.timeOffset = timeOffset;
		this.worker = newWorker('./solver-worker-nodejs.mjs');
		this.worker.addEventListener('message', this.#onMessage);
	}

	#onMessage = (event) => {
		const message = event.data || event;
		if (message.paused === true || message.paused === false) {
			this.paused = message.paused;
			console.log('SolverWorker paused new state:', message.paused);
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
	
	/** @param {string} sAddress @param {number} bet @param {number} timeOffset @param {Uint8Array} [data] */
	updateInfo(sAddress, bet, timeOffset, data) {
		if (this.terminate) return;
		
		const isSameAddress = this.sAddress === sAddress;
		const isSameBet = this.bet === bet;
		const isSameTimeOffset = this.timeOffset === timeOffset;
		const isSameData = (!this.data && !data) || (this.data?.length === data?.length && this.data?.every((byte, i) => byte === data[i]));
		if (isSameAddress && isSameBet && isSameTimeOffset && isSameData) return;

		this.sAddress = sAddress;
		this.bet = bet;
		this.timeOffset = timeOffset;
		this.data = data;
		this.worker.postMessage({ type: 'updateInfo', sAddress, bet, timeOffset, data });
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

		const { sAddress, bet, timeOffset, data } = this;
		this.worker.postMessage({ type: 'mineUntilValid', sAddress, bet, timeOffset, data });
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
				console.error('SolverWorker timeout -> forcing termination');
				await this.worker.terminate();
				resolve();
			}, 10000);

			this.worker.addEventListener('exit', () => {
				clearTimeout(forceTerminate);
				this.worker.removeEventListener('message', this.#onMessage);
				console.log('SolverWorker exited gracefully');
				resolve();
			});

			this.worker.postMessage({ type: 'terminate' });
		});
	}
}