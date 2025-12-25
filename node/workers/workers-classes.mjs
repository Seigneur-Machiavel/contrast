if (false) { const { BrowserWindow } = require('electron'); } // For definition
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

/**
 * @typedef {import("../../types/transaction.mjs").UTXO} UTXO
 * @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 */

//const WorkerModule = isNode ? (await import('worker_threads')).Worker : Worker;
let WorkerModule;
try { WorkerModule = (await import('worker_threads')).Worker }
catch (/**@type {any}*/ error) { WorkerModule = Worker }

function newWorker(scriptPath, workerCode, workerData = {}) { // UNIFIED FOR BROWSER & NODEJS
    const worker = scriptPath 
        ? new WorkerModule(new URL(scriptPath, import.meta.url), { workerData })
        : new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));
    
    // Add addEventListener/removeEventListener to Node.js workers
    if (worker.on && !worker.addEventListener) {
        worker.addEventListener = (event, handler) => {
            const wrappedHandler = (data) => handler({ data }); // Wrap Node.js data in event object
            worker.on(event, wrappedHandler);
            // Store mapping for removeEventListener
            if (!worker._handlerMap) worker._handlerMap = new Map();
            worker._handlerMap.set(handler, wrappedHandler);
        };
        
        worker.removeEventListener = (event, handler) => {
            const wrappedHandler = worker._handlerMap?.get(handler);
            if (wrappedHandler) {
                worker.off(event, wrappedHandler);
                worker._handlerMap.delete(handler);
            }
        };
    }
    
    return worker;
}

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

export class MinerWorker {
	/** @type {BlockCandidate} */	blockCandidate = null;
	/** @type {BlockFinalized} */	result = null;

	terminate = false;
	isWorking = false;
	paused = false;
	hashRate = 0;

	constructor(rewardAddress = '', bet = 0, timeOffset = 0) {
		this.rewardAddress = rewardAddress;
		this.bet = bet;
		this.timeOffset = timeOffset;
		this.worker = newWorker('./miner-worker-nodejs.mjs');
		this.worker.addEventListener('message', this.#onMessage);
	}

	#onMessage = (event) => {
		const message = event.data || event;
		if (message.paused === true || message.paused === false) {
			this.paused = message.paused;
			console.log('MinerWorker paused new state:', message.paused);
			return;
		}
		if (message.hashRate) { this.hashRate = message.hashRate; return; }
		if (message.result?.error) console.error(message.result.error);
		if (message.result && !message.result.error) this.result = message.result;
		this.isWorking = false;
	}
	/** @param {BlockCandidate} block */
	#isSameBlockCandidate(block) {
		if (this.blockCandidate === null) return false;

		const sameIndex = this.blockCandidate.index === block.index;
		const samePrevHash = this.blockCandidate.prevHash === block.prevHash;
		const newCandidateValidatorAddress = block.Txs[0].outputs[0].address;
		const currentCandidateValidatorAddress = this.blockCandidate.Txs[0].outputs[0].address;
		const sameValidatorAddress = currentCandidateValidatorAddress === newCandidateValidatorAddress;
		return sameIndex && samePrevHash && sameValidatorAddress;
	}
	
	/** @param {string} rewardAddress @param {number} bet @param {number} timeOffset */
	updateInfo(rewardAddress, bet, timeOffset) {
		if (this.terminate) return;
		
		const isSame = this.rewardAddress === rewardAddress && this.bet === bet && this.timeOffset === timeOffset;
		if (isSame) return;

		this.rewardAddress = rewardAddress;
		this.bet = bet;
		this.timeOffset = timeOffset;
		this.worker.postMessage({ type: 'updateInfo', rewardAddress, bet, timeOffset });
	}
	/** @param {BlockCandidate} blockCandidate */
	async updateCandidate(blockCandidate) {
		if (this.terminate) return;
		if (this.#isSameBlockCandidate(blockCandidate)) return;

		this.blockCandidate = blockCandidate;
		this.worker.postMessage({ type: 'newCandidate', blockCandidate });

		await new Promise(resolve => setTimeout(resolve, 200));
	}
	mineUntilValid() {
		if (this.terminate) return;
		if (this.isWorking) return;
		
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
	pause() { this.worker.postMessage({ type: 'pause' }); }
	resume() { this.worker.postMessage({ type: 'resume' }); }
	terminateAsync() {
		this.terminate = true;

		// BROWSER SHUTDOWN
		if (typeof window !== 'undefined') {
			this.worker.removeEventListener('message', this.#onMessage);
			this.worker.terminate();
			return Promise.resolve();
		}

		// NODEJS GRACEFUL SHUTDOWN
		return new Promise((resolve) => {
			const forceTerminate = setTimeout(async () => {
				console.error('MinerWorker timeout -> forcing termination');
				await this.worker.terminate();
				resolve();
			}, 10000);

			this.worker.addEventListener('exit', () => {
				clearTimeout(forceTerminate);
				this.worker.removeEventListener('message', this.#onMessage);
				console.log('MinerWorker exited gracefully');
				resolve();
			});

			this.worker.postMessage({ type: 'terminate' });
		});
	}
}

/*export class AccountDerivationWorker { // DEPRECATED
	worker = typeof accountWorkerCode === 'undefined' 
		? newWorker('./account-worker-nodejs.mjs') 
		: newWorker(undefined, accountWorkerCode);
	state = 'idle';

	constructor(id = 0) { 
		this.id = id;
		this.worker.addEventListener('message', this.#onMessage);
	}

	#onMessage = (event) => {
		const message = event.data || event;
		if (message.id !== this.id) return;

		this.state = 'idle';
		if (message.error) {
			this.reject?.({ isValid: message.isValid, error: message.error });
			return;
		}

		this.resolve?.({
			id: message.id,
			isValid: message.isValid,
			seedModifierHex: message.seedModifierHex,
			pubKeyHex: message.pubKeyHex,
			privKeyHex: message.privKeyHex,
			addressBase58: message.addressBase58,
			iterations: message.iterations
		});
	}

	async derivationUntilValidAccount(seedModifierStart, maxIterations, masterHex, desiredPrefix) {
		this.state = 'working';

		const promise = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;

			this.worker.postMessage({
				id: this.id,
				type: 'derivationUntilValidAccount',
				seedModifierStart,
				maxIterations,
				masterHex,
				desiredPrefix
			});
		});

		return promise;
	}

	abortOperation() {
		if (this.state === 'idle') return;
		this.worker.postMessage({ type: 'abortOperation' });
	}

	terminateAsync() {
		// BROWSER SHUTDOWN
		if (typeof window !== 'undefined') {
			this.worker.removeEventListener('message', this.#onMessage);
			this.worker.terminate();
			return Promise.resolve();
		}

		// NODEJS GRACEFUL SHUTDOWN
		return new Promise((resolve) => {
			const forceTerminate = setTimeout(async () => {
				console.error('AccountDerivationWorker timeout -> forcing termination');
				await this.worker.terminate();
				resolve();
			}, 10000);

			this.worker.addEventListener('exit', () => {
				clearTimeout(forceTerminate);
				this.worker.removeEventListener('message', this.#onMessage);
				console.log(`DerivationWorker ${this.id} exited gracefully`);
				resolve();
			});

			this.worker.postMessage({ type: 'terminate', id: this.id });
		});
	}
}*/

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