// @ts-check
//import { eHTML_STORE, createElement, createSpacedTextElement } from '../board-helpers.js';
import { CURRENCY } from "../../utils/currency.mjs";
import { Transaction_Builder } from "../../node/src/transaction.mjs";

export class MiniformComponent {
	biw;
	eHTML = {
		enableDataFieldCheckbox: document.getElementById('biw-enableDataFieldCheckbox'),
		container: 			document.getElementById('biw-container'),
		wrap: 				document.getElementById('biw-miniFormsWrap'),
		miniForm: 			document.getElementById('biw-miniForm'),
		actionSelector: 	document.getElementById('biw-miniForm')?.querySelector('.biw-actionSelector'),
		senderAddress: 		document.getElementById('biw-senderAddress'),
		recipientAddress: 	document.getElementById('biw-recipientAddress'),
		amountInput: 		document.getElementById('biw-miniForm')?.querySelector('.biw-amountInput'),
		dataInput: 			document.getElementById('biw-miniForm')?.querySelector('.biw-dataInput'),
		txFee: 				document.getElementById('biw-miniForm')?.querySelector('.biw-txFee'),
		totalSpent: 		document.getElementById('biw-miniForm')?.querySelector('.biw-totalSpent'),
		confirmBtn: 		document.getElementById('biw-miniForm')?.querySelector('.biw-confirmBtn'),
	}
	/** @ts-ignore @returns {'Send' | 'Stake' | 'Unstake' | 'Inscribe'} */
	get action() { return this.eHTML.actionSelector?.value; } // @ts-ignore
	get isDataFieldEnabled() { return this.eHTML.enableDataFieldCheckbox?.checked; }

	/** @param {import('./biw.js').BoardInternalWallet} biw */
	constructor(biw) { this.biw = biw; }

	// PUBLIC METHODS
	isExpanded() { return this.eHTML.miniForm?.classList.contains('active'); }
	/** @param {'SEND' | 'STAKE' | 'UNSTAKE' | 'INSCRIBE'} action */
	open(action = 'SEND') {
		if (!this.eHTML.miniForm || !this.eHTML.container) throw new Error('MiniformComponent.open: miniForm or container element not found');
		if (!this.eHTML.actionSelector) throw new Error('MiniformComponent.open: actionSelector element not found');
		this.eHTML.miniForm.classList.add('active');
		this.eHTML.container.classList.add('expand'); // @ts-ignore
		this.eHTML.actionSelector.value = action[0] + action.toLowerCase().slice(1);
	}
	close() {
		if (!this.eHTML.miniForm || !this.eHTML.container) throw new Error('MiniformComponent.close: miniForm or container element not found');
		this.eHTML.miniForm.classList.remove('active');
		this.eHTML.container.classList.remove('expand');
	}
	reset() {
		if (!this.eHTML.recipientAddress) throw new Error('MiniformComponent.reset: recipientAddress element not found');
		if (!this.eHTML.amountInput) throw new Error('MiniformComponent.reset: amountInput element not found');
		if (!this.eHTML.txFee) throw new Error('MiniformComponent.reset: txFee element not found');
		if (!this.eHTML.totalSpent) throw new Error('MiniformComponent.reset: totalSpent element not found'); // @ts-ignore
		this.eHTML.recipientAddress.value = ''; // @ts-ignore
		this.eHTML.amountInput.value = '';		// @ts-ignore
		this.eHTML.txFee.innerText = '0c';		// @ts-ignore
		this.eHTML.totalSpent.innerText = '0c';
	}
	toggle() { // @ts-ignore
		this.eHTML.miniForm?.classList.toggle('active');
	}
	/** @param {number} [amount] @param {string} [recipient] @param {string} [dataStr] */
	setValues(amount, recipient, dataStr) {
		// @ts-ignore AMOUNT
		if (typeof amount === 'number') this.eHTML.amountInput.value = CURRENCY.formatNumberAsCurrency(amount);

		// @ts-ignore RECIPIENT
		this.eHTML.recipientAddress.value = recipient || this.eHTML.senderAddress?.innerText;
		if (this.action === 'Stake' || this.action === 'Unstake' || this.action === 'Inscribe') // @ts-ignore
			this.eHTML.recipientAddress.value = this.eHTML.senderAddress?.innerText; // FORCE SENDER AS RECIPIENT

		// @ts-ignore DATA
		if (!dataStr && this.isDataFieldEnabled) this.eHTML.dataInput.classList.remove('active');
		else { 												// @ts-ignore
			this.eHTML.dataInput.value = dataStr || ''; 	// @ts-ignore
			this.eHTML.dataInput.classList.add('active');
		}

		this.updateFeesAndTotalAccordingToInputs();
	}
	/** @param {string} address */
	setSenderAddress(address) {
		if (!this.eHTML.senderAddress) throw new Error('MiniformComponent.setSenderAddress: senderAddress element not found');

		// @ts-ignore SET SENDER ADDRESS ACCORDING TO SELECTED ACCOUNT
		this.eHTML.senderAddress.innerText = address;

		if (this.action === 'Stake' || this.action === 'Unstake' || this.action === 'Inscribe') // @ts-ignore
			this.eHTML.recipientAddress.value = address;
	}
	updateFeesAndTotalAccordingToInputs() { // TO UPDATE
		// @ts-ignore
        const amountMicro = CURRENCY.formatCurrencyAsMicroAmount(this.eHTML.amountInput.value); // @ts-ignore
        this.eHTML.amountInput.value = CURRENCY.formatNumberAsCurrency(amountMicro);

        //let totalSpentMicro = amountMicro; // @ts-ignore
        //const fee += parseInt(this.eHTML.txFee.innerText.replace('.',''));
		let feeMicro = 0;
		if (this.action === 'Stake') feeMicro += amountMicro;
        else if (this.action === 'Send') // TODO
			console.log('Send fee calculation to be implemented');
			// feeMicro += Transaction_Builder.calculateFeeAndChange();
        
		const totalSpentMicro = feeMicro + amountMicro; // @ts-ignore FEE AND TOTAL
		this.eHTML.txFee.innerText = window.convert.formatNumberAsCurrency(totalSpentMicro - amountMicro); // @ts-ignore
        this.eHTML.totalSpent.innerText = window.convert.formatNumberAsCurrency(totalSpentMicro);
    }
}