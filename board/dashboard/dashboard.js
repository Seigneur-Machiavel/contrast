//import { Transaction_Builder, UTXO } from '../src/transaction.mjs';
//import { convert } from '../../utils/converters.mjs';
import { eHTML_STORE } from '../board-helpers.js';

/**
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction
 * @typedef {import("../../src/vss.mjs").StakeReference} StakeReference
 */

let ws;
const WS_SETTINGS = {
    PROTOCOL: "ws:",
    DOMAIN: "127.0.0.1",
    PORT: 27261,
    RECONNECT_INTERVAL: 5000,
    GET_NODE_INFO_INTERVAL: 5000,
}

const ACTIONS = {
    HARD_RESET: 'hard_reset',
    UPDATE_GIT: 'update_git',
    FORCE_RESTART: 'force_restart',
    REVALIDATE: 'revalidate',
    RESET_WALLET: 'reset_wallet',
    SETUP: 'setup',
    SET_VALIDATOR_ADDRESS: 'set_validator_address',
    SET_MINER_ADDRESS: 'set_miner_address'
};

const eHTML = new eHTML_STORE('cnd-', 'connection-btn');
export class Dashboard {
	/** @type {WebSocket} */ ws;
	textEncoder = new TextEncoder();
	textDecoder = new TextDecoder();
	clientPublicKey;
	eHTML = eHTML;
	sharedSecret;
	myKeypair;
	connector;

	/** @param {import('../connector.js').Connector} connector */
	constructor(connector) {
		this.connector = connector;
		this.#initWhileDomReady();
		this.myKeypair = this.connector.p2pNode.cryptoCodex.generateEphemeralX25519Keypair();
	}

	// INTERNAL METHODS
	async #initWhileDomReady() {
		console.log('Dashboard awaiting DOM elements...');
		if (!eHTML.isReady) console.log('Explorer awaiting DOM elements...');
		while (!eHTML.isReady) await new Promise(r => setTimeout(r, 200));

		console.log('Dashboard DOM elements ready.');
		eHTML.get('connection-btn').addEventListener('click', this.#connectBtnHandler);
	}
	#connectBtnHandler = (e) => {
		this.ws = new WebSocket(`${WS_SETTINGS.PROTOCOL}//${WS_SETTINGS.DOMAIN}:${WS_SETTINGS.PORT}`);
		this.ws.binaryType = 'arraybuffer';
		const connectionBtn = eHTML.get('connection-btn');
		connectionBtn.disabled = true;
		connectionBtn.textContent = 'Connecting...';

		this.ws.onopen = () => this.#handleConnection();
		this.ws.onmessage = (message) => this.#handleMessage(message);
		this.ws.onclose = () => this.#handleClose();
	}
	/** @param {import('ws').WebSocket} ws */
	#handleConnection = (ws) => {
		this.wsConnection = ws;
		eHTML.get('connection-btn').textContent = 'Encrypting...';
		this.ws.send(this.myKeypair.myPub);
	}
	/** @param {ArrayBuffer} message */
	#handleMessage = (message) => {
		try {
			console.log('[NodeController] Received message:', message);
			const d = new Uint8Array(message.data);
			if (!this.sharedSecret) {
				this.#handleKeyExchange(d);
				return;
			}
			
			const { type, data } = this.#parseEncryptedMessage(d);
			if (!type) throw new Error('Message type is missing');
			if (type === 'stateUpdate') this.#handleStateUpdate(data);
		} catch (/**@type {any} */ error) { console.error(error.message); }
	}
	/** @param {any} data */
	#handleKeyExchange = (data) => {
		const codex = this.connector.p2pNode.cryptoCodex;
		this.clientPublicKey = data;
		this.sharedSecret = codex.computeX25519SharedSecret(this.myKeypair.myPriv, data);
		eHTML.get('connection-btn').textContent = 'Connected';
		setTimeout(() => eHTML.get('establishing-connection').classList.add('hide'), 500);
		console.log('[NodeController] Key exchange completed - secure channel established');
	}
	/** @param {string} type @param {any} data */
	#sendEncryptedMessage = (type, data) => {
		if (!this.sharedSecret || !this.wsConnection) return;
		const str = JSON.stringify({ type, data });
		const encoded = this.textEncoder.encode(str);
		const encrypted = this.connector.p2pNode.cryptoCodex.encryptData(encoded, this.sharedSecret);
		this.wsConnection.send(encrypted);
	}
	/** @param {Uint8Array} encryptedData */
	#parseEncryptedMessage = (encryptedData) => {
		if (!this.sharedSecret) throw new Error('No shared secret established');
		const decrypted = this.connector.p2pNode.cryptoCodex.decryptData(encryptedData, this.sharedSecret);
		const decodedStr = this.textDecoder.decode(decrypted);
		return JSON.parse(decodedStr);
	}
	#handleClose = () => {
		this.clientPublicKey = null;
		this.wsConnection = null;
		this.sharedSecret = null;
		this.myKeypair = this.connector.p2pNode.cryptoCodex.generateEphemeralX25519Keypair(); // Prepare new keypair for next connection
		eHTML.get('establishing-connection').classList.remove('hide');
		eHTML.get('connection-btn').disabled = false;
		eHTML.get('connection-btn').textContent = 'Connect';
		console.log('[NodeController] WebSocket connection closed => reset keys');
	}
	/** @param {string} data */
	#handleStateUpdate = (data) => {
		eHTML.get('nodeState').textContent = data;
	}
}

function connectWS() {
    ws = new WebSocket(`${WS_SETTINGS.PROTOCOL}//${WS_SETTINGS.DOMAIN}:${WS_SETTINGS.PORT}`);
    //console.log(`Connecting to ${WS_SETTINGS.PROTOCOL}//${WS_SETTINGS.DOMAIN}:${WS_SETTINGS.PORT}`);
  
    ws.onopen = function() {
        console.log('Connection opened');
        ws.send(JSON.stringify({ type: 'get_node_info', data: Date.now() })); // do it once at the beginning
    };
    ws.onclose = function() {
        console.info('Connection closed');
        setTimeout(connectWS, WS_SETTINGS.RECONNECT_INTERVAL); // retry connection
    };
    ws.onerror = function(error) { console.info('WebSocket error: ' + error); };
  
    ws.onmessage = function(event) {
        const message = JSON.parse(event.data);
        const trigger = message.trigger;
        const data = message.data;
        if (data && data.error) { console.info(data.error); }
        switch (message.type) {
            case 'error':
                if (data === 'No active node' && !modalOpen) {
                    openModal(ACTIONS.SETUP, {
                        message: 'No active node detected. Please set up your private key.',
                        inputLabel: 'Private Key:',
                        inputType: 'password',
                        showInput: true
                    });
                    console.log('No active node, opening setup modal');
                }
                break;
            case 'node_info':
                if (data.error === 'No active node') { return; }

                displayNodeInfo(data);
                nodeId = data.nodeId;
                validatorUTXOs = data.validatorUTXOs;
                minerUTXOs = data.minerUTXOs;
                
                break;
            case 'state_updated':
                if (typeof data !== 'string') { console.error('state_update: data is not a string'); return; }
                eHTML.nodeState.textContent = data;
                break;
            case 'node_restarting':
                console.log('node_restarting', data);
                break;
            case 'node_restarted':
                console.log('node_restarted', data);
                break;
            case 'broadcast_new_candidate':
                console.log('broadcast_new_candidate', data);
                break;
            case 'broadcast_finalized_block':
                //console.log('broadcast_finalized_block', data);
                break;
            case 'transaction_broadcasted':
                console.log('transaction_broadcasted', data);
                break;
            case 'hash_rate_updated':
                if (isNaN(data)) { console.error(`hash_rate_updated: ${data} is not a number`); return; }
                eHTML.hashRate.textContent = data.toFixed(2);
                break;
            case 'balance_updated':
                //console.log('balance_updated', data);
                return; // not used anymore, we fetch node_info frequently
                if(trigger === eHTML.validatorAddress.textContent) { eHTML.validatorBalance.textContent = convert.formatNumberAsCurrency(data); }
                if(trigger === eHTML.minerAddress.textContent) { eHTML.minerBalance.textContent = convert.formatNumberAsCurrency(data); }
                break;
            default:
                console.error(`Unknown message type: ${message.type}`);
                break;
        }
    };
}
