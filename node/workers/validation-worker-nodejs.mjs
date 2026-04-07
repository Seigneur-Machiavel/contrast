import { parentPort } from 'worker_threads';
import { serializer } from '../../utils/serializer.mjs';
import { TxValidation } from '../src/tx-validation.mjs';

/** @typedef {import('./validation-worker-wrapper.mjs').WorkerTask} WorkerTask */

// WORKER SIDE
let abortOperationRequested = false;
let workerId = undefined;
parentPort.on('message', async (task) => {
    const id = task.id;
    workerId = workerId || id;

	const response = { id, error: false };
    switch (task.type) {
		case 'signatureValidation':
			abortOperationRequested = false; // Reset for new task
			try {
				/** @type {WorkerTask[]} */
				const batch = task.batch;
				for (const task of batch) { // Validate all witnesses signatures
					if (abortOperationRequested) return;
					await TxValidation.controlAllWitnessesSignatures(task.tx, task.pubKeysByHashes);
				}
				
			} catch (/**@type {any}*/ error) {
				console.error(`[VALIDATION_WORKER ${task.id}] signatureValidation error: ${error.message}`);
				abortOperationRequested = false;
				response.error = error.message;
			}
			break;
		case 'abortOperation':
			abortOperationRequested = true;
			return;
		case 'terminate':
            //console.log(`[VALIDATION_WORKER ${workerId}] Terminating...`);
			abortOperationRequested = true;
			parentPort.close();
			return;
        default:
			response.error = 'Invalid task type';
            break;
    }

	parentPort.postMessage(response);
});