// @ts-check
if (false) { // THIS IS FOR DEV ONLY ( to get better code completion)
	const anime = require('animejs');
    const Plotly = require('plotly.js-dist-min');
}

//import { StakeReference } from '../src/vss.mjs';
import { ADDRESS } from '../../types/address.mjs';
//import { UTXO } from '../../types/transaction.mjs';
import { eHTML_STORE } from '../board-helpers.mjs';
import { CURRENCY } from '../../utils/currency.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { ModalComponent } from './modal-component.mjs';
import { BlockchainComponent } from './blockchain-component.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';

/**
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

const eHTML = new eHTML_STORE('cbe-', 'maxSupply');
export class Navigator {
	/** @type {string | null} */	blockHash = null;
	/** @type {number | null} */	blockIndex = null;
	/** @type {number | null} */	txIndex = null;
	/** @type {number | null} */	outputIndex = null;
	/** @type {string | null} */	address = null;
	/** @type {any} */				lastUsed = null;

	get correspondToLastUsed() {
		if (!this.lastUsed) return false;
		if (this.blockHash !== this.lastUsed.blockHash) return false;
		if (this.blockIndex !== this.lastUsed.blockIndex) return false;
		if (this.txIndex !== this.lastUsed.txIndex) return false;
		if (this.outputIndex !== this.lastUsed.outputIndex) return false;
		if (this.address !== this.lastUsed.address) return false;
		return true;
	}
	getValuesAndReset() {
		const { blockHash, blockIndex, txIndex, outputIndex, address } = this;
		this.lastUsed = { blockHash, blockIndex, txIndex, outputIndex, address };
		this.reset();
		return { blockHash, blockIndex, txIndex, outputIndex, address };
	}
	reset() {
		this.blockHash = null;
		this.blockIndex = null;
		this.txIndex = null;
		this.outputIndex = null;
		this.address = null;
	}
}

export class Explorer {
	bc = new BlockchainComponent();
	modal = new ModalComponent();
	navigator = new Navigator();
	connector;

	/** @param {import('../connector.mjs').Connector} connector */
	constructor(connector) {
		this.connector = connector;
		this.#init();
	}

	// INTERNAL METHODS
	async #init() {
		if (!eHTML.isReady) console.log('Explorer awaiting DOM elements...');
		while (!eHTML.isReady) await new Promise(r => setTimeout(r, 200));

		console.log('Explorer DOM elements ready');
		this.bc.createEmptyBlocksUntilFillTheDiv();
		eHTML.get('maxSupply').textContent = CURRENCY.formatNumberAsCurrency(BLOCKCHAIN_SETTINGS.maxSupply);
		eHTML.get('targetBlocktime').textContent = `${BLOCKCHAIN_SETTINGS.targetBlockTime / 1000}s`;
		this.#setupListeners();
	}
	#setupListeners() {
		this.connector.on('consensus_height_change', this.#onConsensusHeightChange);
	}
	#onConsensusHeightChange = async (newHeight = 0) => {
		eHTML.get('chainHeight').textContent = newHeight.toString();

		const block = this.connector.blocks.finalized[this.connector.hash];
		if (!block) return;

		//console.log('Explorer: New consensus block:', block);
		const consensusMsgElement = eHTML.get('blockExplorerWaitingConsensusMessage');
		if (!this.connector.isConsensusRobust) consensusMsgElement.classList.add('show');
		else consensusMsgElement.classList.remove('show');

		const percent = ((block.supply + block.coinBase) / BLOCKCHAIN_SETTINGS.maxSupply * 100).toFixed(2);
		const readableLocalDate = new Date(block.timestamp).toLocaleString();
		const agoText = `${((block.timestamp - block.posTimestamp) / 1000).toFixed(2)}s`;
		eHTML.get('circulatingSupply').textContent = CURRENCY.formatNumberAsCurrency(block.supply + block.coinBase);
		eHTML.get('circulatingSupplyPercent').textContent = `~${percent}`;
		eHTML.get('lastBlocktime').textContent = `${readableLocalDate} (${agoText})`;

		const weight = this.connector.blockWeightByHash[block.hash] || 0;
		if (!this.bc.appendBlockIfCorresponding(block, weight)) this.bc.reset();

		// UNABLE TO COMPLETE THE CHAIN, REFRESH ALL BLOCKS SHOWN
		//await new Promise(r => setTimeout(r, 1000)); // wait a bit for the animation
		await this.#fillBlocksFromLastUntilEnough();
	}
	async #fillBlocksFromLastUntilEnough() {
		console.log('Explorer: Filling previous blocks until enough...');
		while(!this.bc.isEnoughBlocksFilled) {
			const firstBlock = this.bc.firstFilledBlock;
			if (!firstBlock?.prevHash) break;

			let prevBlock = this.connector.blocks.finalized[firstBlock.prevHash];
			if (!prevBlock) {
				const index = firstBlock.index ? firstBlock.index - 1 : -1;
				if (index < 0) break;

				const retrived = await this.connector.getMissingBlock(index, firstBlock.prevHash);
				if (!retrived) break;
				prevBlock = this.connector.blocks.finalized[firstBlock.prevHash];
			}

			const weight = this.connector.blockWeightByHash[prevBlock.hash] || 0;
			if (!this.bc.setPreviousBlockIfCorresponding(prevBlock, weight)) break;
		}
	}

	// HANDLERS METHODS
	// @ts-ignore
	clickHandler(e) {
		console.log('Explorer clickHandler:', e);
		if (!e.target.dataset.action) return;

		switch(e.target.dataset.action) {
			case 'display_block_details':
				this.displayBlockDetails(e.target);
				break;
			case 'hide_modal':
				this.modal.hide();
				break;
		}
	}

	// API METHODS
	/** @param {HTMLElement} blockElement */
	displayBlockDetails(blockElement) {
		const hash = blockElement.dataset.hash;
		const index = parseInt(blockElement.dataset.index || '-1');
		if (!hash || index < 0) return;

		const blockRect = blockElement.getBoundingClientRect();
        const blockCenter = { x: blockRect.left + blockRect.width / 2, y: blockRect.top + blockRect.height / 2 };
		this.navigator.blockHash = hash;
		this.navigator.blockIndex = index;
		
		if (!this.navigator.correspondToLastUsed) this.modal.destroy();
		else return this.modal.show(); // Block is already shown in the modal => do not recreate it

		this.modal.newContainer();
        this.modal.newContent(blockRect.width, blockRect.height, blockCenter);
		this.navigateUntilTarget();
	}
	async navigateUntilTarget() {
        let modalContentCreated = false;

        const { blockHash, blockIndex, txIndex, outputIndex, address } = this.navigator.getValuesAndReset();
        if (!address && blockIndex === null) // no target specified => abort
            { console.info('navigateUntilTarget => blockReference === null'); return }

        if (address) console.info('navigateUntilTarget =>', address);
        else console.info(`navigateUntilTarget => #${blockIndex}${txIndex !== null ? `:${txIndex}` : ''}${outputIndex !== null ? `:${outputIndex}` : ''}`);

    	/* ???
		const rebuildModal = txIndex !== null || outputIndex !== null || address;
        if (rebuildModal && this.cbeHTML.modalContainer()) { //TODO: to test
            this.cbeHTML.modalContainer().click();
            await new Promise((resolve) => { setTimeout(() => { resolve(); }, this.modal.animations.modalDuration); });
        }*/
        if (!this.modal.contentReady) { // CREATE MODAL FROM THE SEARCH BUTTON
			const searchMenuBtn = eHTML.get('searchMenuBtn');
			if (!searchMenuBtn) { console.error('navigateUntilTarget => error: searchMenuBtn not found'); return; }
			const searchMenuBtnRect = searchMenuBtn.getBoundingClientRect();
			const searchMenuBtnCenter = { x: searchMenuBtnRect.left + searchMenuBtnRect.width / 2, y: searchMenuBtnRect.top + searchMenuBtnRect.height / 2 };
			this.modal.newContainer();
			this.modal.newContent(searchMenuBtnRect.width, searchMenuBtnRect.height, searchMenuBtnCenter);
        }

        // if address is set, fill the modal content with address data
        //if (address) { this.#fillModalContentWithAddressData(address); return; }
		if (address) return; // TODO: address handling not implemented yet
        
        // fill the modal content with the block data
        if (blockHash === null || blockIndex === null) return;
		const blockData = this.connector.blocks.finalized[blockHash] || await this.connector.getMissingBlock(blockIndex, blockHash);
		if (!blockData) { console.info('navigateUntilTarget => error: blockData not found'); return; }

        this.modal.fillContentWithBlock(blockData, this.connector.blockWeightByHash[blockHash] || 0);
        return; // TODO: tx/output handling not implemented yet
		/*if (!txId) return;

        await new Promise((resolve) => { setTimeout(() => { resolve(); }, modalContentCreated ? 1000 : 200); });

        // wait for txs table to be filled
        await new Promise((resolve) => { setTimeout(() => { resolve(); }, 800); });
        // scroll to the tx line
        const modalContentWrap = this.cbeHTML.modalContentWrap();
        const txRow = this.#getTxRowElement(txId, modalContentWrap);
        if (!txRow) { console.error('navigateUntilTarget => error: txRow not found'); return; }

        const scrollDuration = this.modal.animations.modalDuration * 2;
        this.#scrollUntilVisible(txRow, modalContentWrap, scrollDuration);
        this.#blinkElementScaleY(txRow, 200, scrollDuration, () => { 
            txRow.click();
            if (outputIndex === null) return;

            const txDetails = this.cbeHTML.txDetails();
            if (!txDetails) { console.error('navigateUntilTarget => error: txDetails not found'); return; }
            const outputRow = txDetails.getElementsByClassName('cbe-TxOutput')[outputIndex];
            if (!outputRow) { console.error('navigateUntilTarget => error: outputRow not found'); return; }
            this.#scrollUntilVisible(outputRow, txDetails, scrollDuration);
            this.#blinkElementScaleY(outputRow, 200, scrollDuration, () => { outputRow.style.fontWeight = 'bold'; });
        });*/
    }
}