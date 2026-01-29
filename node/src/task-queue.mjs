import { MiniLogger } from '../../miniLogger/mini-logger.mjs';

/**
 * @typedef { 'PushTx' | 'DigestBlock' | 'NewCandidate' | 'Sync' } TaskType
 */

export class TaskQueue {
	miniLogger = new MiniLogger('OpStack');
	transactionsBatchSize = 50; // max txs to batch as a single task
	terminated = false;
	/** @type {Array<{type: TaskType, data: any}>} */
	queue = [];

	/** @param {TaskType} type @param {any} data */
	push(type, data) { this.queue.push({ type, data }); }

	/** @param {TaskType} type @param {any} data */
	pushFirst(type, data) { this.queue.unshift({ type, data }); }

	get isNextTaskTxPush() { return this.queue[0]?.type === 'PushTx'; }

	get nextTask() {
		const task = this.queue.shift();
		if (!task) return null;

		if (task.type !== 'PushTx') return task;
        if (!this.isNextTaskTxPush) return { type: 'PushTxs', data: [task.data] };

		// BATCH PUSH TRANSACTIONS TASKS
		const upgradedTask = { type: 'PushTxs', data: [] };
		while (this.isNextTaskTxPush && upgradedTask.data.length < this.transactionsBatchSize)
			upgradedTask.data.push(this.queue.shift().data);
		
		return upgradedTask;
	}
}