// @ts-check
if (false) { const anime = require('animejs'); } // For completion

import { Interpreter } from './interpreter.js';
import { ADDRESS } from '../../types/address.mjs';
import { eHTML_STORE } from '../board-helpers.js';
import { CURRENCY } from '../../utils/currency.mjs';
import { MiniformComponent } from './miniform-component.js';
import { AccountsComponent } from './accounts-component.js';
import { Wallet, Account } from '../../node/src/wallet.mjs';
import { BLOCKCHAIN_SETTINGS } from '../../utils/blockchain-settings.mjs';
import { ButtonHoldAnimation, horizontalBtnLoading } from '../htmlAnimations.js';

/** @typedef {import("../../types/transaction.mjs").Transaction} Transaction */

const eHTML = new eHTML_STORE('biw-', 'container');
export class BoardInternalWallet {
	components = {											// @ts-ignore
		/** @type {MiniformComponent} */ miniform: null, 	// @ts-ignore
		/** @type {AccountsComponent} */ accounts: null,	// @ts-ignore
		/** @type {Interpreter} */ interpreter: null,
	}

	eHTML = eHTML;
	autoRefresh = true;
	wallet = new Wallet("0000000000000000000000000000000000000000000000000000000000000000");
	accountThatNeedsRefresh = new Set();
	boardStorage;
	connector;

	/** @type {Record<string, anime.AnimeInstance | null>} */
	animations = {};
    standardFeePerByte = { "fast": 12, "average": 5, "slow": 2, "min": BLOCKCHAIN_SETTINGS.minTransactionFeePerByte };
	/** @type {string | null} */			currentTextInfo = null;
	/** @type {NodeJS.Timeout | null} */	textInfoTimeout1 = null;
    /** @type {NodeJS.Timeout | null} */	textInfoTimeout2 = null;

	get activeAccount() { return this.wallet.accounts[this.components.accounts.activeAccountIndex]; }

	/** @param {import('../connector.js').Connector} connector @param {import('../../utils/front-storage.mjs').FrontStorage} boardStorage */
	constructor(connector, boardStorage) {
		this.connector = connector;
		this.boardStorage = boardStorage;
		this.#initWhileDomReady();
	}

	// API METHODS
	/** @param {string} text @param {HTMLElement | null} [infoElmnt] @param {number} [timeout] @param {boolean} [eraseAnyCurrentTextInfo] @param {boolean} [important] */
	textInfo(text, infoElmnt = eHTML.get('globalTextInfo'), timeout = 3000, eraseAnyCurrentTextInfo = false, important = false) {
		if (!infoElmnt) return;
        if (!eraseAnyCurrentTextInfo && this.currentTextInfo) return;

        this.currentTextInfo = text;
        infoElmnt.innerText = text;
        infoElmnt.style.opacity = '1';
        if (important) infoElmnt.classList.add('important');

        if (this.textInfoTimeout1) clearTimeout(this.textInfoTimeout1);
        if (this.textInfoTimeout2) clearTimeout(this.textInfoTimeout2);

        this.textInfoTimeout1 = setTimeout(() => {
            this.currentTextInfo = null;
            infoElmnt.style.opacity = '0';
            infoElmnt.classList.remove('important');
        }, timeout);
        this.textInfoTimeout2 = setTimeout(() => infoElmnt.innerText = "", timeout + 200);
    }
	async refreshAccounts(force = false) {
		if (force) for (const account of this.wallet.accounts) this.accountThatNeedsRefresh.add(account.address);
		if (this.accountThatNeedsRefresh.size === 0) return;

		console.log(`Refreshing ${this.accountThatNeedsRefresh.size} accounts...`);
		const buttonRefresh = eHTML.get('buttonRefresh');
		const balanceElement = eHTML.get('balanceStr');
		const stakedBalanceElement = eHTML.get('stakedStr');
		if (!buttonRefresh || !balanceElement || !stakedBalanceElement) throw new Error('Refresh button element not found');
		buttonRefresh.classList.add('active');

		const start = Date.now();
		for (const account of this.wallet.accounts) {
			if (!this.accountThatNeedsRefresh.has(account.address)) continue;
			const ledger = await this.connector.getAddressLedger(account.address);
			if (!ledger || !ledger.ledgerUtxos) continue;

			account.setBalanceAndUTXOs(ledger.balance, ledger.ledgerUtxos);
			this.accountThatNeedsRefresh.delete(account.address);
        }

		this.components.accounts.updateLabels();
		balanceElement.innerText = CURRENCY.formatNumberAsCurrency(this.wallet.balance);
		stakedBalanceElement.innerText = CURRENCY.formatNumberAsCurrency(this.wallet.stakedBalance);
		
		// wait at least 500ms to remove the active state, to avoid too quick flashes if the refresh is very fast
		if (Date.now() - start < 1000) await new Promise(r => setTimeout(r, 1000 - (Date.now() - start)));
        buttonRefresh.classList.remove('active');
    }
	/** @param {string} address */
    selectAccountLabel(address) {
		const accountIndex = this.#getWalletAccountIndexByAddress(address);
		this.components.accounts.setActiveAccountIndex(accountIndex);
		this.components.miniform.setSenderAddress(address);
		console.log(`Selected account: ${address}`);
    }

	// INTERNAL METHODS
	async #initWhileDomReady() {
		if (!eHTML.isReady) console.log('BIW awaiting DOM elements...');
		while (!eHTML.isReady) await new Promise(r => setTimeout(r, 200));
		console.log('BIW DOM elements ready.');

		this.components.miniform = new MiniformComponent(this);
		this.components.accounts = new AccountsComponent(eHTML.get('accountsWrap'), this);
		this.components.interpreter = new Interpreter();
		await this.#loadUserPreferences();

		/** @ts-ignore @type {string | null} */
		const savedPrivateKey = await this.boardStorage.load('board_internal_wallet_private_key');
		const privateKey = savedPrivateKey || Wallet.generateRandomMasterHex();
        this.wallet = new Wallet(privateKey);
        await this.wallet.loadAccountsFromFrontStorage(this.boardStorage);
		this.components.accounts.updateLabels();
		if (this.wallet.accounts.length > 0) this.selectAccountLabel(this.wallet.accounts[0].address);
		for (const account of this.wallet.accounts) this.accountThatNeedsRefresh.add(account.address);

		this.connector.on('consensus_height_change', this.#onConsensusHeightChange);
    }
	#onConsensusHeightChange = async (newHeight = 0) => {
		if (!this.autoRefresh) return;

		// CHECK WHICH ACCOUNTS NEED REFRESH (because they are involved in the new finalized block)
		const block = this.connector.blocks.finalized[this.connector.hash];
		for (const tx of block?.Txs || []) {
			for (const output of tx.outputs)
				for (const account of this.wallet.accounts)
					if (output.address === account.address && !this.accountThatNeedsRefresh.has(account.address))
						this.accountThatNeedsRefresh.add(account.address);

			for (const input of tx.inputs)
				for (const account of this.wallet.accounts)
					for (const utxo of account.ledgerUtxos)
						if (input === utxo.anchor && !this.accountThatNeedsRefresh.has(account.address))
							this.accountThatNeedsRefresh.add(account.address);
		}

		await this.refreshAccounts();
	}
	#getWalletAccountIndexByAddress(address = '') {
        for (let j = 0; j < this.wallet.accounts.length; j++)
			if (this.wallet.accounts[j].address === address) return j;
        return -1;
    }
	async #generateNewAddress() {
		const btn = eHTML.get('newAddressBtn');
		const isGenerating = eHTML.get('newAddressBtn')?.innerHTML !== '+';
		if (!btn || isGenerating) return;

		this.textInfo('Generating account...');
		btn.classList.add('loading');
		btn.innerHTML = horizontalBtnLoading;

		// START ANIMATION
		let animation = anime({
			targets: btn,
			width: ['80px', '200px', '80px'],
			duration: 1600,
			loop: true,
			easing: 'easeInOutQuad'
		});

		await this.wallet.deriveOneAccount('C', undefined, this.boardStorage);
		await new Promise(r => setTimeout(r, 800)); // wait a bit to show the animation
		this.components.accounts.updateLabels();

		// STOP ANIMATION
		btn.classList.remove('loading');
		animation.pause();
		animation = anime({
			targets: btn,
			width: '34px',
			duration: 200,
			easing: 'easeInOutQuad',
			complete: () => { btn.innerHTML = '+'; }
		});
	}
    #followInstructionsFromInput() {
		const instructionsInput = /** @type {HTMLInputElement} */ (eHTML.get('interpreterInput'));
		const sender = this.activeAccount?.address;
		if (!sender) throw new Error('No active account selected to send from');

		const instructions = this.components.interpreter.read(instructionsInput.value);
        instructionsInput.value = ''; // reset field after reading instructions
        if (typeof instructions === 'string') { this.textInfo(instructions); return; }

		const { action, amount, address, dataStr } = instructions;
		this.components.miniform.open(action);
		this.components.miniform.setValues(
			amount,
			address || sender,
			dataStr	? dataStr : undefined
		)

		eHTML.get('buttonBarInterpreter')?.classList.remove('open');
		eHTML.get('interpreter')?.classList.remove('open');
    }
	#saveUserPreferences() {
		const autoRefreshCheckbox = /** @type {HTMLInputElement} */ (eHTML.get('autoRefreshCheckbox'));
		const enableCommandsCheckbox = /** @type {HTMLInputElement} */ (eHTML.get('enableCommandsCheckbox'));
		const enableDataFieldCheckbox = /** @type {HTMLInputElement} */ (eHTML.get('enableDataFieldCheckbox'));
		const userPreferences = {
			autoRefresh: autoRefreshCheckbox.checked || false,
			enableCommands: enableCommandsCheckbox.checked || false,
			enableDataField: enableDataFieldCheckbox.checked || false,
		};

		this.boardStorage.save('board_internal_wallet_user_preferences', JSON.stringify(userPreferences));
	}
	async #loadUserPreferences() {
		const d = /** @type {string | null} */ (await this.boardStorage.load('board_internal_wallet_user_preferences'));
		if (!d) return;

		const autoRefreshCheckbox = /** @type {HTMLInputElement} */ (eHTML.get('autoRefreshCheckbox'));
		const enableCommandsCheckbox = /** @type {HTMLInputElement} */ (eHTML.get('enableCommandsCheckbox'));
		const enableDataFieldCheckbox = /** @type {HTMLInputElement} */ (eHTML.get('enableDataFieldCheckbox'));
		try {
			const userPreferences = JSON.parse(d);
			autoRefreshCheckbox.checked = !!userPreferences.autoRefresh;
			enableCommandsCheckbox.checked = !!userPreferences.enableCommands;
			enableDataFieldCheckbox.checked = !!userPreferences.enableDataField;
			if (userPreferences.autoRefresh) this.autoRefresh = true;
			if (userPreferences.enableCommands) eHTML.get('buttonBarInterpreter')?.classList.remove('hidden');
			if (userPreferences.enableDataField) eHTML.get('dataField')?.classList.remove('hidden');
		} catch (error) { console.error('Error loading user preferences:', error); }
	}

	// HANDLERS METHODS
	// @ts-ignore
	clickHandler(e) {
		if (!e.target.dataset.action) return;
		
		const parent = e.target.parentElement;
		switch(e.target.dataset.action) {
			case 'biw-refresh':
				this.refreshAccounts(true);
				break;
			case 'biw-toggle-settings-menu':
				eHTML.get('settings-menu')?.classList.toggle('open');
				break;
			case 'biw-auto-refresh-toggle':
				this.autoRefresh = e.target.checked;
				this.#saveUserPreferences();
				break;
			case 'biw-enable-commands-toggle':
				if (e.target.checked) eHTML.get('buttonBarInterpreter')?.classList.remove('hidden');
				else eHTML.get('buttonBarInterpreter')?.classList.add('hidden');
				this.#saveUserPreferences();
				break;
			case 'biw-enable-data-field-toggle':
				if (e.target.checked) eHTML.get('dataField')?.classList.remove('hidden');
				else eHTML.get('dataField')?.classList.add('hidden');
				this.#saveUserPreferences();
				break;
			case 'biw-new-address':
				this.#generateNewAddress();
				break;
			case 'biw-select-account':
				this.selectAccountLabel(e.target.dataset.value);
				break;
			case 'biw-toggle-send-form':
				if (this.components.miniform.isOpen) this.components.miniform.close();
				else this.components.miniform.open('SEND');
				// OPTIONNAL: add active class to button while form is open
				//if (this.components.miniform.isOpen) e.target.classList.add('active');
				//else e.target.classList.remove('active');
				break;
			case 'biw-toggle-swap-form':
				console.log('Swap not implemented yet');
				break;
			case 'biw-toggle-interpreter':
				this.components.interpreter.toggle();
				// OPTIONNAL: add active class to button while form is open
				break;
			case 'biw-interpret-input-btn':
				this.#followInstructionsFromInput();
				this.components.interpreter.close();
				break;
		}
	} // @ts-ignore
	inputHandler(e) {
		const amountInput = /** @type {HTMLInputElement} */ (eHTML.get('amountInput')); 
		if (e.target === amountInput) {
			// Allow only numbers and one dot, and max 6 decimals
			const parts = amountInput.value.replace(/[^\d.]/g, '').split('.');
			parts[0] = parts[0].slice(0, 7); // limit integer part to realistic 7 digits (max 9,999,999)
			if (parts.length === 2) parts[1] = parts[1].slice(0, 6); // limit to 6 decimals

			amountInput.value = parts.length > 1 ? `${parts[0]}.${parts[1]}` : parts[0];
			this.components.miniform.prepareTxAccordingToInputsAndUpdateFees();
			return;
		}

		const recipientAddress = /** @type {HTMLInputElement} */ (eHTML.get('recipientAddress'));
		if (recipientAddress && e.target === recipientAddress) {
			/** @type {string} */ const a = recipientAddress.value;
			if (ADDRESS.checkConformity(a)) recipientAddress.classList.remove('invalid');
			else recipientAddress.classList.add('invalid');
			this.components.miniform.prepareTxAccordingToInputsAndUpdateFees();
		}

		const dataInput = eHTML.get('dataInput');
		if (dataInput && e.target === dataInput)
			this.components.miniform.prepareTxAccordingToInputsAndUpdateFees();
	} // @ts-ignore
	keyDownHandler(e) {
		if (e.key === 'Enter' && e.target.id === 'biw-interpreterInput') {
			e.preventDefault();
			this.#followInstructionsFromInput();
		}
	} // @ts-ignore
	pasteHandler(e) {
		if (e.target.id === 'biw-interpreterInput')
			setTimeout(() => this.#followInstructionsFromInput(), 10);
	} // @ts-ignore
	focusInHandler(e) {
		//if (e.target.id === 'biw-amountInput') e.target.value = '';
	} // @ts-ignore
	focusOutHandler(e) {
		if (e.target.id === 'biw-amountInput') this.components.miniform.prepareTxAccordingToInputsAndUpdateFees();
	} // @ts-ignore
	mouseDownHandler(e) { // CONFIRM TX SENDING
		if (e.target.dataset.action !== 'biw-confirm') return;

		const r = this.components.miniform.prepareTxAccordingToInputsAndUpdateFees();
		if (typeof r === 'string') { this.textInfo(r); return; }

		// EVERYTHING IS OK, PROCEED WITH TRANSACTION CREATION AND BROADCAST
		if (this.animations.sendBtn) this.animations.sendBtn.pause();
		
		const cb = async () => { // AWAIT HOLD TIME TO SIGN AND BROADCAST
			try {
				this.connector.p2pNode.broadcast(r.serialized, { topic: 'transaction' });
				this.textInfo('Transaction broadcasted');

				for (const anchor of r.signedTx.inputs) this.activeAccount.markUTXOAsSpent(anchor);
				this.components.accounts.updateLabels();
				this.components.miniform.reset();
				this.animations.sendBtn = null;
				console.log(`Broadcasted tx (${r.serialized.length} bytes):`, r.signedTx);
			} catch (/** @type {any} */ error) { this.textInfo(error.message); }
		};
		
		const sendBtn = /** @type {HTMLButtonElement} */ (eHTML.get('sendBtn'));
		this.animations.sendBtn = ButtonHoldAnimation.holdMouseDown(sendBtn, cb);
	} // @ts-ignore
	mouseUpHandler(e) { // CANCEL TX SENDING IF USER RELEASES BEFORE HOLD TIME
		if (!this.animations.sendBtn) return;

		this.textInfo('Hold the button to confirm');
		const sendBtn = /** @type {HTMLButtonElement} */ (eHTML.get('sendBtn'));
		this.animations.sendBtn.pause();
		this.animations.sendBtn = ButtonHoldAnimation.holdMouseUp(sendBtn);
	};
}