if (false) { // THIS IS FOR DEV ONLY ( to get better code completion)
	const anime = require('animejs');
    const Plotly = require('plotly.js-dist-min');
}

//import { StakeReference } from '../src/vss.mjs';
import { ADDRESS } from '../../types/address.mjs';
import { UTXO } from '../../types/transaction.mjs';
import { CURRENCY } from '../../utils/currency.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { createElement } from './generic-helpers.mjs';
import { Transaction_Builder } from '../../node/src/transaction.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';

/**
* @typedef {import("../../types/block.mjs").BlockInfo} BlockInfo
* @typedef {import("../../types/block.mjs").BlockCandidateHeader} BlockCandidateHeader
* @typedef {import("../../types/block.mjs").BlockFinalizedHeader} BlockFinalizedHeader
* @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
* @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
* @typedef {import("../../types/transaction.mjs").Transaction} Transaction
* @typedef {import("../../types/transaction.mjs").UTXO} UTXO

* @typedef {Object} StakeReference
* @property {string} address - Example: "WCHMD65Q7qR2uH9XF5dJ"
* @property {string} anchor - Example: "0:bdadb7ab:0"
* @property {number} amount - Example: 100
* 
* @typedef {Object<string, StakeReference | undefined>} Spectrum
*/

class eHTML {
	// CHAIN OF BLOCKS
	static get contrastBlocks() { return document.getElementById('cbe-contrastBlocks'); }
	static get contrastExplorer() { return document.getElementById('cbe-contrastExplorer'); }

	// CHAIN OVERVIEW (in apparition order)
	static get chainHeight() { return document.getElementById('cbe-chainHeight'); }
	static get targetBlocktime() { return document.getElementById('cbe-targetBlocktime'); }
	static get lastBlockTime() { return document.getElementById('cbe-lastBlocktime'); }
	static get circulatingSupply() { return document.getElementById('cbe-circulatingSupply'); }
	static get circulatingSupplyPercent() { return document.getElementById('cbe-circulatingSupplyPercent'); }
	static get maxSupply() { return document.getElementById('cbe-maxSupply'); }
	
}

export class Explorer {

	/** @param {import('../connector.mjs').Connector} connector */
	constructor(connector) {
		this.connector = connector;
		this.#init();
	}

	async #init() {
		console.log('Explorer awaiting DOM elements...');
		while (!eHTML.maxSupply) await new Promise(r => setTimeout(r, 200));

		console.log('Explorer DOM elements ready');
		eHTML.maxSupply.textContent = CURRENCY.formatNumberAsCurrency(BLOCKCHAIN_SETTINGS.maxSupply);
		eHTML.targetBlocktime.textContent = `${BLOCKCHAIN_SETTINGS.targetBlockTime / 1000}s`;
	}
}