if (false) { const { CryptoLight } = require('../../utils/cryptoLight.mjs'); }

import { MiniLogger } from '../../miniLogger/mini-logger.mjs';
import cors from 'cors';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Storage } from '../../utils/storage-manager.mjs';
import { addressUtils } from '../../utils/addressUtils.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { Wallet } from './wallet.mjs';
import { Node } from './node.mjs';
import { CallBackManager } from './websocketCallback.mjs';
import { EasyUpnp } from '../../utils/easy-upnp.mjs';
import { BLOCKCHAIN_SETTINGS, MINING_PARAMS } from '../../utils/blockchain-settings.mjs';
import { mining } from '../../utils/mining-functions.mjs';
import { convert } from '../../utils/converters.mjs';

/**
* @typedef {import("./wallet.mjs").Account} Account
* @typedef {import("./block-classes.mjs").BlockData} BlockData
* @typedef {import("./block-classes.mjs").BlockUtils} BlockUtils
*/

/**
 * @typedef { Object } NodeSetting
 * @property { string } privateKey
 * @property { string } validatorRewardAddress
 * @property { string } minerAddress
 * @property { number } minerThreads
 */

const APPS_VARS = {
    __filename: fileURLToPath(import.meta.url),
    __dirname: path.dirname( fileURLToPath(import.meta.url) ),
    __nodeDir: path.dirname( path.dirname( fileURLToPath(import.meta.url) ) ),
    __contrastDir: path.dirname( path.dirname( path.dirname( fileURLToPath(import.meta.url) ) ) )
};

/*const APPS_VARS = { __filename: '', __dirname: '', __nodeDir: '', __contrastDir: '' };
APPS_VARS.__filename = fileURLToPath(import.meta.url).replace('app.asar', 'app.asar.unpacked');
APPS_VARS.__dirname = path.dirname(APPS_VARS.__filename);
APPS_VARS.__nodeDir = path.dirname(APPS_VARS.__dirname);
APPS_VARS.__contrastDir = path.dirname(APPS_VARS.__nodeDir);
console.log(APPS_VARS);*/

class AppStaticFncs {
    /** @param {Node} node */
    static estimateDailyMiningReward(coinBase = 10, globalHashrate = 1, myHashrate = 1) {
        if (typeof globalHashrate !== 'number' || typeof myHashrate !== 'number') return 0;
        if (globalHashrate <= 0 || myHashrate <= 0) return 0;
        if (globalHashrate === 1) return 0; // no mining possible
        if (myHashrate > globalHashrate) return 0; // no mining possible

        // half coinbase for the miner (other half for the validator)
        const totalMiningDailyReward = (coinBase / 2) * MINING_PARAMS.blocksPerDay; // 720 blocks per day at 120s per block
        const myHashratePercentage = myHashrate / globalHashrate;
        const estReward = Math.round(totalMiningDailyReward * myHashratePercentage); // in micro-Contrast

        const estRewardStr = convert.formatNumberAsCurrency(estReward);
        //console.log(estRewardStr);
        return estRewardStr;
    }
    /** @param {Node} node */
    static extractPrivateNodeInfo(node) {
        if (!node) { return { error: 'No active node' }; }

        const result = { roles: node.roles };

        if (node.roles.includes('validator')) {
            const { balance, UTXOs, spendableBalance } = node.getAddressUtxos(node.account.address);
            node.account.setBalanceAndUTXOs(balance, UTXOs, spendableBalance);
            result.nodeId = node.id;
            result.validatorAddress = node.account.address;
            result.validatorRewardAddress = node.validatorRewardAddress;
            result.validatorBalance = balance;
            result.validatorUTXOs = UTXOs; //? Repeated ?
            result.validatorSpendableBalance = spendableBalance;
            result.validatorStakes = node.vss.getAddressStakesInfo(node.account.address);
            result.validatorUtxos = node.account.UTXOs; //? Repeated ?
            result.currentHeight = node.blockchain.currentHeight;
        }

        if (node.roles.includes('miner')) {
            if (!node.miner) { return { error: 'No miner found' }; }
            const { balance, UTXOs, spendableBalance } = node.getAddressUtxos(node.miner.address);
            result.nodeId = node.id;
            result.minerAddress = node.miner.address;
            result.minerBalance = balance;
            result.minerUTXOs = UTXOs;
            result.minerSpendableBalance = spendableBalance;
            result.bestCandidateIndex = node.miner.bestCandidateIndex();
            result.bestCandidateLegitimacy = node.miner.bestCandidateLegitimacy();
            result.minerHashRate = node.miner.hashRate;
            result.minerThreads = node.miner.nbOfWorkers;

            const { avgTG, avgDiff, avgDWL, avgFD } = node.blockchain.cache.getAverageBlocksDifficultyAndTimeGap();
            result.globalHashRate = mining.estimateGlobalHashrate(avgDWL, avgTG, BLOCKCHAIN_SETTINGS.targetBlockTime);
            result.coinBase = node.blockchain.lastBlock.coinBase;
            result.miningDailyReward = AppStaticFncs.estimateDailyMiningReward(result.coinBase, result.globalHashRate, result.minerHashRate);
        }
        result.peersConnected = node.p2pNetwork?.getConnectedPeers().length ?? "Not Connected";

        const lastBlock = node.blockchain.lastBlock;
        const lastBlockIndex = lastBlock?.index ?? 0;
        const lastBlockTxInfo = lastBlock?.Txs.length ?? 0;
        const lastBlockValidator = lastBlock?.Txs[1]?.inputs[0]?.split(':')[0] ?? 'No Validator';
        const lastBlockMiner = lastBlock?.Txs[0]?.outputs[0]?.address ?? 'No Miner';

        const lastBlockInfo = `Block ${lastBlockIndex} - ${lastBlockTxInfo} txs - Validator ${lastBlockValidator} - Miner ${lastBlockMiner}`;
        
        result.lastBlockInfo = lastBlockInfo;
        result.txInMempool = node.memPool.transactionQueue.size().toString();
        result.averageBlockTime = node.blockchainStats?.averageBlockTime ? (node.blockchainStats.averageBlockTime / 1000).toFixed(2) : 'No Data';
        result.peerId = node.p2pNetwork?.p2pNode?.peerId ?? 'No Peer ID';
        result.peerIds = node.p2pNetwork?.getConnectedPeers() ?? 'No Peer IDs';
        result.repScores = node.p2pNetwork?.reputationManager?.getScores() ?? 'No Rep Scores';
        result.nodeState = node.blockchainStats.state ?? 'No State';
        result.peerHeights = node.syncHandler?.peersHeights ?? 'No Peer Height';
        result.listenAddress = node.p2pNetwork?.p2pNode?.getMultiaddrs() ?? 'No Listen Address';
        result.lastLegitimacy = node.blockchainStats?.lastLegitimacy ?? 'No Legitimacy';
        result.peers = node.p2pNetwork?.peers ?? 'No Peers';
        result.ignoreIncomingBlocks = node.ignoreIncomingBlocks;
        result.disabledSync = node.syncHandler?.syncDisabled ?? false;

        return result;
    }
    /** @param {Node} node */
    static extractPublicNodeInfo(node) {
        const result = { roles: node.roles };

        if (node.roles.includes('validator')) {
            result.validatorAddress = node.account.address;
            result.currentHeight = node.blockchain.currentHeight;
        }

        return result;
    }
}

export class DashboardWsApp {
    /** @type {NodeSetting} */
    #nodeSetting; // new version
    /** @type {Wallet} */
    #wallet;
    localonly = true;
    stopping = false;
    stopped = false;
    waitingForPassword = true;
    waitingForPrivKey = false;
    portMapped;
    /** @type {CryptoLight} */
    cryptoFinger = null;

    /** @param {Node} node @param {CryptoLight} cryptoLight */
    constructor(node, cryptoLight, nodePort = 27260, dashboardPort = 27271, autoInit = true) {
        this.miniLogger = new MiniLogger('dashboard');
        /** @type {Node} */
        this.node = node;
        /** @type {CryptoLight} */
        this.cryptoLight = cryptoLight;
        /** @type {CallBackManager} */
        this.callBackManager = null;
        /** @type {express.Application} */
        this.app = null;
        this.nodePort = nodePort;
        this.dashboardPort = dashboardPort;
        /** @type {WebSocketServer} */
        this.wss = null;

        // try to map the port (promise takes some time to resolve)
        this.portMapped = EasyUpnp.tryPortMappingUntilSuccess([nodePort]);
        this.readableNow = () => { return `${new Date().toLocaleTimeString()}:${new Date().getMilliseconds()}` };
        if (autoInit) this.init();
        this.#stopNodeIfRequestedLoop();
    }
    async init(privateKey, forceRelay) {
        // NODE CLIENT INIT

        // load the new version of the node settings
        const nodeSettingsLoadedAsCLFinger = await this.loadNodeSettingBinary('finger');
        // or fallback to the old version if not loaded as v2
        if (!nodeSettingsLoadedAsCLFinger) await this.loadNodeSettingBinary('v0');// UPDATED TO NEW VERSION WITH ENCRYPTION

        if (nodeSettingsLoadedAsCLFinger) this.waitingForPassword = false; // prevent waiting for password if settings are loaded as v2
        if (privateKey) this.waitingForPrivKey = false; // prevent waiting for priv key if provided even if node is not active

        const storedPrivKey = this.#nodeSetting?.privateKey;
        const usablePrivKey = privateKey || storedPrivKey;
        if (!this.node && usablePrivKey) { await this.initMultiNode(usablePrivKey, forceRelay); }
        if (!this.node) { // fail to init node with default or provided private key
            this.waitingForPrivKey = true; // if the node is not started and the settings are not loaded as v2, we need to wait for the priv key
            console.info("Failed to init node... waiting For PrivKey...");
            return false;
        }
    
        this.#nodeSetting = this.#nodeSetting || {
            privateKey: usablePrivKey,
            validatorRewardAddress: this.node.validatorRewardAddress,
            minerAddress: this.node.minerAddress,
            minerThreads: 1 // default value
        };

        // WEB SERVER INIT
        if (this.app === null) {
            this.app = express();
            this.app.use(cors({ origin: `http://localhost:${this.dashboardPort}` }));
            this.app.use(express.static(APPS_VARS.__nodeDir));
            this.app.use(express.json({ limit: '1mb' }));
            this.app.use(express.urlencoded({ extended: true }));
            this.app.use('/src', express.static(path.join(APPS_VARS.__nodeDir, 'src')));
            this.app.use('/node/src', express.static(path.join(APPS_VARS.__nodeDir, 'src')));
            this.app.use('/libs', express.static(path.join(APPS_VARS.__contrastDir, 'libs')));
            this.app.use('/styles', express.static(path.join(APPS_VARS.__contrastDir, 'styles')));
            this.app.use('/utils', express.static(path.join(APPS_VARS.__contrastDir, 'utils')));
            this.app.use('/miniLogger', express.static(path.join(APPS_VARS.__contrastDir, 'miniLogger')));
            
            this.app.get('/', (req, res) => { res.sendFile(APPS_VARS.__nodeDir + '/front/nodeDashboard.html'); });
            this.app.get('/log-config', (req, res) => { res.sendFile(APPS_VARS.__nodeDir + '/front/log-config.html'); });
            this.app.get('/log-viewer', (req, res) => { res.sendFile(APPS_VARS.__nodeDir + '/front/log-viewer.html'); });

            const server = this.app.listen(this.dashboardPort, () => { console.log(`Server running on http://${'???'}:${this.dashboardPort}`); });
            this.wss = new WebSocketServer({ server });
        }
        
        this.wss.on('connection', this.#onConnection.bind(this));
        this.wss.on('close', () => { console.log('Server closed'); });

        this.#injectNodeSettings(this.node.account.address);
        this.#injectCallbacks();

        return true;
    }
    async initMultiNode(nodePrivateKey = 'ff', forceRelay) {
        this.#wallet = new Wallet(nodePrivateKey);
        await this.#wallet.loadAccounts();

        const { derivedAccounts, avgIterations } = await this.#wallet.deriveAccounts(2, "C");
        if (!derivedAccounts) { console.error('Failed to derive addresses.'); return; }
        await this.#wallet.saveAccounts();

        const listenAddresses = [`/ip4/0.0.0.0/tcp/${this.nodePort}`]; // '/ip4/0.0.0.0/tcp/0'
        const isRelayCandidate = forceRelay || await this.portMapped ? true : false;
        this.node = new Node(derivedAccounts[0], ['validator', 'miner', 'observer'], listenAddresses, isRelayCandidate);
        this.node.minerAddress = derivedAccounts[1].address;
        await this.node.start();

        console.log(`Multi node started, account : ${this.node.account.address}`);
        return this.node;
    }
    extractNodeSetting() {
        if (!this.#nodeSetting) { return false; }

        /** @type {NodeSetting} */
        const clone = JSON.parse(JSON.stringify(this.#nodeSetting));
        return clone;
    }
    async generateNewAddress(prefix = 'W') {
        if (!this.#wallet) { console.error('No wallet found'); return; }

        await this.#wallet.loadAccounts();
        const nbOfExistingAccounts = this.#wallet.accountsGenerated[prefix].length;
        const derivedAccounts = (await this.#wallet.deriveAccounts(nbOfExistingAccounts + 1, prefix)).derivedAccounts;
        if (!derivedAccounts) { console.error('Failed to derive accounts.'); return; }

        const derivedAccount = derivedAccounts[derivedAccounts.length - 1];
        if (!derivedAccount) { console.error('Failed to derive address.'); return; }

        await this.#wallet.saveAccounts();
        return derivedAccount.address;
    }
    async #onConnection(ws, req, localonly = false) {
        //const clientIp = req.socket.remoteAddress === '::1' ? 'localhost' : req.socket.remoteAddress;
        let clientIp = req.socket.remoteAddress;
        if (clientIp === '::1') { clientIp = 'localhost'; }
        if (clientIp === '::ffff:127.0.0.1') { clientIp = 'localhost'; }

        // Allow only localhost connections
        if (this.localonly && clientIp !== 'localhost') {
            console.warn(`[DASHBOARD] Connection attempt from unauthorized IP: ${clientIp}`);
            ws.close(1008, 'Unauthorized'); // 1008: Policy Violation
            return;
        }

        console.log(`[DASHBOARD] ${this.readableNow()} Client connected: ${clientIp}`);
        ws.on('close', function close() { console.log('Connection closed'); });

        const messageHandler = (message) => { this.#onMessage(message, ws); };
        ws.on('message', messageHandler);
        
        while (!this.node) {
            await new Promise(resolve => setTimeout(resolve, 200));
            if (this.waitingForPrivKey) break;
        }
        if (this.waitingForPrivKey) {
            console.info("Node active Node and No private keys provided, can't auto init node...");
            ws.send(JSON.stringify({ type: 'error', data: 'No active node' }));
        }
    }
    #injectNodeSettings(nodeId) {
        const node = this.node;
        if (!node) { console.error(`Node ${nodeId} not found`); return; }
        if (!this.#nodeSetting) { console.error(`NodeSetting not found`); return; }

        node.validatorRewardAddress = this.#nodeSetting.validatorRewardAddress || node.validatorRewardAddress;
        node.minerAddress = this.#nodeSetting.minerAddress || node.minerAddress;
        node.miner.address = this.#nodeSetting.minerAddress || node.miner.address;
        node.miner.nbOfWorkers = typeof this.#nodeSetting.minerThreads === 'number' ? this.#nodeSetting.minerThreads : node.miner.nbOfWorkers;
    }
    #injectCallbacks() {
        const callbacksModes = []; // we will add the modes related to the callbacks we want to init
        if (this.node.roles.includes('validator')) { callbacksModes.push('validatorDashboard'); }
        if (this.node.roles.includes('miner')) { callbacksModes.push('minerDashboard'); }
        this.callBackManager = new CallBackManager(this.node);
        this.callBackManager.initAllCallbacksOfMode(callbacksModes, this.wss.clients);
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
                await this.saveNodeSettingBinary('v0');
                await this.saveNodeSettingBinary('finger');
                break;
            case 'update_git':
                this.miniLogger.log(`update_git disabled`, (m) => { console.log(m); });
                break;
            case 'hard_reset':
                this.miniLogger.log(`hard_reset disabled`, (m) => { console.log(m); });
                break;
            case 'set_validator_address':
                if (!this.node) { console.error('No active node'); break; }
                try {
                    addressUtils.conformityCheck(data)
                    this.#nodeSetting.validatorRewardAddress = data;

                    this.#injectNodeSettings(this.node.id);
                    await this.saveNodeSettingBinary('v0');
                    await this.saveNodeSettingBinary('finger');
                } catch (error) {
                    console.error(`Error setting validator address: ${data}, not conform`);
                }
                break;
            case 'set_miner_address':
                if (!this.node) { console.error('No active node'); break; }
                if (!this.node.miner) { console.error('No miner found'); break; }
                try {
                    addressUtils.conformityCheck(data)
                    this.#nodeSetting.minerAddress = data;
                    this.#injectNodeSettings(this.node.id);
                    await this.saveNodeSettingBinary('v0');
                    await this.saveNodeSettingBinary('finger');
                } catch (error) {
                    console.error(`Error setting miner address: ${data}, not conform`);
                }
                break;
            case 'force_restart':
                ws.send(JSON.stringify({ type: 'node_restarting', data }));
                this.node.restartRequested = `Dashboard app ${data}`;
                this.miniLogger.log(`Node ${data} restart requested by dashboard`, (m) => { console.log(m); });
                break;
            case 'force_restart_revalidate_blocks':
                this.miniLogger.log(`force_restart_revalidate_blocks disabled`, (m) => { console.log(m); });
                break;
            case 'get_node_info':
                const nodeInfo = AppStaticFncs.extractPrivateNodeInfo(this.node);
                ws.send(JSON.stringify({ type: 'node_info', data: nodeInfo }));
                break;
            case 'set_miner_threads':
                console.log(`Setting miner threads to ${data}`);
                if (!this.node) { console.error('No active node'); break; }
                this.#nodeSetting.minerThreads = Number(data);
                this.#injectNodeSettings(this.node.id);
                await this.saveNodeSettingBinary('v0');
                await this.saveNodeSettingBinary('finger');
                break;
            case 'new_unsigned_transaction':
                console.log(`DISABLED new_unsigned_transaction`, (m) => { console.log(m); });
                break;
                console.log(`signing transaction ${data.id}`);
                const tx = await this.node.account.signTransaction(data);
                console.log('Broadcast transaction', data);
                const { broadcasted, pushedInLocalMempool, error } = await this.node.pushTransaction(tx);

                if (error) { console.error('Error broadcasting transaction', error); return; }

                ws.send(JSON.stringify({ type: 'transaction_broadcasted', data: { broadcasted, pushedInLocalMempool } }));
                console.log('Transaction sent');
                break;
            case 'disconnect_peer':
                console.log(`Disconnecting peer ${data}`);
                this.node.p2pNetwork.closeConnection(data);
                break;
            case 'ask_sync_peer':
                console.log(`ask_sync_peer disabled`, (m) => { console.log(m); });
                //console.log(`Asking peer ${data} to sync`);
                //this.node.syncHandler.syncWithPeers(data);
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
    /** @param {'v0' | 'finger'} */
    async saveNodeSettingBinary(encryption = 'v0') {
        // overiding the JSON saving, using encryption. Only one node (not an array) in this version.
        /** @type {NodeSetting} */
        const nodeSetting = this.#nodeSetting;
        if (!this.#isNodeSettingValide(nodeSetting)) { console.error('Invalid nodeSetting'); return; }

        const serialized = serializer.serialize.nodeSetting(nodeSetting);
        const cryptoLight = encryption === 'v0' ? this.cryptoLight : this.cryptoFinger;
        if (!cryptoLight.isReady()) { console.error('CryptoLight not ready'); return; }

        /** @type {Uint8Array} */
        const encrypted = await cryptoLight.encryptText(serialized, undefined, false);
        if (!encrypted) { console.error('Encryption failed'); return; }
        Storage.saveBinary('nodeSetting', encrypted);

        console.log('NodeSetting saved as binary with encryption', encryption);
    }
    /** @param {'v0' | 'finger'} */
    async loadNodeSettingBinary(encryption = 'v0') {
        // overiding the JSON loading, using encryption. Only one node (not an array) in this version.
        const encrypted = Storage.loadBinary('nodeSetting');
        if (!encrypted) { console.log('No nodeSetting found'); return; }

        const cryptoLight = encryption === 'v0' ? this.cryptoLight : this.cryptoFinger;
        if (!cryptoLight.isReady()) { console.error('CryptoLight not ready'); return; }
        
        const serialized = await cryptoLight.decryptText(encrypted, false, true);
        if (!serialized || serialized.length !== 65) { console.error('Invalid nodeSetting length'); return; }

        const nodeSetting = serializer.deserialize.nodeSetting(serialized);
        if (!this.#isNodeSettingValide(nodeSetting)) { console.error('Invalid nodeSetting'); return; }

        this.#nodeSetting = nodeSetting;

        console.log('NodeSetting loaded as binary with encryption', encryption);
    }
    /** @param {NodeSetting} nodeSetting */
    #isNodeSettingValide(nodeSetting) {
        if (!nodeSetting) { return false; }
        if (!nodeSetting.privateKey || typeof nodeSetting.privateKey !== 'string') { return false; }
        if (!nodeSetting.validatorRewardAddress || typeof nodeSetting.validatorRewardAddress !== 'string') { return false; }
        if (!nodeSetting.minerAddress || typeof nodeSetting.minerAddress !== 'string') { return false; }
        if (typeof nodeSetting.minerThreads !== 'number' || nodeSetting.minerThreads < 0) { return false; }
        return true;
    }
    async #stopNodeIfRequestedLoop() {
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!this.node || !this.node.restartRequested) { continue; }

            this.miniLogger.log('#stopNodeIfRequestedLoop() -->', (m) => { console.log(m); });
            this.miniLogger.log(`Node ${this.node.id} restart requested by ${this.node.restartRequested}`, (m) => { console.log(m); });
            this.node.updateState(`${this.node.restartRequested}, Restarting...`);
            await new Promise(resolve => setTimeout(resolve, 100)); // (time to send state update message)

            this.miniLogger.log(`||----->>> Node ${this.node.id} exiting dashboard app ...`, (m) => { console.log(m); });
            await this.stop();
            this.miniLogger.log(`||----->>> Node ${this.node.id} dashboard app stopped ...`, (m) => { console.log(m); });

            return;
        }
    }
    async stop() {
        if (this.stopping) { return; }
        this.stopping = true;

        this.#closeAllConnections();
        this.wss.close();

        if (!this.node) { return; }

        this.node.opStack.terminate();
        this.node.timeSynchronizer.stop = true;
        await new Promise(resolve => setTimeout(resolve, 2000));

        //await this.node.miner.terminateAsync();
        const promises = [];
        for (const worker of this.node.miner.workers) { promises.push(worker.terminateAsync()); }
        for (const worker of this.node.workers) { promises.push(worker.terminateAsync()); }
        await Promise.all(promises);

        this.miniLogger.log(`----- All Workers terminated -----`, (m) => { console.log(m); });

        await this.node.p2pNetwork.stop();
        this.miniLogger.log(`----- P2P stopped -----`, (m) => { console.log(m); });

        //await new Promise(resolve => setTimeout(resolve, 2000));
        this.miniLogger.log(`----- Dashboard stopped App -----`, (m) => { console.log(m); });
        this.stopped = true;
    }
}

export class ObserverWsApp {
    stopped = false;
    /** @param {Node} node */
    constructor(node, port = 27270) {
        /** @type {Node} */
        this.node = node;
        /** @type {CallBackManager} */
        this.callBackManager = null;
        /** @type {express.Application} */
        this.app = null;
        this.port = port;
        /** @type {WebSocketServer} */
        this.wss =  null;
        this.wssClientsIPs = {};
        this.maxConnectionsPerIP = 5;

        this.readableNow = () => { return `${new Date().toLocaleTimeString()}:${new Date().getMilliseconds()}` };
        this.init();
    }
    async init() {
        while (!this.node) { 
            console.log('[OBSERVER] Waiting for node to be initialized...');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!this.node.roles.includes('validator')) { throw new Error('ObserverWsApp must be used with a validator node'); }
        if (!this.node.roles.includes('observer')) { throw new Error('ObserverWsApp must be used with an observer node'); }

        if (this.app === null) {
            this.app = express();
            this.app.use(cors());
            this.app.use(express.static(APPS_VARS.__dirname));
            //this.app.use(express.static(APPS_VARS.__nodeDir));
            
            this.app.use('/styles', express.static(path.join(APPS_VARS.__contrastDir, 'styles')));
            this.app.use('/front', express.static(path.join(APPS_VARS.__nodeDir, 'front')));
            this.app.use('/src', express.static(path.join(APPS_VARS.__nodeDir, 'src')));
            this.app.use('/node/src', express.static(path.join(APPS_VARS.__nodeDir, 'src')));
            this.app.use('/libs', express.static(path.join(APPS_VARS.__contrastDir, 'libs')));
            this.app.use('/fonts', express.static(path.join(APPS_VARS.__contrastDir, 'fonts')));
            this.app.use('/utils', express.static(path.join(APPS_VARS.__contrastDir, 'utils')));
            this.app.use('/miniLogger', express.static(path.join(APPS_VARS.__contrastDir, 'miniLogger')));
            
            this.app.get('/', (req, res) => { res.sendFile(APPS_VARS.__nodeDir + '/front/explorer.html'); });
        }
        
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
            console.log(`[OBSERVER] ${this.readableNow()} Client max connection reached: ${clientIp} (${this.wssClientsIPs[clientIp]}/${this.maxConnectionsPerIP})`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            ws.close(undefined, 'Max connections per IP reached');
            this.wssClientsIPs[clientIp] -= 1;
            return;
        }

        if (!this.wssClientsIPs[clientIp]) { this.wssClientsIPs[clientIp] = 0; }
        this.wssClientsIPs[clientIp] += 1;
        console.log(`[OBSERVER] ${this.readableNow()} Client connected: ${clientIp} (${this.wssClientsIPs[clientIp]}/${this.maxConnectionsPerIP}) connections`);

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
    #initConnectionMessage(ws) {
        const nbOfBlocks = 5 - 1; // 5 last blocks
        const toHeight = this.node.blockchain.currentHeight - 1 < 0 ? 0 : this.node.blockchain.currentHeight;
        const startHeight = toHeight - nbOfBlocks < 0 ? 0 : toHeight - nbOfBlocks;
        const last5BlocksInfo = this.node.blockchain.lastBlock ? this.node.getBlocksInfo(startHeight, toHeight) : [];
        ws.send(JSON.stringify({ type: 'last_confirmed_blocks', data: last5BlocksInfo }));

        const time = this.node.timeSynchronizer.getCurrentTime();
        ws.send(JSON.stringify({ type: 'current_time', data: time }));
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
                case 'get_update_info':
                case 'get_node_info':
                    const nodeInfo = AppStaticFncs.extractPrivateNodeInfo(this.node);
                    ws.send(JSON.stringify({ type: 'node_info', data: nodeInfo }));
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
                    exhaustiveBlockData = this.node.getExhaustiveBlockDataByHash(data);
                    ws.send(JSON.stringify({ type: 'blocks_data_requested', data: exhaustiveBlockData }));
                    break;
                case 'get_cached_blocks_timestamps':
                    ws.send(JSON.stringify({ type: 'blocks_timestamps_requested', data: this.node.blockchain.cache.getAllBlocksTimestamps() }));
                    break;
                case 'get_round_legitimacies':
                    const roundLegitimacies = await this.node.vss.calculateRoundLegitimacies(data?.preHash || this.node.blockchain.lastBlock.hash);
                    ws.send(JSON.stringify({ type: 'round_legitimacies_requested', data: { roundLegitimacies, height: data?.height || this.node.blockchain.currentHeight} }));
                    break;
                case 'get_vss_spectrum':
                    ws.send(JSON.stringify({ type: 'vss_spectrum_requested', data: this.node.vss.spectrum }));
                    break;
                case 'get_biggests_holders_balances':
                    //const biggestsHolders = this.node.utxoCache.biggestsHolders;
                    /*const biggestsHoldersBalances = biggestsHolders.map(address => {
                        return { address, balance: this.node.utxoCache.balances[address] };
                    });*/
                    ws.send(JSON.stringify({ type: 'biggests_balances_requested', data: this.node.utxoCache.biggestsHoldersBalances }));
                    break;
                case 'get_new_block_confirmed':
                    const blocksInfo = this.node.getBlocksInfo(this.node.blockchain.currentHeight);
                    ws.send(JSON.stringify({ type: 'new_block_confirmed', data: blocksInfo[0] }));
                    break;
                case 'get_address_utxos':
                    const UTXOs = this.node.getAddressUtxos(data);
                    ws.send(JSON.stringify({ type: 'address_utxos_requested', data: { address: data, UTXOs } }));
                    break;
                case 'get_address_transactions_references':
                    if (data === undefined) { console.error('data undefined'); return; }
                    const gatrParams = {
                        address: typeof data === 'string' ? data : data.address,
                        from: typeof data === 'string' ? 0 : data.from,
                        to: typeof data === 'string' ? this.node.blockchain.currentHeight : data.to,
                    }

                    const addTxsRefs = this.node.blockchain.getTxsReferencesOfAddress(this.node.memPool, gatrParams.address, gatrParams.from, gatrParams.to);
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

                    const { addressUTXOs, addressTxsReferences } = this.node.getAddressExhaustiveData(gaedParams.address, gaedParams.from, gaedParams.to);
                    ws.send(JSON.stringify({ type: 'address_exhaustive_data_requested', data: { address: gaedParams.address, addressUTXOs, addressTxsReferences } }));
                    break;
                case 'address_utxos':
                    ws.send(JSON.stringify({ type: 'address_utxos_requested', data: { address: data, UTXOs: this.node.getAddressUtxos(data) } }));
                case 'get_transaction_by_reference':
                    const resTx = this.node.getTransactionByReference(data);
                    if (!resTx) { console.error(`[OBSERVER] Transaction not found: ${data}`); return; }
                    ws.send(JSON.stringify({ type: 'transaction_requested', data: resTx.transaction }));
                    break;
                case 'get_transaction_with_balanceChange_by_reference':
                    //const result = { transaction, balanceChange, inAmount, outAmount, fee };
                    const { transaction, balanceChange, inAmount, outAmount, fee, timestamp } = this.node.getTransactionByReference(data.txReference, data.address, true);
                    if (!transaction) { console.error(`[OBSERVER] Transaction not found: ${data.txReference}`); return; }
                    ws.send(JSON.stringify({ type: 'transaction_requested', data: { transaction, balanceChange, inAmount, outAmount, fee, txReference: data.txReference, timestamp } }));
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
                    //const deserializeTx = serializer.deserialize.transaction(data);
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
                    this.node.opStack.pushFirst('digestPowProposal', data);
                    break;
                default:
                    ws.send(JSON.stringify({ type: 'error', data: `unknown message type: ${parsedMessage.type}` }));
                    break;
            }
        } catch (error) { console.error(`[OBSERVER] Error on message: ${error.message}`) }
    }
    stop() {
        if (!this.wss || this.stopped) { return; }
        
        this.#closeAllConnections();
        this.wss.close();
        this.stopped = true;
    }
}