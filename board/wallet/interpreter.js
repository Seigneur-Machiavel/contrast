import { ADDRESS } from '../../types/address.mjs';
import { CURRENCY } from "../../utils/currency.mjs";

export class Interpreter {
	interpreter = document.getElementById('biw-interpreter');
	interpreterInput= document.getElementById('biw-interpreterInput');
	buttonBarInterpreter = document.getElementById('biw-buttonBarInterpreter');
	validChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .';
	get isOpen() { return this.interpreter?.classList.contains('open'); }

	toggle() {
		if (!this.interpreter || !this.buttonBarInterpreter) throw new Error('Interpreter.toggle: interpreter or buttonBarInterpreter element not found');
		if (this.isOpen) this.close();
		else this.open();
	}
	open() {
		if (!this.interpreter || !this.buttonBarInterpreter || !this.interpreterInput) throw new Error('Interpreter.open: interpreter or buttonBarInterpreter or interpreterInput element not found');
		this.interpreter.classList.add('open');
		this.buttonBarInterpreter.classList.add('open');
		this.interpreterInput.focus();
	}
	close() {
		if (!this.interpreter || !this.buttonBarInterpreter) throw new Error('Interpreter.close: interpreter or buttonBarInterpreter element not found');
		this.interpreter.classList.remove('open');
		this.buttonBarInterpreter.classList.remove('open');
	}
	/** @param {string} instructionsStr */
	read_OLD(instructionsStr) { // DEPRECATED, TO BE REMOVED LATER, USE read() INSTEAD
		if (!this.#isSafelyReadable(instructionsStr)) return 'Instructions is not safely readable';

		try {
			const instructions = instructionsStr.split(' ');
			if (!['SEND', 'STAKE', 'UNSTAKE', 'INSCRIBE'].includes(instructions[0].toUpperCase()))
				return `Invalid action: ${instructions[0]}`;
			
			/** @ts-ignore @type {'SEND' | 'STAKE' | 'UNSTAKE' | 'INSCRIBE'} */
			const action = instructions[0].toUpperCase();
			const amount = this.#parseFloatIfSafeAndValidContrastAmount(instructions[1]) || 0;

			const address = instructions[2].toUpperCase() === 'TO' ? instructions[3] : null;
			if (address && !ADDRESS.checkConformity(address)) return `Invalid address: ${address}`;

			const dataKeywordIndex = instructions.findIndex(word => word.toUpperCase() === 'DATA');
			const dataStr = action === 'INSCRIBE' ? instructions[1]
				: dataKeywordIndex > -1 ? instructions[dataKeywordIndex + 1]
				: null;
			if (typeof dataStr !== 'string' && dataStr !== null) return 'Invalid data field';
	
			return { action, amount, address, dataStr };
		} catch (/** @type {any} */ error) { console.warn('Error reading instructions:', error.stack || error); }

		return 'Invalid instructions';
	}
	/** @param {string} str */
	read(str) {
		if (!this.#isSafelyReadable(str)) return 'Instructions is not safely readable';

		const tokens = str.trim().split(/\s+/);
		const action = tokens[0]?.toUpperCase();
		if (!['SEND', 'STAKE', 'UNSTAKE', 'INSCRIBE'].includes(action))
			return `Invalid action: ${tokens[0]}`;

		let amount = 0, address = null, dataStr = null;

		for (let i = 1; i < tokens.length; i++) {
			const upper = tokens[i].toUpperCase();
			if (upper === 'TO') { address = tokens[++i] || null; continue; }
			if (upper === 'DATA') { dataStr = tokens[++i] || null; continue; }
			if (amount === 0) amount = this.#parseFloatIfSafeAndValidContrastAmount(tokens[i]) || 0;
		}

		if (address && !ADDRESS.checkConformity(address)) return `Invalid address: ${address}`;
		if (action === 'INSCRIBE' && !dataStr) return 'INSCRIBE requires a DATA field';

		return { action, amount, address, dataStr };
	}
	#isSafelyReadable(str = '') {
		if (typeof str !== 'string') return false;
		for (let i = 0; i < str.length; i++) if (!this.validChars.includes(str[i])) return false;
		return true;
	}
	#parseFloatIfSafeAndValidContrastAmount(value = '') {
		if (typeof value !== 'string') return false;
		if (value.length < 1 || value.length > 14) return false;
		for (let i = 0; i < value.length; i++) if (!'0123456789.'.includes(value[i])) return false;
		
		// no more than 6 decimals
		if (!value.includes('.')) return parseInt(value) * 1_000_000; // as micro-contrast
		else if (value.split('.')[1].length > 6) return false; // too many decimals
		else return CURRENCY.formatCurrencyAsMicroAmount(value); // parse as micro-contrast
	}
}