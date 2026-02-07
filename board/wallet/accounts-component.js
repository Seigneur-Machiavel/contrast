// @ts-check
//import { serializer } from '../../utils/serializer.mjs';
import { CURRENCY } from '../../utils/currency.mjs';
import { PatternGenerator } from './pattern-generator.js';
import { eHTML_STORE, createElement, createSpacedTextElement } from '../board-helpers.js';

/**
 * @typedef {import('../../node/src/wallet.mjs').Account} Account
 */

const UX_SETTINGS = { shapes: 4 };
const patternGenerator = new PatternGenerator({ width: 48, height: 48, scale: 1 });
export class AccountsComponent {
	/** @type {HTMLElement} */ wrap;
	activeAccountIndex = 0;
	biw;

	/** @param {HTMLElement | null} wrap @param {import('./biw.js').BoardInternalWallet} biw */
	constructor(wrap, biw) {
		if (!wrap) throw new Error('AccountsComponent: wrap is null');
		this.wrap = wrap;
		this.biw = biw;
	}

	updateLabels() {
		const accounts = this.biw.wallet.accounts;
		const newAddressBtn = this.biw.eHTML.get('newAddressBtn');
		if (!newAddressBtn) throw new Error('AccountsComponent.updateLabels: newAddressBtn not found');

		const accountLabels = this.wrap.getElementsByClassName('biw-accountLabel');
        const labelsToRemove = accountLabels.length - accounts.length;
        for (let i = 0; i < labelsToRemove; i++) this.wrap.removeChild(accountLabels[accountLabels.length - 1]);
        if (accounts.length === 0) return;

        const h2 = this.wrap.getElementsByTagName('h2');
        const h3 = this.wrap.getElementsByTagName('h3');
        for (let i = 0; i < accounts.length; i++) {
        	const account = accounts[i];
            const accountName = `Account_${i + 1}`;
            const existingAccountLabel = accountLabels[i];
            if (existingAccountLabel) { // fill existing label
                const name = h2[i];
                const amount = h3[i * 2];
                const address = h3[i * 2 + 1];

                if (address.innerText !== account.address) {
                    const img = patternGenerator.generateImage(account.address, UX_SETTINGS.shapes);
                    const accountImgWrap = existingAccountLabel.getElementsByClassName('biw-accountImgWrap')[0];
                    accountImgWrap.removeChild(accountImgWrap.getElementsByTagName('canvas')[0]);
                    accountImgWrap.appendChild(img);
                }

                const readableAmount = `${CURRENCY.formatNumberAsCurrency(account.balance)}c`;
                if (name.innerText !== accountName) name.innerText = accountName;
                if (address.innerText !== account.address) address.innerText = account.address;
                if (amount.innerText !== readableAmount) amount.innerText = readableAmount;
                continue;
            }
    
            const accountLabel = this.#createAccountLabel(accountName, account.address, account.spendableBalance);
            this.wrap.insertBefore(accountLabel, newAddressBtn);
        }
	}
	setActiveAccountIndex(index = 0) {
		this.activeAccountIndex = index;
		this.#updateActiveAccountLabel();
	}
	#updateActiveAccountLabel() { // TO UPDATE
        const accountLabels = this.wrap.getElementsByClassName('biw-accountLabel');
        if (accountLabels.length === 0) return;
    
        for (let i = 0; i < accountLabels.length; i++)
            if (i !== this.activeAccountIndex) accountLabels[i].classList.remove('active')
            else accountLabels[i].classList.add('active');
    }
	/** @param {string} name @param {string} address @param {number} [amount] */
	#createAccountLabel(name, address, amount = 0) {
        const accountLabel = document.createElement('div');
        accountLabel.classList.add('biw-accountLabel');
		accountLabel.dataset.action = 'biw-select-account';
		accountLabel.dataset.value = address;
    
		const accountImgWrap = createElement('div', ['biw-accountImgWrap'], accountLabel);
		createElement('div', [], accountImgWrap);
		createElement('div', [], accountImgWrap);
		const img = patternGenerator.generateImage(address, UX_SETTINGS.shapes);
		accountImgWrap.appendChild(img);
		accountImgWrap.dataset.action = 'biw-select-account';
		accountImgWrap.dataset.value = address;
    
		const accountLabelInfoWrap = createElement('div', ['biw-accountLabelInfoWrap'], accountLabel);
		const accountLabelAddressAndValueWrap = createElement('div', ['biw-accountLabelAddressAndValueWrap'], accountLabelInfoWrap);
		createElement('h2', [], accountLabelAddressAndValueWrap).innerText = address;
		createElement('h3', [], accountLabelAddressAndValueWrap).innerText = `${CURRENCY.formatNumberAsCurrency(amount)}c`;
		
		const accountLabelName = createElement('div', ['biw-accountLabelName'], accountLabelInfoWrap);
		createElement('h3', [], accountLabelName).innerText = name;

        const copyAddressBtn = document.createElement('button');
        const btnImg = document.createElement('img');
        btnImg.src = './wallet/img/copy64.png';
        copyAddressBtn.appendChild(btnImg);
        copyAddressBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(address);
            this.biw.textInfo('Address copied to clipboard');
        });
        accountLabelName.appendChild(copyAddressBtn);
    
        return accountLabel;
    }
}