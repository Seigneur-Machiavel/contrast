// @ts-check
if (false) { // THIS IS FOR DEV ONLY ( to get better code completion)
	const anime = require('animejs');
    const Plotly = require('plotly.js-dist-min');
}

import { ADDRESS } from '../../types/address.mjs';
//import { UTXO } from '../../types/transaction.mjs';
import { eHTML_STORE } from '../board-helpers.js';
import { CURRENCY } from '../../utils/currency.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { ModalComponent } from './modal-component.js';
import { serializer } from '../../utils/serializer.mjs';
import { BlockchainComponent } from './blockchain-component.js';
import { BlocksTimesChartComponent, RoundLegitimaciesChartComponent } from './charts-component.js';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';

/**
* @typedef {import("../../types/block.mjs").BlockCandidateHeader} BlockCandidateHeader
* @typedef {import("../../types/block.mjs").BlockFinalizedHeader} BlockFinalizedHeader
* @typedef {import("../../types/block.mjs").BlockCandidate} BlockCandidate
* @typedef {import("../../types/block.mjs").BlockFinalized} BlockFinalized
* @typedef {import("../../types/transaction.mjs").Transaction} Transaction
* @typedef {import("../../types/transaction.mjs").UTXO} UTXO */

const eHTML = new eHTML_STORE('cbe-', 'maxSupply');
export class Navigator {
	/** @type {number | null} */	blockIndex = null;
	/** @type {number | null} */	txIndex = null;
	/** @type {number | null} */	outputIndex = null;
	/** @type {string | null} */	address = null;
	/** @type {any} */				lastUsed = null;

	get correspondToLastBlock() {
		if (!this.lastUsed) return false;
		if (this.blockIndex !== this.lastUsed.blockIndex) return false;
		return true;
	}
	get correspondToLastNavigation() {
		if (!this.lastUsed) return false;
		if (!this.correspondToLastBlock) return false;
		if (this.txIndex !== this.lastUsed.txIndex) return false;
		if (this.outputIndex !== this.lastUsed.outputIndex) return false;
		if (this.address !== this.lastUsed.address) return false;
		return true;
	}
	getValuesAndReset() {
		const {  blockIndex, txIndex, outputIndex, address } = this;
		this.lastUsed = { blockIndex, txIndex, outputIndex, address };
		this.reset();
		return { blockIndex, txIndex, outputIndex, address };
	}
	reset() {
		this.blockIndex = null;
		this.txIndex = null;
		this.outputIndex = null;
		this.address = null;
	}
}

export class Explorer {
	blocksTimesChart = new BlocksTimesChartComponent();
	roundLegitimaciesChart = new RoundLegitimaciesChartComponent();
	bc = new BlockchainComponent();
	modal = new ModalComponent();
	navigator = new Navigator();
	connector;

	/** @param {import('../connector.js').Connector} connector */
	constructor(connector) {
		this.connector = connector;
		this.connector.on('connection_established', () => setTimeout(this.getAndDisplayBlocksTimegaps, 2000));
		this.#initWhileDomReady();
	}

	// INTERNAL METHODS
	async #initWhileDomReady() {
		if (!eHTML.isReady) console.log('Explorer awaiting DOM elements...');
		while (!eHTML.isReady) await new Promise(r => setTimeout(r, 200));

		console.log('Explorer DOM elements ready');
		this.roundLegitimaciesChart.render(); // reset chart with 'loading' state
		this.bc.createEmptyBlocksUntilFillTheDiv();
		const [supply, targetTime] = [eHTML.get('maxSupply'), eHTML.get('targetBlocktime')];
		if (!supply || !targetTime) throw new Error('Explorer init error: required elements not found');
		
		supply.textContent = CURRENCY.formatNumberAsCurrency(BLOCKCHAIN_SETTINGS.maxSupply);
		targetTime.textContent = `${BLOCKCHAIN_SETTINGS.targetBlockTime / 1000}s`;
		this.connector.on('consensus_height_change', this.#onConsensusHeightChange);
	}
	#onConsensusHeightChange = async (newHeight = 0) => {
		const block = this.connector.blocks.finalized[this.connector.hash];
		if (!block) return;
		
		//console.log('Explorer: New consensus block:', block);
		this.roundLegitimaciesChart.render(); // reset chart with 'loading' state
		const consensusMsgElement = eHTML.get('blockExplorerWaitingConsensusMessage');
		if (!consensusMsgElement) throw new Error('Explorer: consensusMsgElement not found');
		if (!this.connector.isConsensusRobust) consensusMsgElement.classList.add('show');
		else consensusMsgElement.classList.remove('show');
		
		const percent = ((block.supply + block.coinBase) / BLOCKCHAIN_SETTINGS.maxSupply * 100).toFixed(2);
		const readableLocalDate = new Date(block.timestamp).toLocaleString();
		const agoText = `${((block.timestamp - block.posTimestamp) / 1000).toFixed(2)}s`;
		
		// @ts-ignore UPDATE CHAIN OVERVIEW ELEMENTS
		eHTML.get('chainHeight').textContent = newHeight.toString(); // @ts-ignore
		eHTML.get('circulatingSupply').textContent = CURRENCY.formatNumberAsCurrency(block.supply + block.coinBase); // @ts-ignore
		eHTML.get('circulatingSupplyPercent').textContent = `~${percent}`; // @ts-ignore
		eHTML.get('lastBlocktime').textContent = `${readableLocalDate} (${agoText})`;

		// UPDATE BLOCKCHAIN COMPONENT
		const weight = this.connector.blockWeightByHash[block.hash] || 0;
		if (!this.bc.appendBlockIfCorresponding(block, weight)) this.bc.reset();

		// UPDATE BLOCK TIMES CHART
		if (!this.blocksTimesChart.appendBlockTimeIfCorresponding(block.index, block.timestamp))
			this.getAndDisplayBlocksTimegaps(Math.max(0, newHeight - 60), newHeight);

		// UPDATE ROUND LEGITIMACIES CHART
		this.getAndDisplayRoundLegitimacies();

		// UNABLE TO COMPLETE THE CHAIN, REFRESH ALL BLOCKS SHOWN
		//await new Promise(r => setTimeout(r, 1000)); // wait a bit for the animation
		await this.#fillBlocksFromLastUntilEnough();
	}
	async #fillBlocksFromLastUntilEnough() {
		//console.log('Explorer: Filling previous blocks until enough...');
		while(!this.bc.isEnoughBlocksFilled) {
			const firstBlock = this.bc.firstFilledBlock;
			if (!firstBlock?.prevHash) break;

			let prevBlock = this.connector.blocks.finalized[firstBlock.prevHash];
			if (!prevBlock) {
				const index = firstBlock.index ? firstBlock.index - 1 : -1;
				if (index < 0) break;

				const retrived = await this.connector.getMissingBlock(index);
				if (!retrived) break;
				prevBlock = this.connector.blocks.finalized[firstBlock.prevHash];
			}

			const weight = this.connector.blockWeightByHash[prevBlock.hash] || 0;
			if (!this.bc.setPreviousBlockIfCorresponding(prevBlock, weight)) break;
		}
	}
	get blockBlowerRect() {
		const blockBlower = eHTML.get('blockBlower');
		if (!blockBlower) throw new Error('Explorer: blockBlower element not found');
		const blockBlowerRect = blockBlower.getBoundingClientRect();
		const blockBlowerCenter = { x: blockBlowerRect.left + blockBlowerRect.width / 2, y: blockBlowerRect.top + blockBlowerRect.height / 2 };
		return { rect: blockBlowerRect, center: blockBlowerCenter };
	}

	// HANDLERS METHODS
	// @ts-ignore
	clickHandler(e) {
		// console.log('Explorer clickHandler:', e);
		if (!e.target.dataset.action) return;
		
		const parent = e.target.parentElement;
		switch(e.target.dataset.action) {
			case 'display_block_details':
				this.displayBlock(e.target);
				break;
			case 'copy_block_hash': // TODO
				console.log('Copy block hash:', e.target.dataset.hash);
				break;
			case 'display_transaction_details':
				this.displayTransaction(parent.dataset.txId);
				break;
			case 'display_utxo_details':
				this.displayVout(e.target.dataset.anchor);
				break;
			case 'display_address_details':
				this.displayAddressDetails(e.target.dataset.address);
				break;
			case 'toggle_folder':
				const folderWrap = e.target.closest('.cbe-folderWrap');
                const arrowBtn = folderWrap.getElementsByClassName('.cbe-arrowBtn')[0]; // '▼' -> '▲'
				const isArrowDown = arrowBtn.textContent === '▼';
                arrowBtn.textContent = isArrowDown ? '▲' : '▼';

				const targetContent = isArrowDown ? folderWrap.querySelector('.cbe-folded') : folderWrap.querySelector('.cbe-unfolded');
                if (!targetContent) throw new Error('toggle_folder error: targetContent not found');

                targetContent.classList.remove(isArrowDown ? 'cbe-folded' : 'cbe-unfolded');
                targetContent.classList.add(isArrowDown ? 'cbe-unfolded' : 'cbe-folded');
				break;
			case 'hide_modal':
				this.modal.hide();
				break;
		}
	}
	// @ts-ignore
	keyUpHandler(e) {
		if (e.key !== 'Enter') return;

		const inputText = e.target.value.replace(/\s/g, '');
		const isNumber = !isNaN(inputText);
		const isAddress = ADDRESS.checkConformity(inputText);
		const isTxId = inputText.split(':').length === 2;
		const isAnchor = inputText.split(':').length === 3;

		if (isNumber) this.navigator.blockIndex = parseInt(inputText);
		if (isAddress) this.navigator.address = inputText;
		if (isTxId) {
			const { height, txIndex } = serializer.parseTxId(inputText);
			this.navigator.blockIndex = height;
			this.navigator.txIndex = txIndex;
		}
		if (isAnchor) {
			const { height, txIndex, vout } = serializer.parseAnchor(inputText);
			this.navigator.blockIndex = height;
			this.navigator.txIndex = txIndex;
			this.navigator.outputIndex = vout;
		}
		
		this.navigateUntilTarget(this.blockBlowerRect);
	}
	// @ts-ignore
	overHandler(e) {
		// console.log('Explorer overHandler:', e);
	}

	// API METHODS
	/** @param {HTMLElement} blockElement */
	displayBlock(blockElement) {
		const hash = blockElement.dataset.hash;
		const index = parseInt(blockElement.dataset.index || '-1');
		if (!hash || index < 0) return;

		this.navigator.blockIndex = index;

		const blockRect = blockElement.getBoundingClientRect();
		const blockCenter = { x: blockRect.left + blockRect.width / 2, y: blockRect.top + blockRect.height / 2 };
		this.navigateUntilTarget({ rect: blockRect, center: blockCenter });
	}
	/** @param {string} txId */
	displayTransaction(txId) {
		const txPointer = serializer.parseTxId(txId);
		this.navigator.blockIndex = txPointer.height;
		this.navigator.txIndex = txPointer.txIndex;
		this.navigateUntilTarget();
	}
	/** @param {string} anchor */
	displayVout(anchor) {
		const voutPointer = serializer.parseAnchor(anchor);
		this.navigator.blockIndex = voutPointer.height;
		this.navigator.txIndex = voutPointer.txIndex;
		this.navigator.outputIndex = voutPointer.vout;
		this.navigateUntilTarget();
	}
	/** @param {string} address */
	displayAddressDetails(address) {
		this.navigator.address = address;
		this.navigateUntilTarget();
	}
	async navigateUntilTarget(modalOrigin = this.blockBlowerRect) {
		if (!modalOrigin) throw new Error('navigateUntilTarget => error: modalOrigin is required');

		const correspondToLastNavigation = this.navigator.correspondToLastNavigation;
		const correspondToLastBlock = this.navigator.correspondToLastBlock;
        const { blockIndex, txIndex, outputIndex, address } = this.navigator.getValuesAndReset();
        if (!address && blockIndex === null) // no target specified => abort
            { console.info('navigateUntilTarget => blockReference === null'); return }

		// EARLY RETURN IF SAME NAVIGATION
		let modalContentCreated = false;
		if (correspondToLastNavigation) return this.modal.show(); // same => just show it
		if (correspondToLastBlock) this.modal.show(); // same => just show it
		if (address) console.info('navigateUntilTarget =>', address);
		else console.info(`navigateUntilTarget => #${blockIndex}${txIndex !== null ? `:${txIndex}` : ''}${outputIndex !== null ? `:${outputIndex}` : ''}`);
		
		// CLEAR PREVIOUS CONTENT IF ANY, OR CREATE NEW CONTENT
		if (!correspondToLastBlock)
			if (this.modal.isShown) this.modal.clearContentWrap();
			else {
				this.modal.newContainer();
				this.modal.newContent(modalOrigin.rect.width, modalOrigin.rect.height, modalOrigin.center);
			}

		// IF ADDRESS IS SPECIFIED => FILL THE MODAL WITH ADDRESS DATA
        if (address) {
			if (!ADDRESS.checkConformity(address)) throw new Error('navigateUntilTarget => error: invalid address format');
			const ledger = await this.connector.getAddressLedger(address);
			if (!ledger) throw new Error('navigateUntilTarget => error: ledger not found for address ' + address);
			this.modal.fillContentWithLedger(address, ledger);
			return;
		}
        
		// FILL THE MODAL WITH BLOCK DATA
        if (blockIndex === null) return;
		const blockData = await this.connector.getBlockRelatedToCurrentConsensus(blockIndex);
		if (!blockData) { console.info('navigateUntilTarget => error: blockData not found'); return; }

        if (!correspondToLastBlock) this.modal.fillContentWithBlock(blockData, this.connector.blockWeightByHash[blockData.hash] || 0);
		if (txIndex == null) return;

		const tx = blockData.Txs[txIndex];
		if (!tx) throw new Error('navigateUntilTarget => error: tx not found in block');

		setTimeout(() => this.modal.displayTransactionDetails(tx, txIndex, outputIndex), modalContentCreated ? 1000 : Math.round(220 + (blockData.Txs.length * .2)));
    }
	getAndDisplayBlocksTimegaps = async (fromHeight = 0, toHeight = this.connector.height) => {
		this.blocksTimesChart.reset();
		const f = Math.max(0, toHeight - 60);
		const tg = await this.connector.getBlocksTimestamps(fromHeight, toHeight);
		if (!tg) throw new Error('Explorer: getAndDisplayBlocksTimegaps => Unable to get blocks timestamps gaps');
		//console.log('Explorer: Retrieved blocks timestamps gaps:', tg);
		for (let i = 0; i < tg.heights.length; i++)
			this.blocksTimesChart.appendBlockTimeIfCorresponding(tg.heights[i], tg.timestamps[i]);
	}
	async getAndDisplayRoundLegitimacies() {
		const rl = await this.connector.getRoundsLegitimacies();
		if (!rl) throw new Error('Explorer: getAndDisplayRoundLegitimacies => Unable to get rounds legitimacies');
		if (rl.length === 0) return; // no data
		//console.log('Explorer: Retrieved rounds legitimacies:', rl);
		this.roundLegitimaciesChart.render(rl);
		
		const legHeightElement = eHTML.get('legHeight');
		if (legHeightElement) legHeightElement.textContent = this.connector.height.toString();
	}
}