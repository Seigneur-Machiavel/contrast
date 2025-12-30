import { newWorker } from './unified-worker-initializer.mjs';
if (false) { const { BrowserWindow } = require('electron'); } // For definition

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
            
            }), setTimeout(() => reject('Timeout'), 10000);
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

        this.worker.on('exit', (code) => console.log(`NodeAppWorker stopped with exit code ${code} -> should restart`));
        this.worker.on('close', () => console.log('NodeAppWorker closed'));
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