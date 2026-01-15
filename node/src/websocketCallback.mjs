/**
* @typedef {import("./node.mjs").Node} Node
* @typedef {import("../../types/transaction.mjs").TxId} TxId
* @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
* @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
*/

/** @typedef {Object} WebSocketCallBack
 * @property {Function} fnc
 * @property {Object<string, WebSocket[]>} triggers
 * @property {boolean} active
 * @property {function(any, string | 'all' | void): void} execute
 * - arg0= data => To send to the clients.
 * - arg1= trigger - Key of the wsClients ~ ex: '11:ffee00:25'(anchor) default: 'all'
 */

/** 
 * @param {Function} fnc - example: send info to related clients
 * @param {Object<string, WebSocket[]>} triggers - example: trigger="11:ffee00:25"(anchor) -> when uxto is spent => send info to related clients
 */
export const WebSocketCallBack = (fnc, triggers, active = true) => {
    /** @type {WebSocketCallBack} */
    return {
        active,
        fnc,
        triggers,
        execute: (data, trigger = 'all') => {
            try {
                const wsClients = triggers.all ? triggers.all : triggers[trigger];
                if (!wsClients && trigger !== 'all') throw new Error(`No clients found for trigger: ${trigger}`);
                if (wsClients.length === 0) return;
    
                fnc(data, wsClients, trigger);
            } catch (error) {
                //console.error(`Error executing WebSocket callback: ${error.message}`);
            }
        }
    }
}

export class CallBackManager {
    #CALLBACKS_RELATED_TO_MODE;

    /** @param {Node} node */
    constructor(node) {
        /** @type {Node} */
        this.node = node;
        
        this.#CALLBACKS_RELATED_TO_MODE = { // HERE ARE THE GENERIC CALLBACKS - THOSE THAT SPEND EVENT TO ALL CLIENTS
            validatorDashboard: {
                node: ['onBroadcastNewCandidate:all', 'onStateUpdate:all'],
                memPool: ['pushTransaction:all', 'uxtoSpent:all'],
                //utxoCache: [`onBalanceUpdated:${this.node.account.address}`],
            },
            minerDashboard: {
                miner: ['onBroadcastFinalizedBlock:all', 'onHashRateUpdated:all'],
                //utxoCache: [`onBalanceUpdated:${this.node.miner.address}`],
            },
            observer: {
                node: ['onBroadcastNewCandidate:all'], //, 'onBlockConfirmed:all']
            },
        }
    }
    /** 
     * @param { string[] | string } modes - 'validatorDashboard' | 'minerDashboard' | 'observer'
     * @param {WebSocket[]} wsClients - clients to send the message (wss.clients for all) */
    initAllCallbacksOfMode(modes, wsClients) {
        const modesArray = Array.isArray(modes) ? modes : [modes];
        /** @type {Object<string, string[]>} */
        const callBacksRelatedToMode = this.#buildCallBacksFunctionsListToSubscribe(modesArray);
        const targetModules = Object.keys(callBacksRelatedToMode);
        for (const module of targetModules)
            for (const fncKey of callBacksRelatedToMode[module])
                this.attachWsCallBackToModule(module, fncKey, wsClients); // we attach the callback to all clients
    }
    /** 
     * @param {string} moduleName - 'node' | 'miner' | 'memPool' | 'utxoCache'
     * @param {string} fncKey -  "fncName:trigger"  ex: 'balance_updated:W9bxy4aLJiQjX1kNgoAC'
     * @param {WebSocket[]} wsClients - clients to send the message */
    attachWsCallBackToModule(moduleName, fncKey, wsClients) {
		const targetModule = moduleName === 'node' ? this.node : this.node[moduleName];
        if (!targetModule) { console.error(`Module ${moduleName} not found`); return; }
        if (!targetModule.wsCallbacks) { console.error(`Module ${moduleName} has no wsCallbacks`); return; }

        const fncName = fncKey.split(':')[0];
        const trigger = fncKey.split(':')[1] || 'all';
        /** @type {Function} */
        const fnc = CALLBACKS_FUNCTIONS[moduleName][fncName];
        if (!fnc) { console.error(`Function ${fncName} not found`); return; }

		const isAttached = !!targetModule.wsCallbacks[fncName];
        if (!isAttached) targetModule.wsCallbacks[fncName].triggers[trigger] = wsClients;
        else targetModule.wsCallbacks[fncName] = WebSocketCallBack(fnc, {[trigger]: wsClients}, true);
    }
    /** @param { string[] | string } modes */
    #buildCallBacksFunctionsListToSubscribe(modes = ['dashboard']) {
        const modesArray = Array.isArray(modes) ? modes : [modes];
        const aggregatedCallBacksNames = { node: [], miner: [], memPool: [] };
        for (const mode of modesArray) 
            for (const module of Object.keys(this.#CALLBACKS_RELATED_TO_MODE[mode]))
                for (const fncName of this.#CALLBACKS_RELATED_TO_MODE[mode][module]) {
                    if (!aggregatedCallBacksNames[module]) aggregatedCallBacksNames[module] = [];
                    if (!aggregatedCallBacksNames[module].includes(fncName)) aggregatedCallBacksNames[module].push(fncName);
                };

        return aggregatedCallBacksNames;
    }
}

/**
 * @param {any} message 
 * @param {WebSocket[]} wsClients
 */
function sendToClients(message, wsClients) {
    let sentCount = 0;
    for (const client of wsClients) {
        if (client.readyState !== 1) continue;
        sentCount++;
        client.send(JSON.stringify(message));
        //console.info(`[WS] ${message.type} sent to client: ${client.url}`);
        if (sentCount > 100) console.error(`What the fuck ?`);
        if (sentCount > wsClients.length) console.error(`More sent than wsClients.length`);
    };
}

// HERE ARE THE CALLBACKS FUNCTIONS
// each function will be called when the related event is triggered
// developpers can change the "type" of the message to send to the client's websockets
const CALLBACKS_FUNCTIONS = {
    node: {
        /** send the block candidate when the local node broadcast it
         * @param {BlockCandidate} block
         * @param {WebSocket[]} wsClients
         * @emits msgSent: { type: 'broadcast_new_candidate', data: block, trigger } */
        onBroadcastNewCandidate: (block, wsClients = [], trigger = '') => {
            sendToClients({ type: 'broadcast_new_candidate', data: block, trigger }, wsClients);
        },
        onStateUpdate: (newState = 'toto', wsClients = [], trigger = '') => {
            sendToClients({ type: 'state_updated', data: newState, trigger }, wsClients);
        }
    },
    miner: {
        /** send the finalized block when local miner broadcast it
         * @param {BlockFinalized} block
         * @param {WebSocket[]} wsClients
         * @emits msgSent: { type: 'broadcast_finalized_block', data: block, trigger } */
        onBroadcastFinalizedBlock: (block, wsClients = [], trigger = '') => {
            sendToClients({ type: 'broadcast_finalized_block', data: block, trigger }, wsClients);
        },
        /** send the block candidate when the local miner receive it
         * @param {BlockCandidate} block
         * @param {WebSocket[]} wsClients
         * @emits msgSent: { type: 'receive_block_candidate', data: block, trigger } */
        onReceiveBlockCandidate: (block, wsClients = [], trigger = '') => {
            sendToClients({ type: 'receive_block_candidate', data: block, trigger }, wsClients);
        },
        /** send the best block candidate when the local miner update it
         * @param {BlockCandidate} block
         * @param {WebSocket[]} wsClients
         * @emits msgSent: { type: 'best_block_candidate_changed', data: block, trigger }
         */
        onBestBlockCandidateChange: (block, wsClients = [], trigger = '') => {
            sendToClients({ type: 'best_block_candidate_changed', data: block, trigger }, wsClients);
        },
        /** send the local miner hashRate to the clients
         * @param {number} hashRate - hash rate of the miner
         * @param {WebSocket[]} wsClients
         * @emits msgSent: { type: 'hash_rate_updated', data: hashRate, trigger } */
        onHashRateUpdated: (hashRate = 0, wsClients = [], trigger = '') => {
            sendToClients({ type: 'hash_rate_updated', data: hashRate, trigger }, wsClients);
        },
    },
    memPool: {
        /** send info of tx inclusion when the memPool try to push a tx
         * @param {Object} txInfo - { broadcasted, pushedInLocalMempool, error }
         * @param {WebSocket[]} wsClients
         * @emits msgSent: { type: 'transaction_broadcasted', data: txInfo, trigger } */
        pushTransaction: (txInfo = {}, wsClients = [], trigger = '') => {
            sendToClients({ type: 'transaction_broadcasted', data: txInfo, trigger }, wsClients);
        },
        /** send tx reference when the uxto is spent.
         * @param {TxId} txId txId: blockHeight:txIndex - '0:1'
         * @param {WebSocket[]} wsClients
         * @emits msgSent: { type: 'uxto_spent', data: txId, trigger } */
        uxtoSpent: (txId = '0:1', wsClients = [], trigger = '') => {
            sendToClients({ type: 'uxto_spent', data: txId, trigger }, wsClients);
        },
    },
    utxoCache: {
        /** send the updated balance of the related account when the balance is updated */
        onBalanceUpdated: (address = '', wsClients = [], trigger = '') => {
            sendToClients({ type: 'balance_updated', data: address, trigger }, wsClients);
        },
    },
}