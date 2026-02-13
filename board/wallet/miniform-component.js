// @ts-check
import { ADDRESS } from "../../types/address.mjs";
import { CURRENCY } from "../../utils/currency.mjs";
import { serializer } from "../../utils/serializer.mjs";
//import { TransactionDiagram } from './tx-diagram.js'; // PROTOTYPE, TO BE IMPLEMENTED LATER
import { Transaction_Builder } from "../../node/src/transaction.mjs";

/**
 * @typedef {import('../../types/transaction.mjs').Transaction} Transaction
 */

export class MiniformComponent {
	//txDiagram = new TransactionDiagram(document.getElementById('biw-diagram-wrapper'));
	biw;
	eHTML;

	/** @ts-ignore @returns {'Send' | 'Stake' | 'Unstake' | 'Inscribe'} */
	get action() { return this.eHTML.actionSelector.value; }
	get isDataFieldEnabled() { return this.eHTML.enableDataFieldCheckbox.checked; }
	get isOpen() { return this.eHTML.miniForm?.classList.contains('active'); }

	/** @param {import('./biw.js').BoardInternalWallet} biw */
	constructor(biw) {
		this.biw = biw;
		this.eHTML = {
			enableDataFieldCheckbox:	/** @type {HTMLInputElement} */ (biw.eHTML.get('enableDataFieldCheckbox')),
			container: 					/** @type {HTMLElement} */		(biw.eHTML.get('container')),
			wrap: 						/** @type {HTMLElement} */		(biw.eHTML.get('miniFormsWrap')),
			miniForm: 					/** @type {HTMLElement} */		(biw.eHTML.get('miniForm')),
			actionSelector: 			/** @type {HTMLSelectElement} */(biw.eHTML.get('actionSelector')),
			senderAddress: 				/** @type {HTMLElement} */		(biw.eHTML.get('senderAddress')),
			recipientAddress: 			/** @type {HTMLInputElement} */ (biw.eHTML.get('recipientAddress')),
			amountInput: 				/** @type {HTMLInputElement} */ (biw.eHTML.get('amountInput')),
			dataField:					/** @type {HTMLElement} */		(biw.eHTML.get('dataField')),
			dataInput: 					/** @type {HTMLInputElement} */ (biw.eHTML.get('dataInput')),
			txFee: 						/** @type {HTMLElement} */		(biw.eHTML.get('miniForm')?.querySelector('.biw-txFee')),
			totalSpent: 				/** @type {HTMLElement} */		(biw.eHTML.get('miniForm')?.querySelector('.biw-totalSpent')),
			sendBtn: 					/** @type {HTMLButtonElement} */(biw.eHTML.get('sendBtn')),
		};
	}

	// PUBLIC METHODS
	/** @param {'SEND' | 'STAKE' | 'UNSTAKE' | 'INSCRIBE' | string} action */
	open(action = 'SEND') {
		this.eHTML.miniForm.classList.add('active');
		this.eHTML.container.classList.add('expand');
		this.eHTML.actionSelector.value = action[0] + action.toLowerCase().slice(1);
		
		// SHOW OR HIDE DATA FIELD ACCORDING TO ACTION (Stake | Inscribe => always show)
		this.toggleDataField();
	}
	close() {
		this.eHTML.miniForm.classList.remove('active');
		this.eHTML.container.classList.remove('expand');
	}
	toggle() {
		this.eHTML.miniForm.classList.toggle('active');
	}
	toggleDataField(forceVisible = this.action === 'Inscribe' || this.action === 'Stake') {
		this.eHTML.dataInput.value = '';
		if (!forceVisible && !this.isDataFieldEnabled) this.eHTML.dataField.classList.add('hidden');
		else this.eHTML.dataField.classList.remove('hidden');
	}
	reset() {
		this.eHTML.recipientAddress.value = '';
		this.eHTML.amountInput.value = '';
		this.eHTML.txFee.innerText = '0';
		this.eHTML.totalSpent.innerText = '0';
		this.eHTML.dataInput.value = '';		
	}
	/** SET SENDER ADDRESS ACCORDING TO SELECTED ACCOUNT @param {string} address */
	setSenderAddress(address) {
		this.eHTML.senderAddress.innerText = address;

		if (this.action === 'Stake' || this.action === 'Unstake' || this.action === 'Inscribe')
			this.eHTML.recipientAddress.value = address;
	}
	/** @param {number} [amount] @param {string} [recipient] @param {string} [dataStr] */
	setValues(amount, recipient, dataStr) {
		// AMOUNT
		if (typeof amount === 'number') this.eHTML.amountInput.value = CURRENCY.formatNumberAsCurrency(amount);

		// RECIPIENT
		this.eHTML.recipientAddress.value = recipient || this.eHTML.senderAddress?.innerText;
		if (this.action === 'Stake' || this.action === 'Unstake' || this.action === 'Inscribe')
			this.eHTML.recipientAddress.value = this.eHTML.senderAddress?.innerText; // FORCE SENDER AS RECIPIENT

		// SHOW DATA FIELD IF dataStr IS PROVIDED, HIDE IT OTHERWISE
		this.toggleDataField(dataStr !== undefined);
		this.eHTML.dataInput.value = dataStr || '';
		this.prepareTxAccordingToInputsAndUpdateFees();
	}
	/** @returns {{ action: 'Send' | 'Stake' | 'Unstake' | 'Inscribe', amount: number, recipient: string | undefined, dataStr: string | undefined }} */
	getValues() {
		const amountStr = this.eHTML.amountInput.value;
		const recipient = this.eHTML.recipientAddress.value;
		const dataStr = this.isDataFieldEnabled ? this.eHTML.dataInput.value : undefined;
		return {
			action: this.action,
			amount: amountStr !== '' ? CURRENCY.formatCurrencyAsMicroAmount(amountStr) : 0,
			recipient: recipient !== '' ? recipient : undefined,
			dataStr: dataStr !== '' ? dataStr : undefined
		}
	}
	/** @returns {{ serialized: Uint8Array, signedTx: Transaction } | string }} */
	prepareTxAccordingToInputsAndUpdateFees() {
		this.eHTML.txFee.innerText = CURRENCY.formatNumberAsCurrency(0);
		this.eHTML.totalSpent.innerText = CURRENCY.formatNumberAsCurrency(0);

		const senderAccount = this.biw.activeAccount;
		const feePerByte = this.biw.standardFeePerByte.min;
		const { action, amount, recipient, dataStr } = this.getValues();
		if (!amount && !dataStr) return 'Amount or data field must be filled';

		const recipientAddress = recipient || senderAccount.address;
		if (!ADDRESS.checkConformity(recipientAddress)) return 'Invalid address';
		
		try {
			const { tx, finalFee, totalConsumed } = action === 'Stake' // PREPARE TX ON CLICK
				? Transaction_Builder.createStakingVss(senderAccount, amount, dataStr)
				: Transaction_Builder.createTransaction(senderAccount,
					amount ? [{ recipientAddress, amount }] : [], // don't add an empty output if amount is 0, to allow sending only data
					feePerByte,
					dataStr ? serializer.converter.textEncoder.encode(dataStr) : undefined
				);
			
				
			const signedTx = senderAccount.signTransaction(tx);
			const serialized = serializer.serialize.transaction(signedTx);

			// UPDATE FEES AND TOTAL IN THE UI
			this.eHTML.txFee.innerText = CURRENCY.formatNumberAsCurrency(finalFee);
			this.eHTML.totalSpent.innerText = CURRENCY.formatNumberAsCurrency(totalConsumed);
			return { serialized, signedTx };
		} catch (/** @type {any} */ error) { return error.message; }
	}
}