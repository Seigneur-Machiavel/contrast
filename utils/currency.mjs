
export class CURRENCY {
	/** @param {number} num - Integer to convert to readable @param {number} [decimals] - Decimal places to show, default: 6 */
	static formatNumberAsCurrency(num, decimals = 6) {
		const numberPadded = num.toString().padStart(6, '0');
		const num2last6 = numberPadded.slice(-6) || '0';
		const numRest = numberPadded.slice(0, -6) || '0';
		const separatedNum = numRest.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		const full = `${separatedNum}.${num2last6}`;
		const [intPart, decPart] = full.split('.');
		const trimmed = decPart.slice(0, decimals).replace(/0+$/, '');
		return trimmed ? `${intPart}.${trimmed}` : intPart;
	}

    /** @param {string} str - String to convert to readable change */
    static formatCurrencyAsMicroAmount(str) {
        if (!/^[0-9.,]*$/.test(str)) return 0; // only contains 0-9 "," "."

        const [integer, decimal] = str.split('.');
        const integerStr = integer.replace(/,/g, '');
        const decimalStr = decimal ? decimal.padEnd(6, '0').slice(0, 6) : '000000';
        //const int = integerStr === '' ? 0 : parseInt(`${integerStr}${decimalStr}`); // old
		const int = parseInt(`${integerStr}${decimalStr}`);
        if (isNaN(int)) { console.error('Invalid number:', str); return 0; }
		//console.log(`Converted "${str}" to micro amount:`, int);
        return int;
    }

    /** @param {number} num - Integer to convert to readable change */
    static formatNumberAsCurrencyChange(num) {
        const prefix = num < 0 ? '-' : '+';
        return `${prefix}${CURRENCY.formatNumberAsCurrency(Math.abs(num))}`;
    }
};