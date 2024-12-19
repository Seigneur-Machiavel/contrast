
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import localStorage_v1 from '../storage/local-storage-management.mjs';
import contrast from '../src/contrast.mjs'; //? Not all libs needed
import { exec } from 'child_process';
import { CallBackManager } from '../src/websocketCallback.mjs';
import utils from '../src/utils.mjs';
/**
* @typedef {import("../src/wallet.mjs").Account} Account
* @typedef {import("../src/node-factory.mjs").NodeFactory} NodeFactory
* @typedef {import("../src/node.mjs").Node} Node
* @typedef {import("../src/block-classes.mjs").BlockData} BlockData
* @typedef {import("../src/block-classes.mjs").BlockUtils} BlockUtils
*/

const APPS_VARS = {
    __filename: fileURLToPath(import.meta.url),
    __dirname: path.dirname( fileURLToPath(import.meta.url) ),
    __parentDirname: path.dirname( path.dirname( fileURLToPath(import.meta.url) ) ),
    /*__httpsOptions: {
        cert: fs.readFileSync('/chemin/vers/votre/certificate.crt'),
        key: fs.readFileSync('/chemin/vers/votre/private.key')
    }*/
};

class AppStaticFncs {
    /** @param {Node} node */
    static async extractPrivateNodeInfo(node) {
        if (!node) { return { error: 'No active node' }; }

        const result = {
            roles: node.roles,
        };

        if (node.roles.includes('validator')) {
            const { balance, UTXOs, spendableBalance } = await node.getAddressUtxos(node.account.address);
            node.account.setBalanceAndUTXOs(balance, UTXOs, spendableBalance);
            result.nodeId = node.id;
            result.validatorAddress = node.account.address;
            result.validatorRewardAddress = node.validatorRewardAddress;
            result.validatorBalance = balance;
            result.validatorUTXOs = UTXOs;
            result.validatorSpendableBalance = spendableBalance;
            result.validatorStakes = node.vss.getAddressStakesInfo(node.account.address);
            result.validatorUtxos = node.account.UTXOs;
            result.currentHeight = node.blockchain.currentHeight;
        }

        if (node.roles.includes('miner')) {
            if (!node.miner) { return { error: 'No miner found' }; }
            const { balance, UTXOs, spendableBalance } = await node.getAddressUtxos(node.miner.address);
            result.nodeId = node.id;
            result.minerAddress = node.miner.address;
            result.minerBalance = balance;
            result.minerUTXOs = UTXOs;
            result.minerSpendableBalance = spendableBalance;
            result.highestBlockIndex = node.miner.highestBlockIndex;
            result.minerThreads = node.miner.nbOfWorkers;
            result.minerHashRate = node.miner.hashRate;
        }
        result.peersConnected = node.p2pNetwork?.getConnectedPeers().length ?? "Not Connected";

        const lastBlock = node.blockchain.lastBlock;
        const lastBlockIndex = lastBlock?.index ?? 0;
        const lastBlockTxInfo = lastBlock?.Txs.length ?? 0;
        const lastBlockValidator = lastBlock?.Txs[1]?.inputs[0]?.split(':')[0] ?? 'No Validator';
        const lastBlockMiner = lastBlock?.Txs[0]?.outputs[0]?.address ?? 'No Miner';

        const lastBlockInfo = `Block ${lastBlockIndex} - ${lastBlockTxInfo} txs - Validator ${lastBlockValidator} - Miner ${lastBlockMiner}`;
        
        result.lastBlockInfo = lastBlockInfo;
        result.txInMempool = node.memPool.getTxNumberInMempool().toString();
        result.averageBlockTime = node.blockchainStats?.averageBlockTime ? (node.blockchainStats.averageBlockTime / 1000).toFixed(2) : 'No Data';
        result.peerId = node.p2pNetwork?.p2pNode?.peerId ?? 'No Peer ID';
        result.peerIds = node.p2pNetwork?.getConnectedPeers() ?? 'No Peer IDs';
        result.repScores = node.p2pNetwork?.reputationManager?.getScores() ?? 'No Rep Scores';
        result.nodeState = node.blockchainStats.state ?? 'No State';
        result.peerHeights = node.syncHandler.getAllPeerHeights() ?? 'No Peer Height';
        result.listenAddress = node.p2pNetwork?.p2pNode?.getMultiaddrs() ?? 'No Listen Address';
        result.lastLegitimacy = node.blockchainStats?.lastLegitimacy ?? 'No Legitimacy';
        result.peers = node.p2pNetwork?.getPeers() ?? 'No Peers';
        result.ignoreIncomingBlocks = node.ignoreIncomingBlocks;
        result.disabledSync = node.syncHandler.syncDisabled;
        return result;
    }
    /** @param {Node} node */
    extractPublicNodeInfo(node) {
        const result = {
            roles: node.roles,
        };

        if (node.roles.includes('validator')) {
            result.validatorAddress = node.account.address;
            result.currentHeight = node.blockchain.currentHeight;
        }

        return result;
    }
}

export class DashboardWsApp {
    #nodesSettings = {};
    /** @param {NodeFactory} factory */
    constructor(factory, port = 27271, autoInit = true) {
        /** @type {NodeFactory} */
        this.factory = factory;
        /** @type {CallBackManager} */
        this.callBackManager = null;
        /** @type {express.Application} */
        this.app = null;
        this.port = port;
        /** @type {WebSocketServer} */
        this.wss =  null;

        this.readableNow = () => { return `${new Date().toLocaleTimeString()}:${new Date().getMilliseconds()}` };
        if (autoInit) this.init();
        this.#nodeRestartCheckLoop();
    }
    /** @type {Node} */
    get node() { return this.factory.getFirstNode(); }
    async init(privateKey) {
        if (this.app === null) {
            this.app = express();
            this.app.use(express.static(APPS_VARS.__parentDirname));
            this.app.use(express.json({ limit: '1mb' }));
            this.app.use(express.urlencoded({ extended: true }));
            this.app.get('/', (req, res) => { res.sendFile(APPS_VARS.__parentDirname + '/front/nodeDashboard.html'); });
            this.app.get('/log-config', (req, res) => {
                res.sendFile(APPS_VARS.__parentDirname + '/front/log-config.html');
            });
            this.app.get('/log-viewer', (req, res) => {
                res.sendFile(APPS_VARS.__parentDirname + '/front/log-viewer.html');
            });

            // Add the API endpoints
            this.app.get('/api/log-config', (req, res) => {
                try {
                    const logConfig = localStorage_v1.loadJSON('logConfig') || {};
                    res.json(logConfig);
                } catch (error) {
                    console.error('Error loading log config:', error);
                    res.status(500).json({ error: 'Failed to load log configuration' });
                }
            });

            this.app.post('/api/log-config', (req, res) => {
                try {
                    console.log('Received POST request to /api/log-config');
                    const newConfig = req.body;
                    console.log('Received config:', newConfig);
                    
                    if (!newConfig || typeof newConfig !== 'object') {
                        console.log('Invalid config format received:', newConfig);
                        return res.status(400).json({ error: 'Invalid configuration format' });
                    }
            
                    console.log('About to save config to localStorage');
                    const saved = localStorage_v1.saveJSON('logConfig', newConfig); // Note: case sensitive!
                    console.log('Save result:', saved);
                    
                    // Verify the save worked by trying to read it back
                    const verification = localStorage_v1.loadJSON('logConfig');
                    console.log('Verification read:', verification);
            
                    res.json({ success: true, message: 'Configuration saved successfully' });
                } catch (error) {
                    console.error('Detailed error saving log config:', error);
                    res.status(500).json({ 
                        error: 'Failed to save log configuration',
                        details: error.message 
                    });
                }
            });
            //const server = this.app.listen(this.port,'127.0.0.1', () => { console.log(`Server running on http://${'???'}:${this.port}`); });
            const server = this.app.listen(this.port, () => { console.log(`Server running on http://${'???'}:${this.port}`); });
            this.wss = new WebSocketServer({ server });
        }
        
        this.wss.on('connection', this.#onConnection.bind(this));
        this.wss.on('close', () => { console.log('Server closed'); });
        
        this.#loadNodeSettings();
        const defaultNodeId = Object.keys(this.#nodesSettings)[0];
        const defaultSettings = this.#nodesSettings[defaultNodeId];
        const defaultPrivKey = defaultSettings ? defaultSettings.privateKey : null;
        const usablePrivKey = privateKey || defaultPrivKey;
        if (!this.node && usablePrivKey) {
            /** @type {Node} */
            await this.initMultiNode(usablePrivKey);
            //this.factory.nodes.set(multiNode.id, multiNode);
        }

        if (!this.node) { console.info("Not active Node and No private keys provided, can't auto init node..."); return; }
        
        const activeNodeAssociatedSettings = this.#nodesSettings[this.node.id];
        if (!activeNodeAssociatedSettings) { // Save the settings for the new node
            this.#nodesSettings[this.node.id] = {
                privateKey: usablePrivKey,
                validatorRewardAddress: this.node.validatorRewardAddress,
                minerAddress: this.node.minerAddress,
            };
        }

        this.#injectNodeSettings(this.node.account.address);
        this.#injectCallbacks();
    }
    async initMultiNode(nodePrivateKey = 'ff', local = false, useDevArgon2 = false) {
        const wallet = new contrast.Wallet(nodePrivateKey, useDevArgon2);
        const restored = await wallet.restore();
        if (!restored) { console.error('Failed to restore wallet.'); return; }
        wallet.loadAccounts();
        const { derivedAccounts, avgIterations } = await wallet.deriveAccounts(2, "C");
        if (!derivedAccounts) { console.error('Failed to derive addresses.'); return; }
        wallet.saveAccounts();

        const multiNode = await this.factory.createNode(
            derivedAccounts[0], // validator account
            ['validator', 'miner', 'observer'], // roles
            {listenAddress: local ? '/ip4/0.0.0.0/tcp/0' : '/ip4/0.0.0.0/tcp/27260'},
            derivedAccounts[1].address // miner address
        );
        multiNode.useDevArgon2 = useDevArgon2; // we remove that one ?
        await multiNode.start();
        multiNode.memPool.useDevArgon2 = useDevArgon2;

        console.log(`Multi node started, account : ${multiNode.account.address}`);
        return multiNode;
    }
    #onConnection(ws, req, localonly = false) {
        const clientIp = req.socket.remoteAddress === '::1' ? 'localhost' : req.socket.remoteAddress;

        // Allow only localhost connections
        if (localonly && (clientIp !== '127.0.0.1' && clientIp !== '::1')) {
            console.warn(`[DASHBOARD] Connection attempt from unauthorized IP: ${clientIp}`);
            ws.close(1008, 'Unauthorized'); // 1008: Policy Violation
            return;
        }

        console.log(`[DASHBOARD] ${this.readableNow()} Client connected: ${clientIp}`);
        ws.on('close', function close() { console.log('Connection closed'); });

        const messageHandler = (message) => { this.#onMessage(message, ws); };
        ws.on('message', messageHandler);

        if (!this.node) {
            console.info("Node active Node and No private keys provided, can't auto init node...");
            ws.send(JSON.stringify({ type: 'error', data: 'No active node' }));
        }
    }
    #injectNodeSettings(nodeId) {
        const node = this.factory.getNode(nodeId);
        if (!node) { console.error(`Node ${nodeId} not found`); return; }

        const associatedValidatorRewardAddress = this.#nodesSettings[nodeId].validatorRewardAddress;
        if (associatedValidatorRewardAddress) { 
            node.validatorRewardAddress = associatedValidatorRewardAddress;
        }
        
        const associatedMinerAddress = this.#nodesSettings[nodeId].minerAddress;
        if (associatedMinerAddress) { 
            node.minerAddress = associatedMinerAddress;
            node.miner.address = associatedMinerAddress;
        }

        const associatedMinerThreads = Number(this.#nodesSettings[nodeId].minerThreads);
        if (associatedMinerThreads && !isNaN(associatedMinerThreads)) {
            node.miner.nbOfWorkers = associatedMinerThreads;
        }
    }
    #injectCallbacks() {
        const callbacksModes = []; // we will add the modes related to the callbacks we want to init
        if (this.node.roles.includes('validator')) { callbacksModes.push('validatorDashboard'); }
        if (this.node.roles.includes('miner')) { callbacksModes.push('minerDashboard'); }
        this.callBackManager = new CallBackManager(this.node);
        this.callBackManager.initAllCallbacksOfMode(callbacksModes, this.wss.clients);
    }
    async #nodeRestartCheckLoop() {
        let restartCounter = 0;
        while (true) {
            if (this.factory.restartCounter > restartCounter) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                this.callBackManager = new CallBackManager(this.node);
                this.#injectCallbacks();

                await new Promise(resolve => setTimeout(resolve, 1000));
                console.info(`[DASHBOARD] Node restarted, counter: ${restartCounter}, closing connections`);
                this.#closeAllConnections();
                restartCounter = this.factory.restartCounter;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }   
    #closeAllConnections() {
        this.wss.clients.forEach((client) => {
            if (client.readyState === 1) {
                client.close(1001, 'Server is shutting down');
            }
        });
    }

    /** @param {Buffer} message @param {WebSocket} ws */
    async #onMessage(message, ws) {
        //console.log(`[onMessage] this.node.account.address: ${this.node.account.address}`);
        const messageAsString = message.toString();
        const parsedMessage = JSON.parse(messageAsString);
        const data = parsedMessage.data;
        //console.log(`[DASHBOARD] Received message: ${parsedMessage.type}`);
        switch (parsedMessage.type) {
            case 'ping':
                ws.send(JSON.stringify({ type: 'pong', data: Date.now() }));
                break;
            case 'set_private_key':
                await this.init(data);
                this.#nodesSettings[this.node.id].privateKey = data;
                this.#saveNodeSettings();
                break;
            case 'reset_wallet':    
                console.log('Resetting wallet');
                await this.#modifyAccountAndRestartNode(this.node.id, data);
                break;
            case 'update_git':
                this.#updateAndClose();
                break;
            case 'hard_reset':
                this.#hardResetAndClose();
                break;
            case 'set_validator_address':
                if (!this.node) { console.error('No active node'); break; }
                try {
                    contrast.utils.addressUtils.conformityCheck(data)
                    this.#nodesSettings[this.node.id].validatorRewardAddress = data;

                    this.#injectNodeSettings(this.node.id);
                    this.#saveNodeSettings();
                } catch (error) {
                    console.error(`Error setting validator address: ${data}, not conform`);
                }
                break;
            case 'set_miner_address':
                if (!this.node) { console.error('No active node'); break; }
                if (!this.node.miner) { console.error('No miner found'); break; }
                try {
                    contrast.utils.addressUtils.conformityCheck(data)
                    this.#nodesSettings[this.node.id].minerAddress = data;

                    this.#injectNodeSettings(this.node.id);
                    this.#saveNodeSettings();
                } catch (error) {
                    console.error(`Error setting miner address: ${data}, not conform`);
                }
                break;
            case 'force_restart':
                ws.send(JSON.stringify({ type: 'node_restarting', data }));
                console.info(`Forcing restart of node ${data}`);
                await this.factory.forceRestartNode(data);
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                ws.send(JSON.stringify({ type: 'node_restarted', data }));
                break;
            case 'force_restart_revalidate_blocks':
                ws.send(JSON.stringify({ type: 'node_restarting', data }));
                //this.wss.close(); // close the websocket server
                //this.app.delete('/'); // close the express server
                //await new Promise(resolve => setTimeout(resolve, 1000));

                console.info(`Forcing restart of node ${data} with revalidation of blocks`);
                await this.factory.forceRestartNode(data, true);
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                ws.send(JSON.stringify({ type: 'node_restarted', data }));
                break;
            case 'get_node_info':
                const nodeInfo = await AppStaticFncs.extractPrivateNodeInfo(this.node);
                ws.send(JSON.stringify({ type: 'node_info', data: nodeInfo }));
                break;
            case 'set_miner_threads':
                console.log(`Setting miner threads to ${data}`);
                if (!this.node) { console.error('No active node'); break; }
                this.node.miner.nbOfWorkers = data;

                this.#nodesSettings[this.node.id].minerThreads = data;
                this.#saveNodeSettings();
                break;
            case 'new_unsigned_transaction':
                console.log(`signing transaction ${data.id}`);
                const tx = await this.node.account.signTransaction(data);
                console.log('Broadcast transaction', data);
                const { broadcasted, pushedInLocalMempool, error } = this.node.pushTransaction(tx);

                if (error) { console.error('Error broadcasting transaction', error); return; }

                ws.send(JSON.stringify({ type: 'transaction_broadcasted', data: { broadcasted, pushedInLocalMempool } }));
                console.log('Transaction sent');
                break;
            case 'disconnect_peer':
                console.log(`Disconnecting peer ${data}`);
                this.node.p2pNetwork.closeConnection(data);
                break;
            case 'ask_sync_peer':
                console.log(`Asking peer ${data} to sync`);
                this.node.syncHandler.syncWithPeers(data);
                break;
            case 'ban_peer':
                console.log(`Banning peer ${data}`);
                this.node.p2pNetwork.reputationManager.banIdentifier(data);
                break;
            case 'ignore_incoming_blocks':
                console.log(`Ignore incoming blocks: ${data}`);
                this.node.ignoreIncomingBlocks = data;
                break;
            case 'disable_sync':
                console.log(`Disable sync: ${data}`);
                this.node.syncHandler.syncDisabled = data;
                break;
            default:
                ws.send(JSON.stringify({ type: 'error', data: 'unknown message type' }));
                break;
        }
    }
    #saveNodeSettings() {
        localStorage_v1.saveJSON('nodeSettings', this.#nodesSettings);
        console.log(`Nodes settings saved: ${Object.keys(this.#nodesSettings).length}`);
    }
    #loadNodeSettings() {
        const nodeSettings = localStorage_v1.loadJSON('nodeSettings');
        if (!nodeSettings || Object.keys(nodeSettings).length === 0) {
            console.log(`No nodes settings found`);
            return;
        }
        
        this.#nodesSettings = nodeSettings;
        console.log(`nodeSettings loaded: ${Object.keys(this.#nodesSettings).length}`);
    }
    #hardResetAndClose() {
        exec('git reset --hard HEAD', (error, stdout, stderr) => {
            if (error) {
                console.error(`Git reset error: ${error.message}`);
                console.error(`stderr: ${stderr}`);
                res.status(500).send('Git reset failed');
                return;
            }
            console.log(`Git reset output: ${stdout}`);

            console.log('Exiting process to allow PM2 to restart the application');
            process.exit(0);
        });
    }
    #updateAndClose() {
        exec('git pull', (error, stdout, stderr) => {
            if (error) {
                console.error(`Git pull error: ${error.message}`);
                console.error(`stderr: ${stderr}`);
                res.status(500).send('Git pull failed');
                return;
            }
            console.log(`Git pull output: ${stdout}`);

            console.log('Exiting process to allow PM2 to restart the application');
            process.exit(0);
        });
    }
    async #modifyAccountAndRestartNode(nodeId, newPrivateKey) {
        console.log('Modifying account and restarting node id:', nodeId);
        const wallet = new contrast.Wallet(newPrivateKey, false);
        const restored = await wallet.restore();
        if (!restored) { console.error('Failed to restore wallet.'); return; }
        wallet.loadAccounts();
        const { derivedAccounts, avgIterations } = await wallet.deriveAccounts(2, "C");
        if (!derivedAccounts) { console.error('Failed to derive addresses.'); return; }
        wallet.saveAccounts();

        await this.factory.forceRestartNode(nodeId, true, derivedAccounts[0], derivedAccounts[1].address);
    }
}

export class ObserverWsApp {
    /** @param {NodeFactory} factory */
    constructor(factory, port = 27270) {
        /** @type {NodeFactory} */
        this.factory = factory;
        /** @type {CallBackManager} */
        this.callBackManager = null;
        /** @type {express.Application} */
        this.app = express();
        this.port = port;
        /** @type {WebSocketServer} */
        this.wss =  null;
        this.wssClientsIPs = {};
        this.maxConnectionsPerIP = 3;

        this.readableNow = () => { return `${new Date().toLocaleTimeString()}:${new Date().getMilliseconds()}` };
        this.init();
        this.#nodeRestartCheckLoop();
    }
    /** @type {Node} */
    get node() { return this.factory.getFirstNode(); }
    async init() {
        while (!this.node) { 
            console.log('[OBSERVER] Waiting for node to be initialized...'); 
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!this.node.roles.includes('validator')) { throw new Error('ObserverWsApp must be used with a validator node'); }
        if (!this.node.roles.includes('observer')) { throw new Error('ObserverWsApp must be used with an observer node'); }

        this.app.use(express.static(APPS_VARS.__parentDirname));
        
        this.app.get('/', (req, res) => { res.sendFile(APPS_VARS.__parentDirname + '/front/explorer.html'); });
        const server = this.app.listen(this.port, () => { console.log(`Server running on http://${'???'}:${this.port}`); });
        
        this.wss = new WebSocketServer({ server });
        this.wss.on('connection', this.#onConnection.bind(this));
        
        this.callBackManager = new CallBackManager(this.node);
        this.callBackManager.initAllCallbacksOfMode('observer', this.wss.clients);
    }
    /** @param {WebSocket} ws @param {http.IncomingMessage} req */
    async #onConnection(ws, req) {
        const clientIp = req.socket.remoteAddress === '::1' ? 'localhost' : req.socket.remoteAddress;
        if (this.wssClientsIPs[clientIp] && this.wssClientsIPs[clientIp] >= this.maxConnectionsPerIP) {
            console.log(`[OBSERVER] ${this.readableNow()} Client already connected: ${clientIp}`);
            ws.close(undefined, 'Max connections per IP reached');
            this.wssClientsIPs[clientIp] -= 1;
            return;
        }

        if (!this.wssClientsIPs[clientIp]) { this.wssClientsIPs[clientIp] = 0; }
        this.wssClientsIPs[clientIp] += 1;
        console.log(`[OBSERVER] ${this.readableNow()} Client connected: ${clientIp} (${this.wssClientsIPs[clientIp]} connections)`);

        ws.on('close', () => {
            console.log(`[OBSERVER] Connection closed by client: ${clientIp}`);
            if (!this.wssClientsIPs[clientIp]) { return; }
            this.wssClientsIPs[clientIp] -= 1;
        });
        //ws.on('ping', function incoming(data) { console.log('received: %s', data); });

        this.#initConnectionMessage(ws);
        
        const messageHandler = (message) => { this.#onMessage(message, ws); };
        ws.on('message', messageHandler);
    }
    async #initConnectionMessage(ws) {
        const nbOfBlocks = 5 - 1; // 5 last blocks
        const toHeight = this.node.blockchain.currentHeight - 1 < 0 ? 0 : this.node.blockchain.currentHeight;
        const startHeight = toHeight - nbOfBlocks < 0 ? 0 : toHeight - nbOfBlocks;
        const last5BlocksInfo = this.node.blockchain.lastBlock ? await this.node.getBlocksInfo(startHeight, toHeight) : [];
        ws.send(JSON.stringify({ type: 'last_confirmed_blocks', data: last5BlocksInfo }));

        const time = this.node.timeSynchronizer.getCurrentTime();
        ws.send(JSON.stringify({ type: 'current_time', data: time }));
    }
    async #nodeRestartCheckLoop() {
        let restartCounter = 0;
        while (true) {
            if (this.factory.restartCounter > restartCounter) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                this.callBackManager = new CallBackManager(this.node);
                this.callBackManager.initAllCallbacksOfMode('observer', this.wss.clients);

                await new Promise(resolve => setTimeout(resolve, 1000));
                console.info(`[DASHBOARD] Node restarted, counter: ${restartCounter}, closing connections`);
                this.#closeAllConnections();
                restartCounter = this.factory.restartCounter;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }   
    #closeAllConnections() {
        this.wss.clients.forEach((client) => {
            if (client.readyState === 1) {
                client.close(1001, 'Server is shutting down');
            }
        });
    }
    /** @param {Buffer} message @param {WebSocket} ws */
    async #onMessage(message, ws) {
        try {
            //console.log(`[onMessage] this.node.account.address: ${this.node.account.address}`);
            const messageAsString = message.toString();
            const parsedMessage = JSON.parse(messageAsString);
            const data = parsedMessage.data;
            let exhaustiveBlockData;
            switch (parsedMessage.type) {
                case 'get_current_time':
                    ws.send(JSON.stringify({ type: 'current_time', data: this.node.timeSynchronizer.getCurrentTime() }));
                    break;
                case 'get_height':
                    ws.send(JSON.stringify({ type: 'current_height', data: this.node.blockchain.currentHeight }));
                    break;
                case 'get_node_info':
                    ws.send(JSON.stringify({ type: 'node_info', data: AppStaticFncs.extractNodeInfo(this.node) }));
                    break;
                case 'reconnect':
                    this.#initConnectionMessage(ws);
                    break;
                case 'get_blocks_data_by_height':
                    // can accept a single "height" number or "fromHeight toHeight" format
                    exhaustiveBlockData = await this.node.getExhaustiveBlocksDataByHeight(data.fromHeight | data, data.toHeight);
                    ws.send(JSON.stringify({ type: 'blocks_data_requested', data: exhaustiveBlockData }));
                    break;
                case 'get_blocks_data_by_hash':
                    exhaustiveBlockData = await this.node.getExhaustiveBlockDataByHash(data);
                    ws.send(JSON.stringify({ type: 'blocks_data_requested', data: exhaustiveBlockData }));
                    break;
                case 'get_address_utxos':
                    const UTXOs = await this.node.getAddressUtxos(data);
                    ws.send(JSON.stringify({ type: 'address_utxos_requested', data: { address: data, UTXOs } }));
                    break;
                case 'get_address_transactions_references':
                    if (data === undefined) { console.error('data undefined'); return; }
                    const gatrParams = {
                        address: typeof data === 'string' ? data : data.address,
                        from: typeof data === 'string' ? 0 : data.from,
                        to: typeof data === 'string' ? this.node.blockchain.currentHeight : data.to,
                    }

                    const addTxsRefs = await this.node.blockchain.getTxsReferencesOfAddress(this.node.memPool, gatrParams.address, gatrParams.from, gatrParams.to);
                    ws.send(JSON.stringify({ type: 'address_transactionsRefs_requested', data: addTxsRefs }));
                    break;
                case 'get_address_exhaustive_data':
                    if (data === undefined) { console.error('data undefined'); return; }
                    const gaedParams = {
                        address: typeof data === 'string' ? data : data.address,
                        //from: typeof data === 'object' ? data.from : Math.max(this.node.blockchain.currentHeight - 90, 0),
                        from: typeof data === 'object' ? data.from : 0,
                        to: typeof data === 'object' ? data.to || this.node.blockchain.currentHeight : this.node.blockchain.currentHeight,
                    }
                    //if (!gaedParams.from || gaedParams.from > gaedParams.to) { gaedParams.from = Math.max(gaedParams.to - 90, 0); }

                    const { addressUTXOs, addressTxsReferences } = await this.node.getAddressExhaustiveData(gaedParams.address, gaedParams.from, gaedParams.to);
                    ws.send(JSON.stringify({ type: 'address_exhaustive_data_requested', data: { address: gaedParams.address, addressUTXOs, addressTxsReferences } }));
                    break;
                case 'address_utxos':
                    ws.send(JSON.stringify({ type: 'address_utxos_requested', data: { address: data, UTXOs: await this.node.getAddressUtxos(data) } }));
                case 'get_transaction_by_reference': // DEPRECATED
                    console.log('get_transaction_by_reference: DISABLED');
                    break;
                    const resTx = await this.node.getTransactionByReference(data);
                    if (!res) { console.error(`[OBSERVER] Transaction not found: ${data}`); return; }
                    ws.send(JSON.stringify({ type: 'transaction_requested', data: res.transaction }));
                    break;
                case 'get_transaction_with_balanceChange_by_reference':
                    //const result = { transaction, balanceChange, inAmount, outAmount, fee };
                    const { transaction, balanceChange, inAmount, outAmount, fee } = await this.node.getTransactionByReference(data.txReference, data.address);
                    if (!transaction) { console.error(`[OBSERVER] Transaction not found: ${data.txReference}`); return; }
                    ws.send(JSON.stringify({ type: 'transaction_requested', data: { transaction, balanceChange, inAmount, outAmount, fee, txReference: data.txReference } }));
                    break;
                case 'get_best_block_candidate':
                    while(!this.node.miner.bestCandidate) { await new Promise(resolve => setTimeout(resolve, 1000)); }
                    ws.send(JSON.stringify({ type: 'best_block_candidate_requested', data: this.node.miner.bestCandidate }));
                    break;
                case 'subscribe_balance_update':
                    this.callBackManager.attachWsCallBackToModule('utxoCache', `onBalanceUpdated:${data}`, [ws]);
                    ws.send(JSON.stringify({ type: 'subscribed_balance_update', data }));
                    break;
                case 'subscribe_best_block_candidate_change':
                    this.callBackManager.attachWsCallBackToModule('miner', 'onBestBlockCandidateChange', [ws]);
                    ws.send(JSON.stringify({ type: 'subscribed_best_block_candidate_change' }));
                    break;
                case 'broadcast_transaction':
                    //const deserializeTx = contrast.utils.serializerFast.deserialize.transaction(data);
                    const { broadcasted, pushedInLocalMempool, error } = await this.node.pushTransaction(data.transaction);
                    if (error) { console.error('Error broadcasting transaction', error); }

                    ws.send(JSON.stringify({ type: 'transaction_broadcast_result', data: { transaction: data.transaction, txId: data.transaction.id, consumedAnchors: data.transaction.inputs, senderAddress: data.senderAddress, error, success: broadcasted } }));
                    break;
                case 'broadcast_finalized_block':
                    console.log(`--- Broadcasting finalized block #${data.index} from observer ---`);
                    if (this.node.blockCandidate.index !== data.index) {
                        console.error(`[OBSERVER] Block index mismatch: ${this.node.blockCandidate.index} !== ${data.index}`);
                        return;
                    }
                    if (this.node.blockCandidate.prevHash !== data.prevHash) {
                        console.error(`[OBSERVER] Block prevHash mismatch: ${this.node.blockCandidate.prevHash} !== ${data.prevHash}`);
                        return;
                    }

                    await this.node.p2pBroadcast('new_block_finalized', data);
                    this.node.opStack.push('digestPowProposal', data);
                    break;
                default:
                    ws.send(JSON.stringify({ type: 'error', data: `unknown message type: ${parsedMessage.type}` }));
                    break;
            }
        } catch (error) {
            console.error(`[OBSERVER] Error on message: ${error.message}`);
        }
    }
}