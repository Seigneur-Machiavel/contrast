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
const cryptoLight = new CryptoLight();
cryptoLight.argon2Hash = argon2Hash;
const dashApp = new DashboardWsApp(undefined, cryptoLight, nodePort, dashboardPort, false);

monitorPerformance(); // Detect potential freeze
const stressTester = new StressTester(dashApp.node);
const fingerPrint = nodeMachineId.machineIdSync();
let passwordExist = Storage.isFileExist('passHash.bin');
let initializingNode = false;
let nodeInitialized = false;

// FUNCTIONS
async function initDashAppAndSaveSettings(privateKey = '') {
    while(initializingNode) { await new Promise(resolve => setTimeout(resolve, 100)); }
    if (nodeInitialized) return; // avoid double init

    initializingNode = true;
    parentPort.postMessage({ type: 'node_starting' });
    const initialized = await dashApp.init(privateKey, forceRelay);
    if (!initialized && dashApp.waitingForPrivKey) {
        parentPort.postMessage({ type: 'message_to_mainWindow', data: 'waiting-for-priv-key' });
        console.error(`Can't init dashApp, waitingForPrivKey!`);
    } else if (!initialized) { console.error(`Can't init dashApp, unknown reason!`) }

    initializingNode = false;
    nodeInitialized = initialized;
    if (!initialized) return;
    
    parentPort.postMessage({ type: 'node_started', data: dashApp.extractNodeSetting().privateKey });
    dashApp.saveNodeSettingBinary();
    parentPort.postMessage({ type: 'message_to_mainWindow', data: 'node-settings-saved' });
}
async function setPassword(password = 'toto') {
    const passwordStr = password === 'fingerPrint' ? fingerPrint.slice(0, 30) : password;
    const passHash = await cryptoLight.generateArgon2Hash(passwordStr, fingerPrint, 64, 'heavy', 16);
    if (!passHash) { console.error('Argon2 hash failed'); return false; }

    if (!passwordExist) {
        Storage.saveBinary('passHash', passHash.hashUint8);
        passwordExist = true;
        console.info('New password hash saved');
    } else {
        const loadedPassBytes = Storage.loadBinary('passHash');
        if (!loadedPassBytes) { console.error('Can\'t load existing password hash'); return false; }
        
        for (let i = 0; i < loadedPassBytes.length; i++) {
            if (passHash.hashUint8[i] === loadedPassBytes[i]) continue;
            console.error('Existing password hash not match');
            return false;
        }
        console.info('Existing password hash match');
    }

    if (cryptoLight.isReady()) return true;

    const concatenated = fingerPrint + passwordStr;
    const fingerPrintUint8 = new Uint8Array(Buffer.from(fingerPrint, 'hex'));
    cryptoLight.set_salt1_and_iv1_from_Uint8Array(fingerPrintUint8)
    await cryptoLight.generateKey(concatenated);
    console.info('cryptoLight Key Derived');
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
            const passwordCreation = !passwordExist;
            const setPasswordSuccess = await setPassword(message.data);
            parentPort.postMessage({ type: passwordCreation ? 'set_new_password_result' : 'set_password_result', data: setPasswordSuccess });
            if (!setPasswordSuccess) return;

            await initDashAppAndSaveSettings();
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
            const verified = await setPassword(message.data);
            if (!verified) { console.error('Password not match'); return; }

            parentPort.postMessage({ type: 'private_key_extracted', data: dashApp.extractNodeSetting().privateKey });
            break;
        case 'generate_new_address':
            const prefix = message.data;
            if (prefix !== 'W' && prefix !== 'C' && prefix !== 'P' && prefix !== 'U') { console.error('Invalid prefix'); return; }

            const newAddress = await dashApp.generateNewAddress(prefix);
            parentPort.postMessage({ type: 'new_address_generated', data: newAddress });
            break;
        case 'cypher_text':
            if (!cryptoLight.isReady()) return false;
            if (typeof message.data !== 'string') { console.error('Invalid data type'); return; }
            const cipherText = await cryptoLight.encryptText(message.data, undefined, true);
            if (!cipherText) { console.error('Cypher text failed'); return; }
            parentPort.postMessage({ type: 'cypher_text_result', data: cipherText });
            break;
        case 'decipher_text':
            if (!cryptoLight.isReady()) return false;
            if (typeof message.data !== 'string') { console.error('Invalid data type'); return; }
            const decipherText = await cryptoLight.decryptText(message.data, undefined);
            if (!decipherText) { console.error('Decipher text failed'); return; }
            parentPort.postMessage({ type: 'decipher_text_result', data: decipherText });
            break;
        case 'stress_test':
            
        default:
            console.error('Unknown message type:', message.type);
    }
});

// START
if (passwordExist) {
    const noPassRequired = await setPassword('fingerPrint');
    parentPort.postMessage({ type: 'message_to_mainWindow', data: noPassRequired ? 'no-password-required' : 'password-requested' });
} else parentPort.postMessage({ type: 'message_to_mainWindow', data: 'no-existing-password' });

connexionResumePostLoop();
stopIfDashAppStoppedLoop();

while(!dashApp.node) { await new Promise(resolve => setTimeout(resolve, 200)); }
const observApp = new ObserverWsApp(dashApp.node, observerPort);