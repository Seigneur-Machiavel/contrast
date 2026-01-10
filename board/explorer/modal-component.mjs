import { CURRENCY } from '../../utils/currency.mjs';
import { serializer } from '../../utils/serializer.mjs';
import { Transaction_Builder } from '../../node/src/transaction.mjs';
import { BlockFinalized } from '../../types/block.mjs';
import { eHTML_STORE, createElement, createSpacedTextElement } from '../board-helpers.mjs';

const eHTML = new eHTML_STORE('cbe-', 'maxSupply');

export class ModalComponent {
	animations = {
		modalDuration: 200,
		modalContainerAnim: null,
		modalContentWrapScrollAnim: null,
		modalContentSizeAnim: null,
		modalContentPositionAnim: null,
	};
	widthPerc = .9;
	heightPerc = .9;
	get containerReady() { return !!eHTML.get('modalContainer', 'cbe-', false); }
	get contentReady() { return !!eHTML.get('modalContent', 'cbe-', false); }
	hide() { eHTML.get('modalContainer', 'cbe-', false)?.classList.remove('show'); }
	show() { eHTML.get('modalContainer', 'cbe-', false)?.classList.add('show'); }
	destroy() { eHTML.get('modalContainer', 'cbe-', false)?.remove(); }

	newContainer() {
		const explorerContentDiv = eHTML.get('contrastBlocks').parentElement.parentElement;
        const container = createElement('div', ['show'], explorerContentDiv);
		container.id = 'cbe-modalContainer';
		container.dataset.action = 'hide_modal';
		container.style.backdropFilter = 'blur(0px)';
        
        this.animations.modalContainerAnim = anime({
            targets: container,
            backdropFilter: 'blur(2px)',
            duration: this.animations.modalDuration * .4,
            delay: this.animations.modalDuration,
            easing: 'easeInOutQuad',
        });
    }
    /** @param {number} fromWidth @param {number} fromHeight @param {{ x: number, y: number }} fromPosition */
    newContent(fromWidth, fromHeight, fromPosition) {
		const container = eHTML.get('modalContainer');
        if (!container) { console.error('newModalContent() error: modalContainer not found'); return; }

		const content = createElement('div', [], container);
		content.id = 'cbe-modalContent';
		createElement('div', [], content).id = 'cbe-modalContentWrap';

        const containerRect = container.getBoundingClientRect();
        const finalWidth = `${this.widthPerc * containerRect.width}px`;
        const finalHeight = `${this.heightPerc * containerRect.height}px`;
        const contentPadding = Number(getComputedStyle(content).padding.replace('px', ''));
        const startWidth = `${fromWidth - (contentPadding * 2)}px`;
        const startHeight = `${fromHeight - (contentPadding * 2)}px`;
        content.style.width = startWidth;
        content.style.height = startHeight;
        content.style.left = `${fromPosition.x}px`;
        content.style.top = `${fromPosition.y}px`;
        content.style.opacity = 1;

        this.animations.modalContentPositionAnim = anime({
            targets: content,
            left: `${containerRect.width / 2}px`,
            top: `${containerRect.height / 2}px`,
            duration: this.animations.modalDuration,
            delay: this.animations.modalDuration,
            easing: 'easeInOutQuad',
        });
        this.animations.modalContentSizeAnim = anime({
            targets: content,
            width: finalWidth,
            height: finalHeight,
            duration: this.animations.modalDuration,
            delay: this.animations.modalDuration * 1.6,
            easing: 'spring(.8, 80, 20, -100)',
        });
    }
	/** @param {BlockFinalized} block */
	fillContentWithBlock(block, weight = 0) {
		const [modalContent, contentWrap] = [eHTML.get('modalContent'), eHTML.get('modalContentWrap')];
        if (!modalContent || !contentWrap) { console.error('error: modalContent or modalContentWrap not found'); return; }
        modalContent.classList.add('cbe-blockContent');

        // spacing the contentWrap to avoid the fixedTopElement to hide the content
        const fixedTopElement = createSpacedTextElement(block.hash, ['cbe-blockHash'], `#${block.index}`, ['cbe-blockIndex'], contentWrap);
        const twoContainerWrap = createElement('div', ['cbe-twoContainerWrap'], contentWrap);
		const leftContainer = createElement('div', ['cbe-leftContainer'], twoContainerWrap);
		//createSpacedTextElement('Supply', [], `${CURRENCY.formatNumberAsCurrency(block.supply)}`, [], leftContainer);
        contentWrap.style = 'margin-top: 56px; padding-top: 0; height: calc(100% - 76px);';
        fixedTopElement.classList.add('cbe-fixedTop');
        
		const rewards = BlockFinalized.calculateRewards(block);
        const readableLocalDate = new Date(block.timestamp).toLocaleString();
        createSpacedTextElement('Date', [], readableLocalDate, [], leftContainer);
        createSpacedTextElement('Size', [], `${(weight / 1024).toFixed(2)} KB`, [], leftContainer);
        createSpacedTextElement('Transactions', [], `${block.Txs.length}`, [], leftContainer);
        
        const minerAddressElmnt = createSpacedTextElement('Miner', [], '', [], leftContainer);
        const minerAddressSpanElmnt = createElement('span', ['cbe-addressSpan'], minerAddressElmnt.children[1]);
        minerAddressSpanElmnt.textContent = BlockFinalized.minerAddress(block);

        const validatorAddressElmnt = createSpacedTextElement('Validator', [], '', [], leftContainer);
        const validatorAddressSpanElmnt = createElement('span', ['cbe-addressSpan'], validatorAddressElmnt.children[1]);
        validatorAddressSpanElmnt.textContent = BlockFinalized.validatorAddress(block);
        
        const rightContainer = createElement('div', ['cbe-rightContainer'], twoContainerWrap);
        createSpacedTextElement('Legitimacy', [], block.legitimacy, [], rightContainer);
        createSpacedTextElement('CoinBase', [], `${CURRENCY.formatNumberAsCurrency(block.coinBase)}`, [], rightContainer);
    	createSpacedTextElement('Total fees', [], `${CURRENCY.formatNumberAsCurrency(rewards.totalFees)}`, [], rightContainer);
        createSpacedTextElement('Miner reward', [], `${CURRENCY.formatNumberAsCurrency(rewards.powReward)}`, [], rightContainer);
        createSpacedTextElement('Validator reward', [], `${CURRENCY.formatNumberAsCurrency(rewards.posReward)}`, [], rightContainer);
        
        this.#newTransactionsTable(block, ['cbe-TxsTable', 'cbe-Table'], contentWrap);
	}
	/** @param {BlockFinalized} block @param {string[]} tableClasses @param {HTMLElement} divToInject */
    #newTransactionsTable(block, tableClasses, divToInject) {
        const table = createElement('table', tableClasses, divToInject);
		const thread = createElement('thead', [], table);
        const headerRow = createElement('tr', [], thread);
        const headers = ['Index', 'Transaction id', 'Total amount spent', '(bytes) Weight'];
        for (const headerText of headers) createElement('th', [], headerRow).textContent = headerText;

		const tbody = createElement('tbody', [], table);
        setTimeout(() => { 
            for (let i = 0; i < block.Txs.length; i++) {
                const tx = block.Txs[i];
                const delay = Math.min(i * 10, 600);
                setTimeout(() => this.#newTransactionOfTable(block.index, i, tx, tbody), delay);
            }
        }, 600);
    }
	/** @param {number} blockIndex @param {number} txIndex @param {Transaction} tx @param {HTMLElement} tbodyDiv */
    #newTransactionOfTable(blockIndex, txIndex, tx, tbodyDiv) {
        const outputsAmount = tx.outputs.reduce((a, b) => a + b.amount, 0);
        const specialTx = txIndex < 2 ? Transaction_Builder.isMinerOrValidatorTx(tx) : false;
		const s = serializer.serialize.transaction(tx, specialTx);
		const row = createElement('tr', ['cbe-TxRow'], tbodyDiv);
		let indexText = txIndex.toString();
		if (specialTx === 'miner') indexText = `${txIndex} (CoinBase)`;
		else if (specialTx === 'validator') indexText = `${txIndex} (Validator)`;

		createElement('td', [], row).textContent = indexText;
        createElement('td', [], row).textContent = `${blockIndex}:${txIndex}`;
        createElement('td', [], row).textContent = `${CURRENCY.formatNumberAsCurrency(outputsAmount)} c`;
        createElement('td', [], row).textContent = `${s.byteLength} B`;
    }
}