import { parentPort } from 'worker_threads';
import { HashFunctions, AsymetricFunctions } from '../src/conCrypto.mjs';
import { addressUtils } from '../../utils/addressUtils.mjs';

process.on('uncaughtException', (/**@type {any}*/ error) => console.error('Uncatched exception:', error.stack));
process.on('unhandledRejection', (reason, promise) => console.error('Promise rejected:', promise, 'reason:', reason));

async function deriveKeyPair(masterHex, seedModifierHex) {
	const seedHex = await HashFunctions.SHA256(masterHex + seedModifierHex);
	const keyPair = AsymetricFunctions.generateKeyPairFromHash(seedHex);
	if (!keyPair) throw new Error('Failed to generate key pair');
	return keyPair;
}

async function deriveAccount(pubKeyHex, desiredPrefix = "C") {
	const addressBase58 = await addressUtils.deriveAddress(HashFunctions.Argon2, pubKeyHex);
	if (!addressBase58) throw new Error('Failed to derive address');
	if (addressBase58.substring(0, 1) !== desiredPrefix) throw new Error('Address prefix not matched');

	addressUtils.conformityCheck(addressBase58);
	await addressUtils.securityCheck(addressBase58, pubKeyHex);
	return addressBase58;
}

// WORKER SIDE
let workerId = undefined;
let isWorking = false;
let abortOperation = false;

parentPort.on('message', async (task) => {
	const id = task.id;
	workerId = workerId || id;
	let response = {};
	
	switch (task.type) {
		case 'derivationUntilValidAccount':
			abortOperation = false; // Reset for new task
			isWorking = true;
			response = { id, isValid: false, seedModifierHex: '', pubKeyHex: '', privKeyHex: '', addressBase58: '', iterations: 0, error: false };
			
			const { seedModifierStart, maxIterations, masterHex, desiredPrefix } = task;
			for (let i = 0; i < maxIterations; i++) {
				if (abortOperation) break;
				
				const seedModifier = seedModifierStart + i;
				const seedModifierHex = seedModifier.toString(16).padStart(12, '0');
				
				try {
					const keyPair = await deriveKeyPair(masterHex, seedModifierHex);
					const addressBase58 = await deriveAccount(keyPair.pubKeyHex, desiredPrefix);
					
					response.isValid = true;
					response.seedModifierHex = seedModifierHex;
					response.pubKeyHex = keyPair.pubKeyHex;
					response.privKeyHex = keyPair.privKeyHex;
					response.addressBase58 = addressBase58;
					break;
				} catch (/**@type {any}*/ error) {
					const errorSkippingLog = ['Address does not meet the security level', 'Address prefix not matched'];
					if (!errorSkippingLog.includes(error.message.slice(0, 40))) console.error(error.stack);
				}
				response.iterations++;
			}
			break;
		case 'abortOperation':
			if (!isWorking) return;
			abortOperation = true;
			return;
		case 'terminate':
			console.log(`Worker ${workerId} terminating...`);
			abortOperation = true;
			parentPort.close();
			return;
		default:
			response.error = 'Invalid task type';
			break;
	}

	isWorking = false;
	parentPort.postMessage(response);
});