import { parentPort } from 'worker_threads';
import { TxValidation } from '../src/tx-validation.mjs';
//import { ADDRESS } from '../../types/address.mjs';

// WORKER SIDE
let abortOperationRequested = false;
let workerId = undefined;
parentPort.on('message', async (task) => {
    const id = task.id;
    workerId = workerId || id;
	const response = { id, error: false };
    switch (task.type) {
		case 'derivationValidation':
			abortOperationRequested = false; // Reset for new task
			try {
				/** @type {Transaction[]} */
				const batch = task.batch;
				for (const tx of batch) {
					if (abortOperationRequested) return;
					// Validate all witnesses signatures
					TxValidation.controlAllWitnessesSignatures(tx);
				}
			} catch (/**@type {any}*/ error) {
				console.error(`[VALIDATION_WORKER ${task.id}] derivationValidation error: ${error.message}`);
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