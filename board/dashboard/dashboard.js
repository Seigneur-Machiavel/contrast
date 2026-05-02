import { eHTML_STORE } from '../utils/board-helpers.js';
import { serializer } from '../../utils/serializer.mjs';
import { CURRENCY } from '../../utils/currency.mjs';
import { ADDRESS } from '../../types/address.mjs';

/**
 * @typedef {import('../utils/connector-p2p.js').ConnectorP2P} ConnectorP2P
 * @typedef {import('../utils/connector-node.js').ConnectorNode} ConnectorNode
 * @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
 * @typedef {import("../../types/transaction.mjs").Transaction} Transaction */

const eHTML = new eHTML_STORE('cnd-', 'node-pubkey-input');
export class Dashboard {
	connectorP2P;
	connectorNode;
	eHTML = eHTML;
	lastValues = {}; // used to avoid unnecessary DOM updates when values haven't changed. Keys are the same as the "type" field of messages received from the NodeController, suffixed by "Data" if the message contains a "data" field (ex: "nodeInfoData" for a message { type: 'nodeInfo', data: {...} }).

	/** @param {ConnectorP2P} connectorP2P @param {ConnectorNode} connectorNode */
	constructor(connectorP2P, connectorNode) {
		this.connectorP2P = connectorP2P;
		this.connectorNode = connectorNode;
		this.#initWhileDomReady();
	}

	// HANDLERS
	clickHandler(e) {
		if (e.target.dataset.action === 'decreaseThreads') this.sendEncryptedMessage('decreaseThreads');
		if (e.target.dataset.action === 'increaseThreads') this.sendEncryptedMessage('increaseThreads');
	}
	inputHandler(e) { if (e.target.dataset.action === 'setPubkeyFromInput') this.#setControllerPubkeyFromInput(); }
	pasteHandler(e) { if (e.target.dataset.action === 'setPubkeyFromInput') this.#setControllerPubkeyFromInput(); }
	focusInHandler(e) {
		if (e.target.dataset.sAddress || e.target.dataset.vAddress) e.target.classList.add('editing');
	}
	focusOutHandler(e) {
		if (e.target.classList.contains('editing') && (e.target.dataset.sAddress || e.target.dataset.vAddress)) {
			e.target.classList.remove('editing');
			const type = e.target.dataset.sAddress ? 'solver' : 'validator';
			const address = e.target.textContent.trim();
			if (ADDRESS.checkConformity(address)) this.sendEncryptedMessage('setAddress', { type, address });
			else e.target.textContent = type === 'solver' ? e.target.dataset.sAddress : e.target.dataset.vAddress; // reset to previous value if not a valid address			
		}
	}

	// INTERNAL METHODS
	async #initWhileDomReady() {
		if (!eHTML.isReady) console.log('Dashboard awaiting DOM elements...');
		while (!eHTML.isReady) await new Promise(r => setTimeout(r, 200));
		console.log('Dashboard DOM elements ready.');

		//eHTML.get('establishing-connection-text').classList.add('hidden');
		//if (!this.connectorP2P.hostPubkeyStr) eHTML.get('node-pubkey-input').classList.remove('hidden');

		const vAddressSpan = eHTML.get('validatorRewardAddress');
		vAddressSpan.addEventListener('focusin', (e) => this.focusInHandler(e));
		vAddressSpan.addEventListener('focusout', (e) => this.focusOutHandler(e));
		
		const sAddressSpan = eHTML.get('solverRewardAddress');
		sAddressSpan.addEventListener('focusin', (e) => this.focusInHandler(e));
		sAddressSpan.addEventListener('focusout', (e) => this.focusOutHandler(e));

		setInterval(() => this.#connectionStateCheckLoop(), 1000);
		this.connectorNode.onMessageCallbacks['dashboard'] = this.#handleDecryptedMessage;
	}
	#connectionStateCheckLoop() {
		if (this.connectorNode.isConnected) return eHTML.get('dashboard-wrapper').classList.remove('connecting');
		
		eHTML.get('dashboard-wrapper').classList.add('connecting');
		if (!this.connectorP2P.hostPubkeyStr) {
			eHTML.get('node-pubkey-input').classList.remove('hidden');
			eHTML.get('establishing-connection-text').classList.add('hidden');
		} else {
			eHTML.get('node-pubkey-input').classList.add('hidden');
			eHTML.get('establishing-connection-text').classList.remove('hidden');
		}
	}
	#setControllerPubkeyFromInput() {
		try {
			const input = eHTML.get('node-pubkey-input');
			const pubkeyStr = input.value.trim();
			if (pubkeyStr.length !== 64) return null; // expecting 32-byte public key in hex
			else input.value = '';

			this.connectorNode.hostPubkeyStr = pubkeyStr;
			if (chrome.storage) chrome.storage.local.set({ nodePubkey: pubkeyStr });

			this.connectorNode.buildSharedSecretFromPubkey(serializer.converter.hexToBytes(this.connectorNode.hostPubkeyStr), true);
			console.log('Controller pubkey set from input and saved to storage.');
		} catch (error) { console.error('Error getting public key from input:', error); }
	}
	/** @param {string} type @param {any} data */
	#handleDecryptedMessage = (type, data) => {
		if (type === 'stateUpdate') return this.#handleStateUpdate(data);
		if (type === 'myLastLegitimacy') return this.#handleMyLastLegitimacyUpdate(data);
		if (type === 'nodeInfo') return this.#handleNodeInfoUpdate(data);
	}
	#handleStateUpdate(d) {
		if (this.lastValues.nodeState !== d) eHTML.get('nodeState').textContent = d;
		this.lastValues.nodeState = d;
	}
	#handleMyLastLegitimacyUpdate(d) {
		if (this.lastValues.myLastLegitimacy !== d) eHTML.get('lastLegitimacy').textContent = d;
		this.lastValues.myLastLegitimacy = d;
	}
	#handleNodeInfoUpdate(d) {
		const lv = this.lastValues;
		if (lv.currentHeight !== d.currentHeight) eHTML.get('nodeHeight').textContent = d.currentHeight;
	
		// VALIDATION
		if (lv.validationHeight !== d.validationHeight) eHTML.get('validationHeight').textContent = d.validationHeight;
		if (lv.networkPower !== d.networkPower) eHTML.get('networkPower').textContent = d.networkPower.toFixed(2);
		if (lv.solverLegitimacy !== d.solverLegitimacy) eHTML.get('solverLegitimacy').textContent = d.solverLegitimacy;
		if (lv.solverPower !== d.solverPower) eHTML.get('solverPower').textContent = d.solverPower.toFixed(2);
		if (lv.dailyRewardEstimation !== d.dailyRewardEstimation) eHTML.get('dailyReward').textContent = CURRENCY.formatNumberAsCurrency(d.dailyRewardEstimation, 2);
		if (lv.solverThreadCount !== d.solverThreadCount) eHTML.get('solverThreadCount').textContent = d.solverThreadCount;

		// ADDRESSES
		if (lv.publicAddress !== d.publicAddress) eHTML.get('publicAddress').textContent = d.publicAddress;
		if (lv.solverBalance !== d.solverBalance) eHTML.get('solverBalance').textContent = CURRENCY.formatNumberAsCurrency(d.solverBalance || 0, 2);
		if (lv.validatorBalance !== d.validatorBalance) eHTML.get('validatorBalance').textContent = CURRENCY.formatNumberAsCurrency(d.validatorBalance || 0, 2);
		
		if (!eHTML.get('solverRewardAddress').classList.contains('editing')) {
			eHTML.get('solverRewardAddress').textContent = d.solverRewardAddress;
			eHTML.get('solverRewardAddress').dataset.sAddress = d.solverRewardAddress;
		}

		if (!eHTML.get('validatorRewardAddress').classList.contains('editing')) {
			eHTML.get('validatorRewardAddress').textContent = d.validatorRewardAddress;
			eHTML.get('validatorRewardAddress').dataset.vAddress = d.validatorRewardAddress;
		}
		
		// DETAILS
		if (lv.clientVersion !== d.clientVersion) eHTML.get('clientVersion').textContent = `v${d.clientVersion}`;
		if (lv.txInMempool !== d.txInMempool) eHTML.get('txInMempool').textContent = d.txInMempool;
		if (lv.nodePeerId !== d.nodePeerId) eHTML.get('peerId').textContent = d.nodePeerId;
		if (lv.listenAddress !== d.listenAddress) eHTML.get('listenAddress').textContent = d.listenAddress;
		if (lv.neighborsCount !== d.neighborsCount) eHTML.get('neighborsCount').textContent = d.neighborsCount;

		// UPDTAES LAST VALUES
		this.lastValues.currentHeight = d.currentHeight;

		this.lastValues.validationHeight = d.validationHeight;
		this.lastValues.networkPower = d.networkPower;
		this.lastValues.solverLegitimacy = d.solverLegitimacy;
		this.lastValues.solverPower = d.solverPower;
		this.lastValues.dailyRewardEstimation = d.dailyRewardEstimation;
		this.lastValues.solverThreadCount = d.solverThreadCount;

		this.lastValues.publicAddress = d.publicAddress;
		this.lastValues.solverBalance = d.solverBalance;
		this.lastValues.validatorBalance = d.validatorBalance;

		this.lastValues.clientVersion = d.clientVersion;
		this.lastValues.txInMempool = d.txInMempool;
		this.lastValues.nodePeerId = d.nodePeerId;
		this.lastValues.listenAddress = d.listenAddress;
		this.lastValues.neighborsCount = d.neighborsCount;
	}
}