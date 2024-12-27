import { parentPort } from 'worker_threads';
import { HashFunctions, AsymetricFunctions } from '../src/conCrypto.mjs';
import { addressUtils } from '../../utils/addressUtils.mjs';

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
            abortOperation = false;
            isWorking = true;
            response = { id, isValid: false, seedModifierHex: '', pubKeyHex: '', privKeyHex: '', addressBase58: '', iterations: 0, error: false };
            const seedModifierStart = task.seedModifierStart;
            const maxIterations = task.maxIterations;
            const masterHex = task.masterHex;
            const desiredPrefix = task.desiredPrefix;

            for (let i = 0; i < maxIterations; i++) {
                //await new Promise((resolve) => setTimeout(resolve, 1)); //?
                if (abortOperation) { abortOperation = false; break; }
                const seedModifier = seedModifierStart + i;
                const seedModifierHex = seedModifier.toString(16).padStart(12, '0'); // padStart(12, '0') => 48 bits (6 bytes), maxValue = 281 474 976 710 655
                
                try {
                    //const kpStart = performance.now();
                    const keyPair = await deriveKeyPair(masterHex, seedModifierHex);
                    //console.log(`[WALLET] keyPair derived in: ${(performance.now() - kpStart).toFixed(3)}ms`);
                    //const aStart = performance.now();
                    const addressBase58 = await deriveAccount(keyPair.pubKeyHex, desiredPrefix);
                    //console.log(`[WALLET] account derived in: ${(performance.now() - aStart).toFixed(3)}ms`);
                    if (addressBase58) {
                        response.isValid = true;
                        response.seedModifierHex = seedModifierHex
                        response.pubKeyHex = keyPair.pubKeyHex;
                        response.privKeyHex = keyPair.privKeyHex;
                        response.addressBase58 = addressBase58;
                        break;
                    }
                } catch (error) {
                    const errorSkippingLog = ['Address does not meet the security level'];
                    if (!errorSkippingLog.includes(error.message.slice(0, 40))) { console.error(error.stack); }
                }
                response.iterations += 1;
            }
            break;
        case 'abortOperation':
            if (!isWorking) { return; }
            abortOperation = true;
            return;
		case 'terminate':
            //console.log(`[VALIDATION_WORKER ${workerId}] Terminating...`);
			parentPort.close(); // close the worker
			return;
        default:
			response.error = 'Invalid task type';
            break;
    }

    isWorking = false;
	parentPort.postMessage(response);
});

async function deriveKeyPair(masterHex, seedModifierHex) {
    const seedHex = await HashFunctions.SHA256(masterHex + seedModifierHex);

    const keyPair = await AsymetricFunctions.generateKeyPairFromHash(seedHex);
    if (!keyPair) { throw new Error('Failed to generate key pair'); }

    return keyPair;
}
async function deriveAccount(pubKeyHex, desiredPrefix = "C") {
    const argon2Fnc = HashFunctions.Argon2;
    const addressBase58 = await addressUtils.deriveAddress(argon2Fnc, pubKeyHex);
    if (!addressBase58) { throw new Error('Failed to derive address'); }

    if (addressBase58.substring(0, 1) !== desiredPrefix) { return false; }

    addressUtils.conformityCheck(addressBase58);
    await addressUtils.securityCheck(addressBase58, pubKeyHex);

    return addressBase58;
}