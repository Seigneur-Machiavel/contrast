import { parentPort } from 'worker_threads';
import { TxValidation } from '../src/tx-validation.mjs';

// WORKER SIDE
let abortOperationRequested = false;
let workerId = undefined;
parentPort.on('message', async (task) => {
    const id = task.id;
    workerId = workerId || id;
	const response = { id, error: false };
    switch (task.type) {
		case 'linkValidation':
			abortOperationRequested = false; // Reset for new task
			try {
				/** @type {Array<{address: string, pubKey: string}>} */
				const batchOfLinks = task.batchOfLinks;
				for (const link of batchOfLinks) {
					if (abortOperationRequested) return;
					await TxValidation.controlAddressDerivation(link.address, link.pubKey);
				}
			} catch (/**@type {any}*/ error) {
				console.error(`[VALIDATION_WORKER ${task.id}] linkValidation error: ${error.message}`);
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