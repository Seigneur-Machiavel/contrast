export const Convert = {
    /** @param {number} num - Integer to convert to readable */
    formatNumberAsCurrency: (num) => {
        // 1_000_000_000 -> 1,000.000000
        if (num < 1_000_000) { return `0.${num.toString().padStart(6, '0')}`; }
        const num2last6 = num.toString().slice(-6);
        const numRest = num.toString().slice(0, -6);
        const separedNum = numRest.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        return `${separedNum}.${num2last6}`;
    },
    formatNumberAsCurrencyChange: (num) => {
        const prefix = num < 0 ? '-' : '+';
        if (prefix === '-') { num = Math.abs(num); }

        if (num < 1_000_000) { return `${prefix}0.${num.toString().padStart(6, '0')}`; }
        const num2last6 = num.toString().slice(-6);
        const numRest = num.toString().slice(0, -6);
        const separedNum = numRest.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        return `${prefix}${separedNum}.${num2last6}`;
    }
};