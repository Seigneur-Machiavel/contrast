// @ts-check
import { MiniLogger } from '../../miniLogger/mini-logger.mjs';

/**
 * @typedef {Object} SingleTask
 * @property {'PushTx' | 'DigestBlock' | 'NewCandidate' | 'Sync'} SingleTask.type
 * @property {Uint8Array} SingleTask.data
 * 
 * @typedef {Object} BatchedTask
 * @property {'PushTxs'} BatchedTask.type
 * @property {Uint8Array[]} BatchedTask.data
*/

export class TaskQueue {
	/** @type {SingleTask[]} */ queue = [];
	miniLogger = new MiniLogger('OpStack');
	transactionsBatchSize = 50; // max txs to batch as a single task
	terminated = false;

	/** @param {SingleTask} task */
	pushTask(task) { this.queue.push(task); }

	/** @param {SingleTask} task */
	pushTaskFirst(task) { this.queue.unshift(task); }

	get nextTask() {
		const task = this.queue.shift();
		if (!task) return null;
		if (task.type !== 'PushTx') return task; // not batchable -> simply return task

		/** BATCH PUSH TRANSACTIONS TASKS @type {BatchedTask} */
		const upgradedTask = { type: 'PushTxs', data: [task.data] };
		while (this.queue[0]?.type === 'PushTx' && upgradedTask.data.length < this.transactionsBatchSize) {
			const nextTask = this.queue.shift(); // shift next single tx task
			if (!nextTask) throw new Error('Next tx task is missing, fatal error!'); // should never append
			upgradedTask.data.push(nextTask.data);
		}
		
		return upgradedTask;
	}
}