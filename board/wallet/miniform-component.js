// @ts-check
import { ADDRESS } from "../../types/address.mjs";
import { CURRENCY } from "../../utils/currency.mjs";
import { serializer } from "../../utils/serializer.mjs";
//import { TransactionDiagram } from './tx-diagram.js'; // PROTOTYPE, TO BE IMPLEMENTED LATER
import { Transaction_Builder } from "../../node/src/transaction.mjs";
import { createSpacedTextElement } from "../board-helpers.js";

/**
 * @typedef {import('../../types/transaction.mjs').Transaction} Transaction
 * @typedef {import('../../types/transaction.mjs').TxId} TxId
 */

export class MiniformComponent {
	//txDiagram = new TransactionDiagram(document.getElementById('biw-diagram-wrapper'));
	biw;
	eHTML;

	/** @ts-ignore @returns {'Send' | 'Stake' | 'Unstake' | 'Inscribe'} */
	get action() { return this.eHTML.transfer.actionSelector.value; }
	get isDataFieldEnabled() { return this.eHTML.enableDataFieldCheckbox.checked; }
	get isTransferOpen() { return this.eHTML.transfer.miniForm?.classList.contains('active'); }
	get isHistoryOpen() { return this.eHTML.history.historyForm?.classList.contains('active'); }

	/** @param {import('./biw.js').BoardInternalWallet} biw */
	constructor(biw) {
		this.biw = biw;
		this.eHTML = {
			enableDataFieldCheckbox:	/** @type {HTMLInputElement} */ (biw.eHTML.get('enableDataFieldCheckbox')),
			container: 					/** @type {HTMLElement} */		(biw.eHTML.get('container')),
			wrap: 						/** @type {HTMLElement} */		(biw.eHTML.get('miniFormsWrap')),

			// TRANSFER FORM
			transfer: {
				miniForm: 					/** @type {HTMLElement} */		(biw.eHTML.get('miniFormTransfer')),
				actionSelector: 			/** @type {HTMLSelectElement} */(biw.eHTML.get('actionSelector')),
				senderAddress: 				/** @type {HTMLElement} */		(biw.eHTML.get('TransferSenderAddress')),
				recipientAddress: 			/** @type {HTMLInputElement} */ (biw.eHTML.get('recipientAddress')),
				amountInput: 				/** @type {HTMLInputElement} */ (biw.eHTML.get('amountInput')),
				dataField:					/** @type {HTMLElement} */		(biw.eHTML.get('dataField')),
				dataInput: 					/** @type {HTMLInputElement} */ (biw.eHTML.get('dataInput')),
				txFee: 						/** @type {HTMLElement} */		(biw.eHTML.get('miniFormTransfer')?.querySelector('.biw-txFee')),
				totalSpent: 				/** @type {HTMLElement} */		(biw.eHTML.get('miniFormTransfer')?.querySelector('.biw-totalSpent')),
				sendBtn: 					/** @type {HTMLButtonElement} */(biw.eHTML.get('sendBtn'))
			},

			// HISTORY FORM
			history: {
				historyForm: 				/** @type {HTMLElement} */		(biw.eHTML.get('miniFormHistory')),
				senderAddress: 				/** @type {HTMLElement} */		(biw.eHTML.get('historySenderAddress')),
				sentButton: 				/** @type {HTMLButtonElement} */(biw.eHTML.get('historySentBtn')),
				receivedButton: 			/** @type {HTMLButtonElement} */(biw.eHTML.get('historyReceivedBtn')),
				allButton: 					/** @type {HTMLButtonElement} */(biw.eHTML.get('historyAllBtn')),
				list: 						/** @type {HTMLElement} */		(biw.eHTML.get('historyList')),
				//pagination: 				/** @type {HTMLElement} */		(biw.eHTML.get('historyPagination')),
				//currentPage: 				/** @type {HTMLElement} */		(biw.eHTML.get('historyCurrentPage')),
				prevPageBtn: 				/** @type {HTMLButtonElement} */(biw.eHTML.get('historyPrevPageBtn')),
				nextPageBtn: 				/** @type {HTMLButtonElement} */(biw.eHTML.get('historyNextPageBtn'))
			}
		};
	}

	// PUBLIC METHODS
	/** @param {'SEND' | 'STAKE' | 'UNSTAKE' | 'INSCRIBE' | 'HISTORY' | string} action */
	open(action = 'SEND') {
		this.eHTML.history.historyForm.classList.remove('active');
		this.eHTML.transfer.miniForm.classList.remove('active');
		this.eHTML.container.classList.add('expand');

		if (action === 'HISTORY') this.eHTML.history.historyForm.classList.add('active');
		else {
			this.eHTML.transfer.miniForm.classList.add('active');
			this.eHTML.transfer.actionSelector.value = action[0] + action.toLowerCase().slice(1);
		}
		
		// SHOW OR HIDE DATA FIELD ACCORDING TO ACTION (Stake | Inscribe => always show)
		this.toggleDataField();
	}
	close() {
		this.eHTML.transfer.miniForm.classList.remove('active');
		this.eHTML.history.historyForm.classList.remove('active');
		this.eHTML.container.classList.remove('expand');
	}
	
	// TRANSFER FORM METHODS
	toggleDataField(forceVisible = this.action === 'Inscribe' || this.action === 'Stake') {
		this.eHTML.transfer.dataInput.value = '';
		if (!forceVisible && !this.isDataFieldEnabled) this.eHTML.transfer.dataField.classList.add('hidden');
		else this.eHTML.transfer.dataField.classList.remove('hidden');
	}
	resetTransferForm() {
		this.eHTML.transfer.recipientAddress.value = '';
		this.eHTML.transfer.amountInput.value = '';
		this.eHTML.transfer.txFee.innerText = '0';
		this.eHTML.transfer.totalSpent.innerText = '0';
		this.eHTML.transfer.dataInput.value = '';
	}
	/** SET SENDER ADDRESS ACCORDING TO SELECTED ACCOUNT @param {string} address */
	setSenderAddress(address) {
		this.eHTML.transfer.senderAddress.innerText = address;
		this.eHTML.history.senderAddress.innerText = address;

		if (this.action === 'Stake' || this.action === 'Unstake' || this.action === 'Inscribe')
			this.eHTML.transfer.recipientAddress.value = address;
	}
	/** @param {number} [amount] @param {string} [recipient] @param {string} [dataStr] */
	setTransferValues(amount, recipient, dataStr) {
		// AMOUNT
		if (typeof amount === 'number') this.eHTML.transfer.amountInput.value = CURRENCY.formatNumberAsCurrency(amount);

		// RECIPIENT
		this.eHTML.transfer.recipientAddress.value = recipient || this.eHTML.transfer.senderAddress?.innerText;
		if (this.action === 'Stake' || this.action === 'Unstake' || this.action === 'Inscribe')
			this.eHTML.transfer.recipientAddress.value = this.eHTML.transfer.senderAddress?.innerText; // FORCE SENDER AS RECIPIENT

		// SHOW DATA FIELD IF dataStr IS PROVIDED, HIDE IT OTHERWISE
		this.toggleDataField(dataStr !== undefined);
		this.eHTML.transfer.dataInput.value = dataStr || '';
		this.prepareTxAccordingToInputsAndUpdateFees();
	}
	/** @returns {{ action: 'Send' | 'Stake' | 'Unstake' | 'Inscribe', amount: number, recipient: string | undefined, dataStr: string | undefined }} */
	getTransferValues() {
		const amountStr = this.eHTML.transfer.amountInput.value;
		const recipient = this.eHTML.transfer.recipientAddress.value;
		const dataStr = this.isDataFieldEnabled ? this.eHTML.transfer.dataInput.value : undefined;
		return {
			action: this.action,
			amount: amountStr !== '' ? CURRENCY.formatCurrencyAsMicroAmount(amountStr) : 0,
			recipient: recipient !== '' ? recipient : undefined,
			dataStr: dataStr !== '' ? dataStr : undefined
		}
	}
	/** @returns {{ serialized: Uint8Array, signedTx: Transaction } | string }} */
	prepareTxAccordingToInputsAndUpdateFees() {
		this.eHTML.transfer.txFee.innerText = CURRENCY.formatNumberAsCurrency(0);
		this.eHTML.transfer.totalSpent.innerText = CURRENCY.formatNumberAsCurrency(0);

		const senderAccount = this.biw.activeAccount;
		const feePerByte = this.biw.standardFeePerByte.min;
		const { action, amount, recipient, dataStr } = this.getTransferValues();
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
			this.eHTML.transfer.txFee.innerText = CURRENCY.formatNumberAsCurrency(finalFee);
			this.eHTML.transfer.totalSpent.innerText = CURRENCY.formatNumberAsCurrency(totalConsumed);
			return { serialized, signedTx };
		} catch (/** @type {any} */ error) { return error.message; }
	}

	// HISTORY FORM METHODS
	resetHistoryList() {
		this.eHTML.history.list.innerHTML = '';
	}
	/** @param {TxId} txId @param {Transaction} tx @param {number} inAmount */
	addTransactionToHistory(txId, tx, inAmount) {
		//console.log('Adding transaction to history:', txId, tx, inAmount);
		const height = parseInt(txId.split(':')[0]);
		const approxTimestamp = this.biw.connector.getBlockConfirmationTimestampApproximation(height);
		const receivedAmount = tx.outputs.reduce((sum, output) => sum + (output.address === this.biw.activeAccount.address ? output.amount : 0), 0);
		const sentAmount = inAmount;
		const balanceChange = receivedAmount - sentAmount;
		const isPositive = balanceChange >= 0;
		const state = 'Confirmed'

		const listItem = document.createElement('div');
		listItem.classList.add('biw-historyListItem');
		listItem.dataset.txId = txId;

		const changeText = `${isPositive ? '+' : ''}${CURRENCY.formatNumberAsCurrency(balanceChange)}`;
		createSpacedTextElement(changeText, ['biw-historyChange'], state, ['biw-historyState'], listItem);
		
		const dateText = !approxTimestamp ? 'Pending'
			: new Date(approxTimestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
		createSpacedTextElement(txId, ['biw-historyTxId'], dateText, ['biw-historyDate'], listItem);
		
		this.eHTML.history.list.appendChild(listItem);
	}
	/** @param {'SENT' | 'RECEIVED' | 'ALL'} filter */
	setHistoryFilter(filter) { // NOT IMPLEMENTED YET
		this.eHTML.history.sentButton.classList.toggle('active', filter === 'SENT');
		this.eHTML.history.receivedButton.classList.toggle('active', filter === 'RECEIVED');
		this.eHTML.history.allButton.classList.toggle('active', filter === 'ALL');

		//this.biw.updateDisplayedTransactions(filter);
	}

	updatePaginationButtonsState() {
		const page = this.biw.components.accounts.activeAccountHistoryPage;
		if (page <= 0) this.eHTML.history.prevPageBtn.classList.add('disabled');
		else this.eHTML.history.prevPageBtn.classList.remove('disabled');

		if (page >= this.biw.components.accounts.totalAccountHistoryPages - 1) this.eHTML.history.nextPageBtn.classList.add('disabled');
		else this.eHTML.history.nextPageBtn.classList.remove('disabled');
	}
}