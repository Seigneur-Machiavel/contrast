export const conditionnals = {
    /** Check if the string starts with a certain amount of zeros
     * @param {string} string
     * @param {number} zeros */
    binaryStringStartsWithZeros: (string, zeros) => {
        if (typeof string !== 'string') return false;
        if (typeof zeros !== 'number') return false;
        if (zeros < 0) return false;

        const target = '0'.repeat(zeros);
        return string.startsWith(target);
    },

    /** Check if the string as binary is superior or equal to the target
     * @param {string} string
     * @param {number} minValue */
    binaryStringSupOrEqual: (string = '', minValue = 0) => {
        if (typeof string !== 'string') return false;
        if (typeof minValue !== 'number') return false;
        if (minValue < 0) return false;

        const intValue = parseInt(string, 2);
        return intValue >= minValue;
    },
    /** Check if the array contains duplicates
     * @param {Array} array */
    arrayIncludeDuplicates(array) {
        return (new Set(array)).size !== array.length;
    }
};