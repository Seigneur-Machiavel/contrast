const base58Alphabet = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8, 'A': 9, 'B': 10, 'C': 11, 'D': 12, 'E': 13, 'F': 14, 'G': 15, 'H': 16, 'J': 17, 'K': 18, 'L': 19, 'M': 20, 'N': 21, 'P': 22, 'Q': 23, 'R': 24, 'S': 25, 'T': 26, 'U': 27, 'V': 28, 'W': 29, 'X': 30, 'Y': 31, 'Z': 32, 'a': 33, 'b': 34, 'c': 35, 'd': 36, 'e': 37, 'f': 38, 'g': 39, 'h': 40, 'i': 41, 'j': 42, 'k': 43, 'm': 44, 'n': 45, 'o': 46, 'p': 47, 'q': 48, 'r': 49, 's': 50, 't': 51, 'u': 52, 'v': 53, 'w': 54, 'x': 55, 'y': 56, 'z': 57 };

export const typeValidation = {
    /** @param {string} base58 - Base58 string to validate @returns {string|false} */
    base58(base58) {
        for (let i = 0; i < base58.length; i++) {
            if (base58Alphabet[base58[i]] === undefined) { return false; }
        }
        return base58;
    },
    /** @param {string} hex - Hex string to validate @returns {string|false} */
    hex(hex) {
        if (!hex) { return false; }
        if (typeof hex !== 'string') { return false; }
        if (hex.length === 0) { return false; }
        if (hex.length % 2 !== 0) { return false; }

        for (let i = 0; i < hex.length; i++) {
            const char = hex[i];
            if (isNaN(parseInt(char, 16))) { return false; }
        }

        return hex;
    },
    /** @param {string} base64 - Base64 string to validate @returns {string|false} */
    uint8Array(uint8Array) {
        if (uint8Array instanceof Uint8Array === false) { return false; }
        return uint8Array;
    },
    /** @param {number} number - Number to validate */
    numberIsPositiveInteger(number) {
        return typeof number === 'number' && !isNaN(number) && number > 0 && number % 1 === 0;
    },
    /** @param {string} anchor - "height:TxID:vout" - ex: "8:7c5aec61:0" */
    isConformAnchor(anchor) {
        if (typeof anchor !== 'string') { return false; }

        const splitted = anchor.split(':');
        if (splitted.length !== 3) { return false; }

        // height
        const height = parseInt(splitted[0], 10);
        if (isNaN(height) || typeof height !== 'number') { return false; }
        if (height < 0 || height % 1 !== 0) { return false; }

        // TxID
        if (typeof splitted[1] !== 'string') { return false; }
        if (splitted[1].length !== 8) { return false; }
        if (typeValidation.hex(splitted[1]) === false) { return false; }

        // vout
        const vout = parseInt(splitted[2], 10);
        if (isNaN(vout) || typeof vout !== 'number') { return false; }
        if (vout < 0 || vout % 1 !== 0) { return false; }

        return true;
    },
    /** @param {string} txReference - "height:TxID" - ex: "8:7c5aec61" */
    isConformTxReference(txReference) {
        if (typeof txReference !== 'string') { return false; }

        const splitted = txReference.split(':');
        if (splitted.length !== 2) { return false; }

        // height
        const height = parseInt(splitted[0], 10);
        if (isNaN(height) || typeof height !== 'number') { return false; }
        if (height < 0 || height % 1 !== 0) { return false; }

        // TxID
        if (typeof splitted[1] !== 'string') { return false; }
        if (splitted[1].length !== 8) { return false; }
        if (typeValidation.hex(splitted[1]) === false) { return false; }

        return true;
    }
};