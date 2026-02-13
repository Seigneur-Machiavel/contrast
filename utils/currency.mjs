
export class CURRENCY {
    /** @param {number} num - Integer to convert to readable */
    static formatNumberAsCurrency(num) {
        const numberPaddded = num.toString().padStart(6, '0');
        const num2last6 = numberPaddded.toString().slice(-6) || '0';
        const numRest = numberPaddded.toString().slice(0, -6) || '0';
        const separedNum = numRest.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        let formatedValue = `${separedNum}.${num2last6}`.replace(/0+$/, ''); // remove trailing zeros
        if (formatedValue.endsWith('.')) formatedValue = formatedValue.slice(0, -1);
        
        return formatedValue;
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