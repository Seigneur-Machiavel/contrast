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
	finalDifficulty = 1;   // last known finalDifficulty from worker
	stalenessRatio = 0;    // ratio of stale hashes in last reporting period
	difficulty = 1;        // base difficulty of current candidate (for effective rate weighting)
	sAddress;
	identityEntries;

	/** @param {string} sAddress @param {number} bet @param {number} timeOffset @param {Uint8Array[]} [identityEntries] */
	constructor(sAddress, bet, timeOffset, identityEntries) {
		this.sAddress = sAddress;
		this.identityEntries = identityEntries;
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
		if (message.hashRate) {
			this.hashRate = message.hashRate;
			if (message.finalDifficulty) this.finalDifficulty = message.finalDifficulty;
			if (message.stalenessRatio !== undefined) this.stalenessRatio = message.stalenessRatio;
			return;
		}
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
	/** @param {Uint8Array[] | undefined} entries1 @param {Uint8Array[] | undefined} entries2 */
	#areIdentityEntriesEqual(entries1, entries2) {
		if (!entries1 && !entries2) return true;
		if (!entries1 || !entries2) return false;
		if (entries1.length !== entries2.length) return false;
		for (let i = 0; i < entries1.length; i++) {
			const e1 = entries1[i];
			const e2 = entries2[i];
			if (e1.length !== e2.length) return false;
			for (let j = 0; j < e1.length; j++) if (e1[j] !== e2[j]) return false;
		}
		return true;
	}
	/** @param {string} sAddress @param {number} bet @param {number} timeOffset @param {Uint8Array[]} [identityEntries] */
	updateInfo(sAddress, bet, timeOffset, identityEntries) {
		if (this.terminate) return;
		
		const isSameAddress = this.sAddress === sAddress;
		const isSameBet = this.bet === bet;
		const isSameTimeOffset = this.timeOffset === timeOffset;
		const isSameIdentityEntries = this.#areIdentityEntriesEqual(identityEntries, this.identityEntries);
		if (isSameAddress && isSameBet && isSameTimeOffset && isSameIdentityEntries) return;

		this.sAddress = sAddress;
		this.bet = bet;
		this.timeOffset = timeOffset;
		this.identityEntries = identityEntries;
		this.worker.postMessage({ type: 'updateInfo', sAddress, bet, timeOffset, identityEntries });
	}
	/** @param {BlockCandidate} blockCandidate */
	async updateCandidate(blockCandidate) {
		if (this.terminate) return;
		if (this.#isSameBlockCandidate(blockCandidate)) return;

		this.blockCandidate = blockCandidate;
		this.difficulty = blockCandidate.difficulty; // track base difficulty for weighting
		this.worker.postMessage({ type: 'newCandidate', blockCandidate });

		await new Promise(resolve => setTimeout(resolve, 200));
	}
	mineUntilValid() {
		if (this.terminate) return;
		if (this.isWorking) return;
		
		this.isWorking = true;
		this.result = null;

		const { sAddress, bet, timeOffset, identityEntries } = this;
		this.worker.postMessage({ type: 'mineUntilValid', sAddress, bet, timeOffset, identityEntries });
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