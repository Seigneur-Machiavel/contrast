
import { eHTML_STORE, createElement, getTimeSinceBlockConfirmedString } from '../board-helpers.js';
const eHTML = new eHTML_STORE('cbe-', 'chainWrap');


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
		this.blockSquare.dataset.action = 'display_block_details';
		this.blockSquare.dataset.hash = block.hash;
		this.blockSquare.dataset.index = block.index.toString();
		
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

export class BlockchainComponent {
	MAX_BLOCKS_FILLED = 2;
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
	get isEnoughBlocksFilled() { return this.numberOfFilledBlocks >= this.MAX_BLOCKS_FILLED; }

    /** @param {number} maxNbBlocks */
    createEmptyBlocksUntilFillTheDiv(maxNbBlocks = 16) {
        for (let i = 0; i < maxNbBlocks; i++) if (!this.#addEmptyBlockAtEndIfNeeded()) break;
    }
	/** @param {BlockFinalized} block */
    appendBlockIfCorresponding(block, weight = 0) {
		const lastFilled = this.lastFilledBlock;
		const isNextOfLast = lastFilled?.hash === block.prevHash;
		if (lastFilled && !isNextOfLast) return false;

		const filled = lastFilled
			? this.blocks[this.MAX_BLOCKS_FILLED]?.fill(block, weight)
			: this.blocks[this.MAX_BLOCKS_FILLED - 1]?.fill(block, weight);
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
		console.log('Resetting BlockchainComponent...');
		// REMOVE ALL BLOCK ELEMENTS
		for (const blockComponent of this.blocks) blockComponent.wrap.remove();
		this.blocks = [];

		// RECREATE EMPTY BLOCKS
		this.createEmptyBlocksUntilFillTheDiv();
	}

	#pruneBlockIfNeeded() {
		// IF INDEX OF LAST FILLED BLOCK > MAX, SUCK THE FIRST ONE, THEN ADD A NEW EMPTY BLOCK AT THE END
		const index = this.numberOfFilledBlocks + (this.blocks[0]?.isFilled ? 0 : 1);
		if (index <= this.MAX_BLOCKS_FILLED) return;
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