import { ADDRESS } from '../../types/address.mjs';
import { CURRENCY } from "../../utils/currency.mjs";
import { IS_VALID } from "../../types/validation.mjs";

export class Interpreter {
	//interpreter = document.getElementById('biw-interpreter');
	interpreterInput = document.getElementById('biw-interpreterInput');
	//buttonBarInterpreter = document.getElementById('biw-buttonBarInterpreter');
	validChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .';
	get isOpen() { return this.interpreter?.classList.contains('open'); }

	/** @param {string} str */
	read(str) {
		if (!this.#isSafelyReadable(str)) return 'Unsafe input';

		const t = str.trim().split(/\s+/);
		const action = t[0]?.toUpperCase();

		if (action === 'SEND') {
			if (t.length !== 3) return 'Expected: SEND <amount> <address>';

			const amount = this.#parseFloatIfSafeAndValidContrastAmount(t[1]);
			if (amount === false) return 'Invalid amount';

			if (!ADDRESS.checkConformity(t[2])) return 'Invalid address';
			return { action, amount, address: t[2], dataStr: null, anchors: null };
		}

		if (action === 'STAKE') {
			if (t.length !== 3) return 'Expected: STAKE <amount> <pubkey(s),>';

			const amount = this.#parseFloatIfSafeAndValidContrastAmount(t[1]);
			if (amount === false) return 'Invalid amount';

			const pubkeys = t[2].split(','); // allow multiple pubkeys separated by comma
			for (const pk of pubkeys) if (!this.#isValidHex(pk, 64)) return `Invalid pubkey: ${pk}`;
			return { action, amount, address: null, dataStr: pubkeys.join(' '), anchors: null };
		}

		if (action === 'UNSTAKE') {
			if (t.length !== 2) return 'Expected: UNSTAKE <anchors,>';

			const anchors = t[1].split(','); // allow multiple anchors separated by comma
			for (const anchor of anchors) if (!IS_VALID.ANCHOR(anchor)) return 'Invalid anchor';
			return { action, amount: 0, address: null, dataStr: t[1], anchors };
		}

		if (action === 'INSCRIBE') {
			if (t.length !== 2) return 'Expected: INSCRIBE <data(hex)>';
			if (!this.#isValidHex(t[1])) return 'Data must be hex';
			return { action, amount: 0, address: null, dataStr: t[1], anchors: null };
		}

		return `Invalid action: ${t[0]}`;
	}
	/** @param {string} str */
	#isSafelyReadable(str) {
		if (typeof str !== 'string') return false;
		for (let i = 0; i < str.length; i++) if (!this.validChars.includes(str[i])) return false;
		return true;
	}
	/** @param {string} str @param {number} [length] */
	#isValidHex(str, length) {
    	if (str.length === 0 || str.length % 2 !== 0) return false; // must be byte-aligned
		if (length && str.length !== length) return false; // must match specified length
		for (let i = 0; i < str.length; i++) if (!'0123456789abcdefABCDEF'.includes(str[i])) return false;
		return true;
	}
	/** @param {string} value */
	#parseFloatIfSafeAndValidContrastAmount(value) {
		if (typeof value !== 'string') return false;
		if (value.length < 1 || value.length > 14) return false;
		for (let i = 0; i < value.length; i++) if (!'0123456789.'.includes(value[i])) return false;
		
		// no more than 6 decimals
		if (!value.includes('.')) return parseInt(value) * 1_000_000; // as micro-contrast
		else if (value.split('.')[1].length > 6) return false; // too many decimals
		else return CURRENCY.formatCurrencyAsMicroAmount(value); // parse as micro-contrast
	}
}