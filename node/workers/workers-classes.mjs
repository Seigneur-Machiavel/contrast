if (false) { const { BrowserWindow } = require('electron'); } // For definition
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

/**
 * @typedef {import("../src/block-classes.mjs").BlockData} BlockData
 */

//const WorkerModule = isNode ? (await import('worker_threads')).Worker : Worker;
let WorkerModule;
try { WorkerModule = (await import('worker_threads')).Worker }
catch (error) { WorkerModule = Worker }

function newWorker(scriptPath, workerCode, workerData = {}) {
    if (scriptPath) return new WorkerModule(new URL(scriptPath, import.meta.url), { workerData });
    
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
}

// CLASSES SIMPLIFYING USAGE OF THE WORKERS
export class ValidationWorker {
    constructor (id = 0) {
        this.id = id;
        this.state = 'idle';

        /** @type {Worker} worker */
        this.worker = newWorker('./validation-worker-nodejs.mjs');
        this.worker.on('exit', (code) => { console.log(`ValidationWorker ${this.id} stopped with exit code ${code}`); });
        this.worker.on('close', () => { console.log(`ValidationWorker ${this.id} closed`); });
    }
    addressOwnershipConfirmation(involvedUTXOs, transactions, impliedKnownPubkeysAddresses, useDevArgon2) {
        /** @type {Promise<{ discoveredPubKeysAddresses: {}, isValid: boolean }>} */
        const promise = new Promise((resolve, reject) => {
            this.worker.postMessage({
                id: this.id,
                type: 'addressOwnershipConfirmation',
                involvedUTXOs,
                transactions,
                impliedKnownPubkeysAddresses,
                useDevArgon2,
            });
            this.worker.on('message', (message) => {
                if (message.id !== this.id) { return; }
                if (message.error) { return reject({ isValid: message.isValid, error: message.error }); }
                    //reject(message.error); }

                const result = {
                    discoveredPubKeysAddresses: message.discoveredPubKeysAddresses,
                    isValid: message.isValid
                };
                //console.info(`ValidationWorker ${this.id} addressOwnershipConfirmation result: ${JSON.stringify(result)}`);
                resolve(result);
            });
        });
        return promise;
    }
    terminateAsync() {
        setTimeout(() => { this.worker.postMessage({ type: 'terminate', id: this.id }); }, 1000);
        this.worker.removeAllListeners();
        return new Promise((resolve, reject) => {
            this.worker.on('exit', (code) => { console.log(`ValidationWorker stopped with exit code ${code}`); resolve(); });
            this.worker.on('close', () => { console.log('ValidationWorker closed'); resolve(); });

            setTimeout(() => {
                console.error('ValidationWorker termination timeout -> terminate from parent');
                this.worker.terminate();
                resolve();
            }, 10000);
        });
    }
}

export class MinerWorker {
    constructor (rewardAddress = '', bet = 0, timeOffset = 0) {
        this.terminate = false;
        this.rewardAddress = rewardAddress;
        this.bet = bet;
        this.timeOffset = timeOffset;
        /** @type {BlockData} */
        this.blockCandidate = null;
        
        /** @type {BlockData} */
        this.result = null;
        this.isWorking = false;
        this.paused = false;
        this.hashRate = 0;

        /** @type {Worker} worker */
        this.worker = newWorker('./miner-worker-nodejs.mjs');
        this.worker.on('close', () => { console.log('MinerWorker closed'); });
        this.worker.on('message', (message) => {
            if (message.paused === true || message.paused === false) {
                if (message.paused === true) this.paused = true;
                if (message.paused === false) this.paused = false;
                console.log('MinerWorker paused new state:', message.paused);
                return;
            }

            if (message.hashRate) { this.hashRate = message.hashRate; return; }
            if (message.result.error) console.error(message.result.error);
            if (!message.result.error) this.result = message.result;
            this.isWorking = false;
        });
    }
    /** @param {string} rewardAddress @param {number} bet @param {number} timeOffset */
    async updateInfo(rewardAddress, bet, timeOffset) {
        if (this.terminate) { return; }
        const isSame = this.rewardAddress === rewardAddress && this.bet === bet && this.timeOffset === timeOffset;
        if (isSame) { return; }

        this.rewardAddress = rewardAddress;
        this.bet = bet;
        this.timeOffset = timeOffset;
        this.worker.postMessage({ type: 'updateInfo', rewardAddress, bet, timeOffset });

        // await 200 ms to allow the worker to process the new info
        return new Promise(resolve => setTimeout(resolve, 200));
    }
    /** @param {BlockData} blockCandidate */
    async updateCandidate(blockCandidate) {
        if (this.terminate) { return; }
        if (this.#isSameBlockCandidate(blockCandidate)) { return; }

        this.blockCandidate = blockCandidate;
        this.worker.postMessage({ type: 'newCandidate', blockCandidate });

        // await 200 ms to allow the worker to process the new candidate
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    /** @param {BlockData} blockCandidate */
    #isSameBlockCandidate(blockCandidate) {
        if (this.blockCandidate === null) { return false; }

        const sameIndex = this.blockCandidate.index === blockCandidate.index;
        const samePrevHash = this.blockCandidate.prevHash === blockCandidate.prevHash;

        const currentCandidateValidatorAddress = this.blockCandidate.Txs[0].outputs[0].address;
        const newCandidateValidatorAddress = blockCandidate.Txs[0].outputs[0].address;
        const sameValidatorAddress = currentCandidateValidatorAddress === newCandidateValidatorAddress;

        return sameIndex && samePrevHash && sameValidatorAddress;
    }
    async mineUntilValid() {
        if (this.terminate) { return; }
        if (this.isWorking) { return; }
        this.isWorking = true;
        this.result = null;

        this.worker.postMessage({
            type: 'mineUntilValid',
            rewardAddress: this.rewardAddress,
            bet: this.bet,
            timeOffset: this.timeOffset
        });
    }
    getResultAndClear() {
        const finalizedBlock = this.result;
        this.result = null;
        return finalizedBlock;
    }
    pause() {
        this.worker.postMessage({ type: 'pause' });
    }
    resume() {
        this.worker.postMessage({ type: 'resume' });
    }
    terminateAsync() {
        this.terminate = true;
        //setTimeout(() => { this.worker.terminate() }, 1000);
        setTimeout(() => { this.worker.postMessage({ type: 'terminate' }); }, 1000);
        this.worker.removeAllListeners();
        return new Promise((resolve, reject) => {
            this.worker.on('exit', (code) => { console.log(`MinerWorker stopped with exit code ${code}`); resolve(); });
            this.worker.on('close', () => { console.log('MinerWorker closed'); resolve(); });
            setTimeout(() => {
                console.error('MinerWorker termination timeout -> terminate from parent');
                this.worker.terminate();
                resolve();
            }, 10000);
        });
    }
}

export class AccountDerivationWorker {
    constructor (id = 0) {
        this.id = id;
        this.state = 'idle';

        /** @type {Worker} worker */
        //this.worker = isNode ?
        //newWorker('./account-worker-nodejs.mjs') :
        //newWorker(undefined, accountWorkerCode || window?.accountWorkerCode);
        this.worker = typeof accountWorkerCode === 'undefined' ? newWorker('./account-worker-nodejs.mjs') : newWorker(undefined, accountWorkerCode);
    }
    async derivationUntilValidAccount(seedModifierStart, maxIterations, masterHex, desiredPrefix) {
        this.state = 'working';

        if (typeof accountWorkerCode === 'undefined') this.worker.removeAllListeners();
        else this.worker.onmessage = null;

        //this.promise = new Promise((resolve, reject) => {
        const promise = new Promise((resolve, reject) => {
            this.state = 'working';
            if (typeof accountWorkerCode === 'undefined') {
                this.worker.on('exit', (code) => { console.log(`DerivationWorker ${this.id} stopped with exit code ${code}`); });
                this.worker.on('close', () => { console.log('DerivationWorker ${this.id} closed'); });
                this.worker.on('message', (message) => {
                    if (message.id !== this.id) { return; }
                    if (message.error) { return reject({ isValid: message.isValid, error: message.error }); }

                    //response = { id, isValid: false, seedModifierHex: '', pubKeyHex: '', privKeyHex: '', addressBase58: '', error: false };
                    const result = {
                        id: message.id,
                        isValid: message.isValid,
                        seedModifierHex: message.seedModifierHex,
                        pubKeyHex: message.pubKeyHex,
                        privKeyHex: message.privKeyHex,
                        addressBase58: message.addressBase58,
                        iterations: message.iterations
                    };

                    resolve(result);
                });
            } else {
                this.worker.onmessage = (e) => {
                    const message = e.data;
                    if (message.error) { return reject({ isValid: message.isValid, error: message.error }); }

                    //response = { id, isValid: false, seedModifierHex: '', pubKeyHex: '', privKeyHex: '', addressBase58: '', error: false };
                    const result = {
                        id: message.id,
                        isValid: message.isValid,
                        seedModifierHex: message.seedModifierHex,
                        pubKeyHex: message.pubKeyHex,
                        privKeyHex: message.privKeyHex,
                        addressBase58: message.addressBase58,
                        iterations: message.iterations
                    };

                    resolve(result);
                };
            }

            this.worker.postMessage({
                id: this.id,
                type: 'derivationUntilValidAccount',
                seedModifierStart,
                maxIterations,
                masterHex,
                desiredPrefix
            });
        });
        const resolvedPromise = await promise;
        this.state = 'idle';
        //console.log(`DerivationWorker ${this.id} derivationUntilValidAccount result: ${JSON.stringify(resolvedPromise)}`);
        return resolvedPromise;
    }
    abortOperation() {
        if (this.state === 'idle') { return; }
        this.worker.postMessage({ type: 'abortOperation' });
    }
    terminateAsync() {
        //console.info(`DerivationWorker ${this.id} terminating...`);
        setTimeout(() => { this.worker.postMessage({ type: 'terminate', id: this.id }); }, 1000);
        return new Promise((resolve, reject) => {
            this.worker.on('message', (message) => {
                if (message.id !== this.id) { return; }
                if (message.error) { return reject(message.error); }
                resolve();
            });
            this.worker.on('exit', (code) => {
                console.log(`DerivationWorker ${this.id} stopped with exit code ${code}`);
                resolve();
            });
        });
    }
}

export class NodeAppWorker { // NODEJS ONLY ( no front usage available )
    app;
    /** @type {Worker} */
    worker = null;
    autoRestart = true;
    nodeStarted = false;
    /** @type {BrowserWindow} */
    mainWindow;
    forceRelay;
    #password;
    constructor (app = "dashboard", nodePort = 27260, dashboardPort = 27271, observerPort = 27270, mainWindow = null, forceRelay) {
        this.app = app;
        this.nodePort = nodePort;
        this.dashboardPort = dashboardPort;
        this.observerPort = observerPort;
        this.mainWindow = mainWindow;
        this.forceRelay = forceRelay;
        this.initWorker();
        this.autoRestartLoop();
    }
    async stop(awaitTermination = true) {
        this.autoRestart = false;
        this.worker.postMessage({ type: 'stop' });

        if (!awaitTermination) return true;

        while (true) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (this.worker.threadId === -1) break;
        }
        console.log('NodeAppWorker stopped');
        return true;
    }
    restart() {
        this.worker.postMessage({ type: 'stop' });
    }
    async setPasswordAndWaitResult(password = '') {
        const promise = new Promise((resolve, reject) => {
            this.worker.on('message', (message) => {
                if (message.type === 'set_new_password_result' && typeof message.data === 'boolean')
                    return resolve({channel: 'set-new-password-result', data: message.data});
                
                if (message.type === 'set_password_result' && typeof message.data === 'boolean')
                    return resolve({channel: 'set-password-result', data: message.data});
            
            }), setTimeout(() => { reject('Timeout'); }, 10000);
        });

        this.#password = password;
        this.worker.postMessage({ type: 'set_password_and_try_init_node', data: password });
        console.info('set_password msg sent to NodeAppWorker');

        return promise;
    }
    removePasswordAndWaitResult(password = '') {
        const promise = new Promise((resolve, reject) => {
            this.worker.on('message', (message) => {
                if (message.type === 'remove_password_result' && typeof message.data === 'boolean')
                    return resolve({channel: 'remove-password-result', data: message.data});
            }), setTimeout(() => { reject('Timeout'); }, 10000);
        });

        this.worker.postMessage({ type: 'remove_password', data: password });
        console.info('remove_password msg sent to NodeAppWorker');

        return promise;
    }
    generatePrivateKeyAndStartNode() {
        this.worker.postMessage({ type: 'generate_private_key_and_start_node' });
        console.info('msg sent to NodeAppWorker: set_private_key_and_start_node');
    }
    setPrivateKeyAndStartNode(privateKey = '') {
        this.worker.postMessage({ type: 'set_private_key_and_start_node', data: privateKey });
        console.info('msg sent to NodeAppWorker: set_private_key_and_start_node');
    }
    /** @param {string} password @returns {Promise<string | false>} */
    async extractPrivateKeyAndWaitResult(password = '') {
        const promise = new Promise((resolve, reject) => {
            this.worker.on('message', (message) => {
                if (message.type === 'private_key_extracted') return resolve(message.data);
            }), setTimeout(() => { reject('Timeout'); }, 10000);
        });

        this.worker.postMessage({ type: 'extract_private_key', data: password });
        console.info('msg sent to NodeAppWorker: extract_private_key');

        return promise;
    }
    async generateNewAddressAndWaitResult(prefix = 'W') {
        const promise = new Promise((resolve, reject) => {
            this.worker.on('message', (message) => {
                if (message.type === 'new_address_generated') return resolve(message.data);
            }), setTimeout(() => { reject('Timeout'); }, 120000);
        });

        this.worker.postMessage({ type: 'generate_new_address', data: prefix });
        console.info('msg sent to NodeAppWorker: generate_new_address');

        return promise;
    }
    async autoRestartLoop() {
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!this.autoRestart) { continue; }
            if (this.worker && this.worker.threadId !== -1) { continue; }

            console.log('-----------------------------------------------');
            console.log('NodeAppWorker autoRestartLoop => restarting...');
            console.log('-----------------------------------------------');

            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.initWorker();
            //this.worker.postMessage({ type: 'set_password_and_try_init_node', data: '' });
            await this.setPasswordAndWaitResult(this.#password);

            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    async cypherTextAndWaitResult(text = '') {
        const promise = new Promise((resolve, reject) => {
            this.worker.on('message', (message) => {
                if (message.type === 'cypher_text_result') return resolve(message.data);
            });
            setTimeout(() => { reject('Timeout'); }, 10000);
        });
        this.worker.postMessage({ type: 'cypher_text', data: text });
        console.info('msg sent to NodeAppWorker: cypher_text');
        return promise;
    }
    async decipherTextAndWaitResult(text = '') {
        const promise = new Promise((resolve, reject) => {
            this.worker.on('message', (message) => {
                if (message.type === 'decipher_text_result') return resolve(message.data);
            });
            setTimeout(() => { reject('Timeout'); }, 10000);
        });
        this.worker.postMessage({ type: 'decipher_text', data: text });
        console.info('msg sent to NodeAppWorker: decipher_text');
        return promise;
    }
    #avoidMainWindowMessage(message, typeStringCheck = true) {
        if (!this.mainWindow) return true;
        if (typeStringCheck && typeof message.data !== 'string') return true;
    }
    async initWorker() {
        const app = this.app;
        const nodePort = this.nodePort;
        const dashboardPort = this.dashboardPort;
        const observerPort = this.observerPort;
        const forceRelay = this.forceRelay;

        this.worker = null;
        this.worker = newWorker(`./${app}-worker.mjs`, '', { nodePort, dashboardPort, observerPort, forceRelay });

        await new Promise(resolve => setTimeout(resolve, 200));

        this.worker.on('exit', (code) => { console.log(`NodeAppWorker stopped with exit code ${code} -> should restart`); });
        this.worker.on('close', () => { console.log('NodeAppWorker closed'); });
        this.worker.on('message', (message) => {
            switch (message.type) {
                case 'set_new_password_result':
                    break; // Managed by setPasswordAndWaitResult()
                case 'set_password_result':
                    break; // Managed by setPasswordAndWaitResult()
                case 'stopped':
                    this.worker.terminate();
                    break;
                case 'message_to_mainWindow':
                    if (this.#avoidMainWindowMessage(message)) return;
                    this.mainWindow.webContents.send(message.data);
                    break;
                case 'node_starting':
                    if (this.mainWindow) this.mainWindow.webContents.send('node-starting');
                    break;
                case 'node_started':
                    this.nodeStarted = true;
                    if (this.#avoidMainWindowMessage(message)) return;
                    this.mainWindow.webContents.send('node-started', message.data);
                    break;
                case 'connexion_resume':
                    if (this.#avoidMainWindowMessage(message, false)) return;
                    this.mainWindow.webContents.send('connexion-resume', message.data);
                    break;
                case 'assistant_message':
                    if (this.#avoidMainWindowMessage(message)) return;
                    this.mainWindow.webContents.send('assistant-message', message.data);
                    break;
                case 'window_to_front':
                    if (this.#avoidMainWindowMessage(message)) return;
                    this.mainWindow.webContents.send('window-to-front', message.data);
                    break;
                case 'new_address_generated':
                    break; // Managed by generateNewAddressAndWaitResult()
                case 'private_key_extracted':
                    break; // Managed by extractPrivateKeyAndWaitResult()
                default:
                    console.log('Unknown NodeAppWorker message:', message);
                    break;
            }
        });

        console.log('NodeAppWorker started');
    }
}