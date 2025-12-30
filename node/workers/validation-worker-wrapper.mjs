import { newWorker } from './unified-worker-initializer.mjs';

/**
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction */

// CLASSES SIMPLIFYING USAGE OF THE WORKERS
export class ValidationWorker {
	/** @type {Worker} worker */
	worker = newWorker('./validation-worker-nodejs.mjs');
	state = 'idle';

    constructor (id = 0) { this.id = id; }
	/** @param {Transaction[]} batch */
	derivationValidation(batch) {
		this.state = 'working';

        const promise = new Promise((resolve, reject) => {
            const onMessage = (event) => {
				const message = event.data || event;
                if (message.id !== this.id) return;

				this.worker.removeEventListener('message', onMessage);
				this.state = 'idle';
				
                if (message.error) return reject(message.error);
                else resolve();
            };

			this.worker.addEventListener('message', onMessage);
			this.worker.postMessage({ id: this.id, type: 'derivationValidation', batch });
        });
        return promise;
    }
	abortOperation() {
		if (this.state === 'working') this.worker.postMessage({ type: 'abortOperation' });
	}
    terminateAsync() {
		// BROWSER SHUTDOWN
		if (typeof window !== 'undefined') {
			this.worker.terminate();
			return Promise.resolve();
		}

		// NODEJS GRACEFUL SHUTDOWN
		return new Promise((resolve) => {
			const forceTerminate = setTimeout(async () => {
				console.error('ValidationWorker timeout -> forcing termination');
				await this.worker.terminate();
				resolve();
			}, 10000);

			this.worker.addEventListener('exit', () => {
				clearTimeout(forceTerminate);
				console.log('ValidationWorker exited gracefully');
				resolve();
			});

			this.worker.postMessage({ type: 'terminate', id: this.id });
		});
    }
}