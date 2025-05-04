process.on('uncaughtException', (error) => { console.error('Uncatched exception:', error.stack); });
process.on('unhandledRejection', (reason, promise) => { console.error('Promise rejected:', promise, 'reason:', reason); });

import { parentPort, workerData } from 'worker_threads';
import { DashboardWsApp, ObserverWsApp } from '../src/apps.mjs';
import { argon2Hash } from '../src/conCrypto.mjs';
import { CryptoLight } from '../../utils/cryptoLight.mjs';
import { Storage } from '../../utils/storage-manager.mjs';
import nodeMachineId from 'node-machine-id';
import { StressTester, monitorPerformance } from '../src/side-functions.mjs';

const nodePort = workerData.nodePort || 27260;
const dashboardPort = workerData.dashboardPort || 27271;
const observerPort = workerData.observerPort || 27270;
const forceRelay = workerData.forceRelay || false;
const cryptolights = {
    v0: new CryptoLight(argon2Hash), // old version for backward compatibility
    finger: new CryptoLight(argon2Hash), // fingerPrint based encryptiuon, software usage
    pass: new CryptoLight(argon2Hash) // password based encryption, user usage
}

monitorPerformance(); // Detect potential freeze

const dashApp = new DashboardWsApp(undefined, cryptolights.v0, nodePort, dashboardPort, false);
const stressTester = new StressTester(dashApp.node);
const fingerPrint = nodeMachineId.machineIdSync();
let passHashExist = Storage.isFileExist('passHash.bin');
let initializingNode = false;
let nodeInitialized = false;

const fingerPrintUint8 = new Uint8Array(Buffer.from(fingerPrint, 'hex'));
cryptolights.finger.set_salt1_and_iv1_from_Uint8Array(fingerPrintUint8);
await cryptolights.finger.generateKey(fingerPrint); // async ...
dashApp.cryptoFinger = cryptolights.finger; // upgrade v2

// FUNCTIONS
async function initDashAppAndSaveSettings(privateKey = '') {
    while(initializingNode) await new Promise(resolve => setTimeout(resolve, 100));
    if (nodeInitialized) return; // avoid double init

    initializingNode = true;
    parentPort.postMessage({ type: 'node_starting' });

    nodeInitialized = await dashApp.init(privateKey, forceRelay);
    if (!nodeInitialized && dashApp.waitingForPassword) {
        parentPort.postMessage({ type: 'message_to_mainWindow', data: 'password-requested' });
        console.error(`Can't init dashApp, waitingForPassword!`);
    } if (!nodeInitialized && dashApp.waitingForPrivKey) {
        parentPort.postMessage({ type: 'message_to_mainWindow', data: 'waiting-for-priv-key' });
        console.error(`Can't init dashApp, waitingForPrivKey!`);
    } else if (!nodeInitialized) console.error(`Can't init dashApp, unknown reason!`);

    initializingNode = false;
    if (!nodeInitialized) return;
    
    parentPort.postMessage({ type: 'node_started', data: dashApp.extractNodeSetting().privateKey });
    await dashApp.saveNodeSettingBinary('v0');
    await dashApp.saveNodeSettingBinary('finger');
    parentPort.postMessage({ type: 'message_to_mainWindow', data: 'node-settings-saved' });
}
function verifyPasshash(passHash) {
    if (!passHash) { console.error('passHash is undefined'); return false; }

    const loadedPassBytes = Storage.loadBinary('passHash');
    if (!loadedPassBytes) { console.error('Can\'t load existing password hash'); return false; }

    for (let i = 0; i < loadedPassBytes.length; i++) {
        if (passHash.hashUint8[i] === loadedPassBytes[i]) continue;
        console.error('Existing password hash not match');
        return false;
    }
    console.info('Existing password hash match');

    return true;
}
async function verifyPassword(password = 'toto') {
    if (!passHashExist) { console.error('No existing password hash'); return false; }
    if (!password) { console.error('Password is undefined'); return false; }
    if (typeof password !== 'string') { console.error('Password is not a string'); return false; }

    const passwordStr = password === 'fingerPrint' ? fingerPrint.slice(0, 30) : password;
    const passHash = await cryptolights.v0.generateArgon2Hash(passwordStr, fingerPrint, 64, 'heavy', 16);
    if (!passHash) { console.error('Argon2 hash failed'); return false; }

    return verifyPasshash(passHash);
}
async function setPassword(password = 'toto') {
    const passwordStr = password === 'fingerPrint' ? fingerPrint.slice(0, 30) : password;
    const passHash = await cryptolights.v0.generateArgon2Hash(passwordStr, fingerPrint, 64, 'heavy', 16);
    if (!passHash) { console.error('Argon2 hash failed'); return false; }

    if (passHashExist && !verifyPasshash(passHash)) return false; // Verify existing password hash
    else { // Save new password hash
        Storage.saveBinary('passHash', passHash.hashUint8);
        passHashExist = true;
        console.info('New password hash saved');
    }

    if (cryptolights.v0.isReady()) return true;

    const concatenated = fingerPrint + passwordStr;
    cryptolights.v0.set_salt1_and_iv1_from_Uint8Array(fingerPrintUint8);
    await cryptolights.v0.generateKey(concatenated);

    return true;
}
async function connexionResumePostLoop() {
    while(true) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!dashApp.node) continue;
        if (!dashApp.node.p2pNetwork) continue;

        const resume = dashApp.node.p2pNetwork.connexionResume;
        if (!resume) continue;

        parentPort.postMessage({ type: 'connexion_resume', data: resume });
    }
};
async function stopIfDashAppStoppedLoop() {
    while(dashApp.stopped === false) { await new Promise(resolve => setTimeout(resolve, 1000)); }
    await stop();
}
async function stop() {
    try {
        await dashApp.stop();
        observApp.stop();
        parentPort.postMessage({ type: 'stopped' });
        parentPort.close();
        console.log('Dashboard worker stopped.');
    } catch (error) { console.error('Dashboard worker stop error:', error); }
}

// MESSAGE HANDLING
parentPort.on('message', async (message) => {
    switch(message.type) {
        case 'stop':
            await stop();
            break;
        
        case 'set_password_and_try_init_node':
            if (typeof message.data !== 'string') { console.error('Invalid data type'); return; }
            const passwordCreation = !passHashExist;
            const setPasswordSuccess = await setPassword(message.data);
            parentPort.postMessage({ type: passwordCreation ? 'set_new_password_result' : 'set_password_result', data: setPasswordSuccess });
            if (!setPasswordSuccess) return;

            await initDashAppAndSaveSettings(); // try init node if not already initialized
            break;
        case 'remove_password':
            if (typeof message.data !== 'string') { console.error('Invalid data type'); return; }
            if (!verifyPassword(message.data))
                { parentPort.postMessage({ type: 'remove_password_result', data: false }); return }

            Storage.deleteFile('passHash.bin');
            cryptolights.pass = new CryptoLight(argon2Hash);
            passHashExist = false;
            //setPassword('fingerPrint'); // reset to fingerPrint
            parentPort.postMessage({ type: 'remove_password_result', data: true });
            break;
        case 'set_private_key_and_start_node':
            console.info('Setting private key');
            await initDashAppAndSaveSettings(message.data);
            break;
        case 'generate_private_key_and_start_node':
            console.info('Generating private key');
            const rndSeedHex = CryptoLight.generateRndHex(64);
            await initDashAppAndSaveSettings(rndSeedHex);
            break;
        case 'extract_private_key':
            console.info('Extracting private key');
            //const verified = await setPassword(message.data);
            //if (!verified) { console.error('Password not match'); return; }
            const verified = await verifyPassword(message.data);
            parentPort.postMessage({
                type: verified ? 'private_key_extracted' : 'assistant_message',
                data: verified ? dashApp.extractNodeSetting().privateKey : 'password-not-match'
            });
            break;
        case 'generate_new_address':
            const prefix = message.data;
            if (prefix !== 'W' && prefix !== 'C' && prefix !== 'P' && prefix !== 'U') { console.error('Invalid prefix'); return; }

            const newAddress = await dashApp.generateNewAddress(prefix);
            parentPort.postMessage({ type: 'new_address_generated', data: newAddress });
            break;
        case 'cypher_text':
            if (!cryptolights.v0.isReady()) return false;
            if (typeof message.data !== 'string') { console.error('Invalid data type'); return; }
            const cipherText = await cryptolights.v0.encryptText(message.data, undefined, true);
            if (!cipherText) { console.error('Cypher text failed'); return; }
            parentPort.postMessage({ type: 'cypher_text_result', data: cipherText });
            break;
        case 'decipher_text':
            if (!cryptolights.v0.isReady()) return false;
            if (typeof message.data !== 'string') { console.error('Invalid data type'); return; }
            const decipherText = await cryptolights.v0.decryptText(message.data, undefined);
            if (!decipherText) { console.error('Decipher text failed'); return; }
            parentPort.postMessage({ type: 'decipher_text_result', data: decipherText });
            break;
        case 'stress_test':
            console.info('Stress test fnc not enabled yet');
            break;
        default:
            console.error('Unknown message type:', message.type);
    }
});

// START
if (passHashExist) {
    await initDashAppAndSaveSettings();
    
    //const noPassRequired = await setPassword('fingerPrint');
    //parentPort.postMessage({ type: 'message_to_mainWindow', data: noPassRequired ? 'no-password-required' : 'password-requested' });
} else parentPort.postMessage({ type: 'message_to_mainWindow', data: 'no-existing-password' });

connexionResumePostLoop();
stopIfDashAppStoppedLoop();

while(!dashApp.node) { await new Promise(resolve => setTimeout(resolve, 200)); }
const observApp = new ObserverWsApp(dashApp.node, observerPort);