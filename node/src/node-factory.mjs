import { Node } from './node.mjs';
import { Account } from './wallet.mjs';

export class NodeFactory {
    constructor(nodePort = 27260) {
        this.nodePort = nodePort;
        /** @type {Map<string, Node>} */
        this.nodes = new Map();
        this.nodesCreationSettings = {};
        this.restartCounter = 0;
        this.#controlLoop();
    }
    async #restartNodesWhoRequestedIt() {
        for (const node of this.nodes.values()) {
            if (!node.restartRequested || node.restarting) { continue; }
            await this.forceRestartNode(node.id);
        }
    }
    async #controlLoop() {
        while (true) {
            await this.#restartNodesWhoRequestedIt();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    /**
     * @param {Account} account
     * @param {string[]} roles
     * @param {Object<string, string>}
     * @param {string} minerAddress - if not specified, the miner address will be the same as the validator address
     */
    async createNode(account, roles = ['validator'], p2pOptions = {}, minerAddress) {
        const listenAddress = p2pOptions.listenAddress;
        if (listenAddress) {
            // exemple : /ip4/vrjvrj/tcp/PORT
            const protocol = listenAddress.split('/')[1];
            const ip = listenAddress.split('/')[2];
            const transport = listenAddress.split('/')[3];
            const port = listenAddress.split('/')[4];
            if (port) { p2pOptions.listenAddress = `/${protocol}/${ip}/${transport}/${this.nodePort || port}`; }
        }
        
        const rolesArray = Array.isArray(roles) ? roles : [roles];
        const node = new Node(account, rolesArray, p2pOptions);
        if (minerAddress) { node.minerAddress = minerAddress; }
        this.nodes.set(node.id, node);
        console.log(`Node ${node.id} created`);
        return node;
    }
    /**
     * @param {string} nodeId 
     * @param {boolean} skipBlocksValidation - if true, the node will not validate the blocks loaded from the database
     * @param {boolean} startFromScratch - if true, the node will start from the genesis block
     */
    async forceRestartNode(nodeId, startFromScratch = false, newAccount = null, newMinerAddress = null) {
        /** @type {Node} */
        console.log(`°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°`);
        console.log(`Forcing restart of node ${nodeId} with account ${newAccount ? newAccount.address : 'unchanged'}`);
        console.log(`---- Already restarted ${this.restartCounter} times ----`);
        console.log(`°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°°`);

        const targetNode = this.getNode(nodeId);
        if (!targetNode) { console.error(`Node ${nodeId} not found`); return; }

        targetNode.restarting = true;
        if (!targetNode.restartRequested) {
            targetNode.requestRestart('NodeFactory.forceRestartNode()');
            console.log(`Node ${nodeId} has been requested to restart...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        console.log(`Restarting node ${nodeId}, requested by ${targetNode.restartRequested}`);

        const nodeAccount = newAccount || targetNode.account;
        const nodeMinerAddress = newMinerAddress || targetNode.minerAddress;
        const validatorRewardAddress = newAccount ? nodeAccount.address : targetNode.validatorRewardAddress;
        const nodeSettings = {
            account: nodeAccount,
            validatorRewardAddress: validatorRewardAddress,
            minerAddress: nodeMinerAddress,
            roles: targetNode.roles,
            p2pOptions: targetNode.p2pOptions
        };
        
        targetNode.opStack.terminate();
        targetNode.timeSynchronizer.stop = true;
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        await targetNode.miner.terminate();
        for (const worker of targetNode.workers) { await worker.terminateAsync(); }
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // stop level db
        await targetNode.blockchain.db.close();
        await targetNode.p2pNetwork.stop();

        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const newNode = await this.createNode(
            nodeSettings.account,
            nodeSettings.roles,
            nodeSettings.p2pOptions,
            nodeSettings.minerAddress
        );

        await newNode.start(startFromScratch);
        newNode.validatorRewardAddress = nodeSettings.validatorRewardAddress;
        console.log(`\nNode ${nodeId} has been restarted${newAccount ? ' with a new account' : ''}.`);
        console.info(`Restart counter: ${this.restartCounter}\n`);
        
        this.nodes.set(nodeId, newNode);
        this.restartCounter++;
    }
    getFirstNode() {
        return this.nodes.values().next().value;
    }
    /** @param {string} nodeId */
    getNode(nodeId) {
        try {
            const node = this.nodes.get(nodeId);
            if (!node) { throw new Error(`Node with ID ${nodeId} not found`); }
            return node;
        } catch (error) {
            console.error(error.message);
            return undefined;
        }
    }
}