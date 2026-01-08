// @ts-check
if (false) { // THIS IS FOR DEV ONLY ( to get better code completion)
	const anime = require('animejs');
    const Plotly = require('plotly.js-dist-min');
}

//import { StakeReference } from '../src/vss.mjs';
import { ADDRESS } from '../../types/address.mjs';
//import { UTXO } from '../../types/transaction.mjs';
import { CURRENCY } from '../../utils/currency.mjs';
import { IS_VALID } from '../../types/validation.mjs';
import { createElement } from '../generic-helpers.mjs';
import { Transaction_Builder } from '../../node/src/transaction.mjs';
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

const CONFIG = {
	MAX_BLOCKS_FILLED: 2,
}

function getTimeSinceBlockConfirmedString(timestamp = 0) {
    const minuteSince = Math.floor((Date.now() - timestamp) / 60000);
    if (minuteSince >= 1) return `~${minuteSince} min ago`;

    const secondsSince = Math.floor((Date.now() - timestamp) / 1000);
    return `~${secondsSince} s ago`;
}

class eHTML {
	/** @type {Object<string, HTMLElement>} */
	static elements = {};
	static get isReady() { return !!document.getElementById('cbe-maxSupply'); }

	/** @param {string} id */
	static get(id, prefix = 'cbe-') {
		const e = this.elements[id] || document.getElementById(prefix + id);
		if (!e) throw new Error(`Element with id "${id}" not found`);
		this.elements[id] = e; // store for future use
		return e;
	}
	/** @param {HTMLElement} element @param {string} id */
	static add(element, id) {
		element.id = id;
		this.elements[id] = element;
	}
}

export class Explorer {
	bcElmtsManager = new BlockChainElementsManager();

	/** @param {import('../connector.mjs').Connector} connector */
	constructor(connector) {
		this.connector = connector;
		this.#init();
	}

	async #init() {
		if (!eHTML.isReady) console.log('Explorer awaiting DOM elements...');
		while (!eHTML.isReady) await new Promise(r => setTimeout(r, 200));

		console.log('Explorer DOM elements ready');
		this.bcElmtsManager.createChainOfEmptyBlocksUntilFillTheDiv();
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
		if (!this.bcElmtsManager.appendBlockIfCorresponding(block, weight))
			this.bcElmtsManager.reset();

		// UNABLE TO COMPLETE THE CHAIN, REFRESH ALL BLOCKS SHOWN
		//await new Promise(r => setTimeout(r, 1000)); // wait a bit for the animation
		await this.#fillBlocksFromLastUntilEnough();
	}
	async #fillBlocksFromLastUntilEnough() {
		while(!this.bcElmtsManager.isEnoughBlocksFilled) {
			const firstBlock = this.bcElmtsManager.firstFilledBlock;
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
			if (!this.bcElmtsManager.setPreviousBlockIfCorresponding(prevBlock, weight)) break;
		}
	}
}

class BlockComponent {
	wrap; blockSquare; miniHash; blockIndex;
	weight; timeAgo; nbTx;
	
	isFilled = false;
	/** @type {string | null} */ prevHash = null;
	/** @type {string | null} */ hash = null;
	/** @type {number | null} */ index = null;
	/** @type {number | null} */ timestamp = null;

	constructor() {
		this.wrap = createElement('div', ['cbe-blockWrap']);
		this.blockSquare = createElement('div', ['cbe-blockSquare'], this.wrap);
		this.miniHash = createElement('div', ['cbe-blockMiniHash'], this.blockSquare);
		this.blockIndex = createElement('div', ['cbe-blockIndex'], this.blockSquare);
		this.weight = createElement('div', ['cbe-weight'], this.blockSquare);
		this.timeAgo = createElement('div', ['cbe-timeAgo'], this.blockSquare);
		this.nbTx = createElement('div', ['cbe-nbTx'], this.blockSquare);

		this.miniHash.textContent = this.#splitHash('................................................................', 16).join(' ');
		this.blockIndex.textContent = '#...';
		this.weight.textContent = '... KB';
		this.timeAgo.textContent = `...`;
		this.nbTx.textContent = '... transactions';
	}

	/** @param {BlockFinalized} block @param {number} weight */
	fill(block, weight = 0) {
		this.prevHash = block.prevHash;
		this.hash = block.hash;
		this.index = block.index;
		this.timestamp = block.timestamp;
		this.miniHash.textContent = this.#splitHash(block.hash, 16).join(' ');
		this.blockIndex.textContent = `#${block.index}`;
		this.weight.textContent = `${(weight / 1024).toFixed(2)} KB`;
		this.timeAgo.textContent = getTimeSinceBlockConfirmedString(block.timestamp);
		this.nbTx.textContent = `${block.Txs.length} transactions`;
		this.blockSquare.classList.add('filled');
		this.isFilled = true;
		return true;
	}
	updateTimeAgo() {
		if (!this.timestamp) return;
		this.timeAgo.textContent = getTimeSinceBlockConfirmedString(this.timestamp);
	}
	/** @param {string} hash @param {number} nbOfCharsPerLine Default: 16 */
    #splitHash(hash, nbOfCharsPerLine = 16) {
        const hashSplitted = [];
        for (let i = 0; i < hash.length; i += nbOfCharsPerLine)
            hashSplitted.push(hash.slice(i, i + nbOfCharsPerLine));

        return hashSplitted;
    }
}

class BlockChainElementsManager {
	/** @type {BlockComponent[]} */				blocks = [];
	/** @type {anime.AnimeInstance | null} */	firstBlockAnimation = null;
	/** @type {anime.AnimeInstance | null} */	chainWrapAnimation = null;
	timeAgoUpdatesInterval = setInterval(() => {
		for (const blockComponent of this.blocks) blockComponent.updateTimeAgo();
	}, 1000); // every second

	get numberOfFilledBlocks() { return this.blocks.filter(block => block.isFilled).length; }
	get firstFilledBlock() { return this.blocks.find(block => block.isFilled) || null; }
	get firstEmptyBlock() { return this.blocks.find(block => !block.isFilled) || null; }
	get lastFilledBlock() { return [...this.blocks].reverse().find(block => block.isFilled) || null; }
	get lastEmptyBlock() { return [...this.blocks].reverse().find(block => !block.isFilled) || null; }
	get isEnoughBlocksFilled() { return this.numberOfFilledBlocks >= CONFIG.MAX_BLOCKS_FILLED; }

    /** @param {number} maxNbBlocks */
    createChainOfEmptyBlocksUntilFillTheDiv(maxNbBlocks = 16) {
        for (let i = 0; i < maxNbBlocks; i++) if (!this.#addEmptyBlockAtEndIfNeeded()) break;
    }
	/** @param {BlockFinalized} block */
    appendBlockIfCorresponding(block, weight = 0) {
		const lastFilled = this.lastFilledBlock;
		const isNextOfLast = lastFilled?.hash === block.prevHash;
		if (lastFilled && !isNextOfLast) return false;

		const filled = lastFilled
			? this.blocks[CONFIG.MAX_BLOCKS_FILLED]?.fill(block, weight)
			: this.blocks[CONFIG.MAX_BLOCKS_FILLED - 1]?.fill(block, weight);
		if (!filled) return false;
		
		this.#pruneBlockIfNeeded();
		return true;
    }
	/** @param {BlockFinalized} block */
	setPreviousBlockIfCorresponding(block, weight = 0) {
		console.log('Trying to set previous block:', block);
		if (this.isEnoughBlocksFilled || !this.firstFilledBlock) return false;

		const isPreviousOfFirst = this.firstFilledBlock.prevHash === block.hash;
		if (!isPreviousOfFirst) return false;
		console.log('Setting previous block:', block);
		return this.firstEmptyBlock?.fill(block, weight);
	}
    getCorrespondingBlockElement(blockHeight = 0) {
		for (const blockComponent of this.blocks) {
			const blockIndexText = blockComponent.blockIndex.textContent;
			if (blockIndexText === `#${blockHeight}`) return blockComponent;
		}
	}
    getNumberOfConfirmedBlocksShown() {
		let count = 0;
		for (const blockComponent of this.blocks)
			if (blockComponent.blockIndex.textContent !== '#...') count++;
		return count;
	}
	reset() {
		console.log('Resetting BlockChainElementsManager...');
		// REMOVE ALL BLOCK ELEMENTS
		for (const blockComponent of this.blocks) blockComponent.wrap.remove();
		this.blocks = [];

		// RECREATE EMPTY BLOCKS
		this.createChainOfEmptyBlocksUntilFillTheDiv();
	}

	#pruneBlockIfNeeded() {
		// IF MORE THAN 3 BLOCKS ARE SHOWN, SUCK THE FIRST ONE, THEN ADD A NEW EMPTY BLOCK AT THE END
		if (this.numberOfFilledBlocks <= CONFIG.MAX_BLOCKS_FILLED) return;
		this.#suckFirstBlockElement();
	}
	#addEmptyBlockAtEndIfNeeded() {
		// ADD NEW EMPTY BLOCK AT THE END IF NEEDED
		const parentRect = eHTML.get('chainWrap').parentElement?.parentElement?.getBoundingClientRect();
		if (!parentRect) return;
		
		const lastEmptyBlockRight = this.lastEmptyBlock?.wrap.getBoundingClientRect().right || 0;
		if (lastEmptyBlockRight >= parentRect.right) return;

		const newBlock = new BlockComponent();
		this.blocks.push(newBlock);
		eHTML.get('chainWrap').appendChild(newBlock.wrap);
		return true;
	}
    /** @param {number} duration */
    #suckFirstBlockElement(duration = 1000) {
		const chainWrap = eHTML.get('chainWrap');
		if (!chainWrap) return;
        
        // suck the first block
        this.firstBlockAnimation = anime({
            targets: this.blocks[0].wrap,
            translateX: '-100%',
            filter: 'blur(6px)',
            width: 0,
            scale: 0.5,
            opacity: 0,
            duration,
            easing: 'easeInOutQuad',
            begin: () => {
                chainWrap.style.width = `${chainWrap.getBoundingClientRect().width}px`; // lock the width of the wrap
            },
            complete: () => {
                this.#removeFirstBlockElement();
				this.#addEmptyBlockAtEndIfNeeded();
                chainWrap.style.width = 'auto'; // unlock the width of the wrap
            }
        });
        
        // blur the wrap
        this.chainWrapAnimation = anime({
            targets: chainWrap,
            filter: ['blur(.6px)', 'blur(.5px)', 'blur(.6px)'],
            duration: duration - 200,
            complete: () => { 
                anime({
                    targets: chainWrap,
                    filter: 'blur(0px)',
                    duration: 400,
                    easing: 'easeInOutQuad',
                });
            }
        });
    }
    #removeFirstBlockElement() {
		if (!this.blocks.length) return;
		this.blocks[0].wrap.remove();
		this.blocks.shift();
    }
}