const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
const base58Alphabet = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6, '8': 7, '9': 8, 'A': 9, 'B': 10, 'C': 11, 'D': 12, 'E': 13, 'F': 14, 'G': 15, 'H': 16, 'J': 17, 'K': 18, 'L': 19, 'M': 20, 'N': 21, 'P': 22, 'Q': 23, 'R': 24, 'S': 25, 'T': 26, 'U': 27, 'V': 28, 'W': 29, 'X': 30, 'Y': 31, 'Z': 32, 'a': 33, 'b': 34, 'c': 35, 'd': 36, 'e': 37, 'f': 38, 'g': 39, 'h': 40, 'i': 41, 'j': 42, 'k': 43, 'm': 44, 'n': 45, 'o': 46, 'p': 47, 'q': 48, 'r': 49, 's': 50, 't': 51, 'u': 52, 'v': 53, 'w': 54, 'x': 55, 'y': 56, 'z': 57 };
const base58AlphabetArray = [ '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z' ];

export const convert = {
    base58: {
        /** @param {string} base58 - Base58 string to convert to base64 */
        toBase64: (base58) => {
            const uint8Array = convert.base58.toUint8Array(base58);
            return convert.uint8Array.toBase64(uint8Array);
        },
        /** @param {string} base58 - Base58 string to convert to BigInt */
        toBigInt: (base58) => {
            let num = BigInt(0);
            const base = BigInt(58);

            for (let i = 0; i < base58.length; i++) {
                const char = base58[i];
                const index = base58Alphabet[char];
                if (index === undefined) { throw new Error(`Invalid character: ${char}`); }

                num = num * base + BigInt(index);
            }

            return num;
        },
        /** @param {string} base58 - Base58 string to convert to hex */
        toHex: (base58) => {
            const num = convert.base58.toBigInt(base58);
            return convert.bigInt.toHex(num);
        },
        /** @param {string} base58 - Base58 string to convert to Uint8Array */
        toUint8Array: (base58) => {
            for (let i = 0; i < base58.length; i++) {
                if (base58Alphabet[base58[i]] === undefined) { return false; }
            }

            const hex = convert.base58.toHex(base58);
            return convert.hex.toUint8Array(hex);
        },
        /** @param {string} base58 - Base58 string to convert to hex */
        toHex: (base58) => {
            let num = BigInt(0);
            const base = BigInt(58);

            for (let i = 0; i < base58.length; i++) {
                const char = base58[i];
                const index = base58Alphabet[char];
                if (index === undefined) { throw new Error(`Invalid character: ${char}`); }

                num = num * base + BigInt(index);
            }

            return convert.bigInt.toHex(num);
        }
    },
    base64: {
        /** @param {string} base64 - Base64 string to convert to base58 */
        toBase58: (base64) => {
            const uint8Array = convert.base64.toUint8Array(base64);
            return convert.uint8Array.toBase58(uint8Array);
        },
        /** @param {string} base64 - Base64 string to convert to BigInt */
        toBigInt: (base64) => {
            const uint8Array = convert.base64.toUint8Array(base64);
            return convert.uint8Array.toBigInt(uint8Array);
        },
        /** @param {string} base64 - Base64 string to convert to hex */
        toHex: (base64) => {
            const uint8Array = convert.base64.toUint8Array(base64);
            return convert.uint8Array.toHex(uint8Array);
        },
        /** @param {string} base64 - Base64 string to convert to Uint8Array */
        toUint8Array: (base64) => {
            if (isNode) {
                /** @type {Uint8Array} */
                const bytes = Buffer.from(base64, 'base64');
                return bytes;
            }

            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        },
        /** @param {string} base64 - Base64 string to convert to BigInt */
        toBits: (base64) => {
            const uint8Array = convert.base64.toUint8Array(base64);
            return convert.uint8Array.toBits(uint8Array);
        }
    },
    bigInt: {
        /** @param {BigInt} num - BigInt to convert to base58 */
        toBase58: (num) => {
            let base58 = '';
            let n = num;
            while (n > 0) {
                const remainder = Number(n % BigInt(58));
                base58 = base58AlphabetArray[remainder] + base58;
                n = n / BigInt(58);
            }

            const bytes = isNode ? Buffer.from(base58) : new TextEncoder().encode(base58);

            for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
                base58 = '1' + base58;
            }

            return base58;
        },
        /** @param {BigInt} num - BigInt to convert to base64 */
        toBase64: (num) => {
            const hex = convert.bigInt.toHex(num);
            return convert.hex.toBase64(hex);
        },
        /** @param {BigInt} num - BigInt to convert to Uint8Array */
        toUint8Array: (num) => {
            const hex = convert.bigInt.toHex(num);
            return convert.hex.toUint8Array(hex);
        },
        /** @param {BigInt} num - BigInt to convert to hex */
        toHex: (num) => {
            let hex = num.toString(16);
            if (hex.length % 2 !== 0) {
                hex = '0' + hex;
            }
            return hex;
        },
        /** @param {BigInt} num - BigInt to convert to bits */
        toBits: (num) => {
            const hex = convert.bigInt.toHex(num);
            return convert.hex.toBits(hex);
        },
        /** @param {BigInt} num - BigInt to convert to number */
        toNumber: (num) => {
            return Number(num);
        }
    },
    number: {
        /** @param {number} num - Integer to convert to base58 */
        toBase58: (num) => {
            return convert.bigInt.toBase58(BigInt(num));
        },
        /** @param {number} num - Integer to convert to base64 */
        toBase64: (num) => {
            return convert.bigInt.toBase64(BigInt(num));
        },
        /** @param {number} num - Integer to convert to BigInt */
        toBigInt: (num) => {
            return BigInt(num);
        },
        /** @param {number} num - Integer to convert to Uint8Array */
        toUint8Array: (num) => {
            const hex = convert.number.toHex(num);
            return convert.hex.toUint8Array(hex);
        },
        /** @param {number} num - Integer to convert to Hex */
        toHex: (num) => {
            let hex = num.toString(16);
            if (hex.length % 2 !== 0) {
                hex = '0' + hex;
            }
            return hex;
        },
        /** Number should be between 0 and 255
         * 
         * @param {number} num - Integer to convert to 1 byte Uint8Array
         */
        to1ByteUint8Array: (num) => {
            if (num < 0 || num > 255) { throw new Error('Number out of range'); }
            return new Uint8Array([num]);
        },
        /** Number should be between 0 and 65535
         * 
         * @param {number} num - Integer to convert to 2 bytes Uint8Array
         */
        to2BytesUint8Array: (num) => {
            if (num < 0 || num > 65535) { throw new Error('Number out of range'); }
            let buffer = new ArrayBuffer(2);
            let view = new DataView(buffer);
            view.setUint16(0, num, true); // true for little-endian
            return new Uint8Array(buffer);
        },
        /** Number should be between 0 and 4294967295
         * 
         * @param {number} num - Integer to convert to 4 bytes Uint8Array
         */
        to4BytesUint8Array: (num) => {
            if (num < 0 || num > 4294967295) { throw new Error('Number out of range'); }
            let buffer = new ArrayBuffer(4);
            let view = new DataView(buffer);
            view.setUint32(0, num, true); // true for little-endian
            return new Uint8Array(buffer);
        },
        /** Number should be between 0 and 2^48 - 1 (281474976710655).
         * 
         * @param {number} num - Integer to convert.
         */
        to6BytesUint8Array(num) {
            if (num < 0 || num > 281474976710655) {
                throw new Error('Number out of range. Must be between 0 and 281474976710655.');
            }

            const buffer = new ArrayBuffer(6);
            const view = new DataView(buffer);
            
            // JavaScript bitwise operations treat numbers as 32-bit integers.
            // We need to manually handle the 48-bit number by dividing it into parts.
            for (let i = 0; i < 6; ++i) {
                const byte = num & 0xff;
                view.setUint8(i, byte);
                num = (num - byte) / 256; // Shift right by 8 bits
            }

            return new Uint8Array(buffer);
        },
        /** Number should be between 0 and 281474976710655
         * 
         * @param {number} num - Integer to convert to the smallest Uint8Array possible
         */
        toUint8Array: (num) => {
            if (num > 281474976710655) { throw new Error('Number out of range: > 281474976710655'); }

            if (num > 4294967295) { return convert.number.to6BytesUint8Array(num); }
            if (num > 65535) { return convert.number.to4BytesUint8Array(num); }
            if (num > 255) { return convert.number.to2BytesUint8Array(num); }
            if (num >= 0) { return convert.number.to1ByteUint8Array(num); }
            
            throw new Error('Number out of range: < 0');
        }
    },
    uint8Array: {
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to base58 */
        toBase58: (uint8Array) => {
            const hex = convert.uint8Array.toHex(uint8Array);
            return convert.hex.toBase58(hex);
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to base64 */
        toBase64: (uint8Array) => {
            if (isNode) {
                return uint8Array.toString('base64');
            }

            const binaryString = String.fromCharCode.apply(null, uint8Array);
            return btoa(binaryString);
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to BigInt */
        toBigInt: (uint8Array) => {
            const hex = convert.uint8Array.toHex(uint8Array);
            return convert.hex.toBigInt(hex);
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to hex */
        toHex: (uint8Array) => {
            let hexStr = '';
            for (let i = 0; i < uint8Array.length; i++) {
                hexStr += uint8Array[i].toString(16).padStart(2, '0');
            }
            return hexStr;
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to bits */
        toBits: (uint8Array) => {
            const bitsArray = [];
            for (let i = 0; i < uint8Array.length; i++) {
                const bits = uint8Array[i].toString(2).padStart(8, '0');
                bitsArray.push(...bits.split('').map(bit => parseInt(bit, 10)));
            }

            return bitsArray;
        },
        /**
         * Converts a Uint8Array of 1, 2, 4, or 8 bytes to a number.
         * 
         * @param {Uint8Array} uint8Array
         */
        toNumber(uint8Array) {
            const dataView = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
            switch (uint8Array.byteLength) {
                case 1:
                    return dataView.getUint8(0);
                case 2:
                    return dataView.getUint16(0, true); // true for little-endian
                case 4:
                    return dataView.getUint32(0, true); // true for little-endian
                case 6:
                    // Combine the 6 bytes into one number
                    const lower = dataView.getUint32(0, true); // Read the lower 4 bytes
                    const upper = dataView.getUint16(4, true); // Read the upper 2 bytes
                    // Use bitwise OR to combine the two parts, shifting the upper part by 32 bits.
                    // Note: JavaScript bitwise operations automatically convert operands to 32-bit integers.
                    // We use multiplication and addition instead to avoid precision loss.
                    return upper * 0x100000000 + lower;
                default:
                    throw new Error("Unsupported Uint8Array length. Must be 1, 2, or 4 bytes.");
            }
        },
        /** @param {Uint8Array} uint8Array - Uint8Array to convert to string */
        toString(uint8Array) {
            return String.fromCharCode.apply(null, uint8Array);
        }
    },
    hex: {
        /** @param {string} hex - Hex string to convert to Uint8Array */
        toBase58: (hex) => {
            const num = convert.hex.toBigInt(hex);
            return convert.bigInt.toBase58(num);
        },
        /** @param {string} hex - Hex string to convert to base64 */
        toBase64: (hex) => {
            const uint8Array = convert.hex.toUint8Array(hex);
            return convert.uint8Array.toBase64(uint8Array);
        },
        /** @param {string} hex - Hex string to convert to BigInt */
        toBigInt: (hex) => {
            if (hex.length === 0) { console.error('Hex string is empty'); return false; }

            return BigInt('0x' + hex);
        },
        /** @param {string} hex - Hex string to convert to Uint8Array */
        toUint8Array: (hex) => {
            if (hex.length % 2 !== 0) { throw new Error("The length of the input is not a multiple of 2."); }

            const length = hex.length / 2;
            const uint8Array = new Uint8Array(length);

            for (let i = 0, j = 0; i < length; ++i, j += 2) { uint8Array[i] = parseInt(hex.substring(j, j + 2), 16); }

            return uint8Array;
        },
        /** @param {string} hex - Hex string to convert to bits */
        toBits: (hex = '') => {
            const expectedLength = hex.length / 2 * 8;
            if (hex.length % 2 !== 0) { console.info('The length of the input is not a multiple of 2.'); return false }

            let bitsArray = [];
            for (let i = 0; i < hex.length; i++) {
                const bits = parseInt(hex[i], 16).toString(2).padStart(4, '0');
                bitsArray = bitsArray.concat(bits.split(''));
            }

            const bitsArrayAsNumbers = bitsArray.map(bit => parseInt(bit, 10));
            if (bitsArrayAsNumbers.length !== expectedLength) {
                console.info('Expected length:', expectedLength, 'Actual length:', bitsArrayAsNumbers.length);
                console.info('Hex:', hex);
                console.info('Bits:', bitsArrayAsNumbers);
                return false;
            }

            return bitsArrayAsNumbers;
        },
    },
    string: {
        /** @param {string} str - String to convert to base58 */
        toBase58: (str) => {
            const uint8Array = new TextEncoder().encode(str);
            return convert.uint8Array.toBase58(uint8Array);
        },
        /** @param {string} str - String to convert to base64 */
        toBase64: (str) => {
            const uint8Array = new TextEncoder().encode(str);
            return convert.uint8Array.toBase64(uint8Array);
        },
        /** @param {string} str - String to convert to BigInt */
        toBigInt: (str) => {
            const uint8Array = new TextEncoder().encode(str);
            return convert.uint8Array.toBigInt(uint8Array);
        },
        /** @param {string} str - String to convert to Uint8Array */
        toUint8Array: (str) => {
            return new TextEncoder().encode(str);
        },
        /** @param {string} str - String to convert to hex */
        toHex: (str) => {
            const uint8Array = new TextEncoder().encode(str);
            return convert.uint8Array.toHex(uint8Array);
        },
    },
    /** @param {number} num - Integer to convert to readable */
    formatNumberAsCurrency: (num) => {
        const numberPaddded = num.toString().padStart(6, '0');
        const num2last6 = numberPaddded.toString().slice(-6) || '0';
        const numRest = numberPaddded.toString().slice(0, -6) || '0';
        const separedNum = numRest.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        let formatedValue = `${separedNum}.${num2last6}`.replace(/0+$/, ''); // remove trailing zeros
        if (formatedValue.endsWith('.')) { formatedValue = formatedValue.slice(0, -1); }
        
        return formatedValue;
    },
    /** @param {string} str - String to convert to readable change */
    formatCurrencyAsMicroAmount: (str) => {
        if (!/^[0-9.,]*$/.test(str)) return 0; // only contains 0-9 "," "."

        const [integer, decimal] = str.split('.');
        const integerStr = integer.replace(/,/g, '');
        const decimalStr = decimal ? decimal.padEnd(6, '0').slice(0, 6) : '000000';
        const int = integerStr === '' ? 0 : parseInt(`${integerStr}${decimalStr}`);
        if (isNaN(int)) { console.error('Invalid number:', str); return 0; }

        return int;
    },
    /** @param {number} num - Integer to convert to readable change */
    formatNumberAsCurrencyChange: (num) => {
        const prefix = num < 0 ? '-' : '+';
        return `${prefix}${convert.formatNumberAsCurrency(Math.abs(num))}`;
    }
};

/**
 * This Class is used to convert data between different formats.
 * 
 * Faster than the convert object.
 * 
 * - functions do not check the input data. 
 * - Make sure to validate the data before using this class.
 */
export class FastConverter {
    constructor() {
        this.buffer2 = new ArrayBuffer(2);
        this.view2 = new DataView(this.buffer2);
        this.buffer4 = new ArrayBuffer(4);
        this.view4 = new DataView(this.buffer4);
        this.buffer6 = new ArrayBuffer(6);
        this.view6 = new DataView(this.buffer6);
        this.buffer8 = new ArrayBuffer(8);
        this.view8 = new DataView(this.buffer8);
        this.hexMap = {
            '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
            '8': 8, '9': 9, 'A': 10, 'B': 11, 'C': 12, 'D': 13, 'E': 14, 'F': 15,
            'a': 10, 'b': 11, 'c': 12, 'd': 13, 'e': 14, 'f': 15
        };
        this.buffer12 = new ArrayBuffer(12);
    }

    /** Number should be between 0 and 255 @param {number} num - Integer to convert to 1 byte Uint8Array */
    numberTo1ByteUint8Array(num) {
        return new Uint8Array([num]);
    }
    /** Number should be between 0 and 65535 @param {number} num - Integer to convert to 2 bytes Uint8Array */
    numberTo2BytesUint8Array(num) {
        this.view2.setUint16(0, num, true); // true for little-endian
        return new Uint8Array(this.buffer2);
    }
    /** Number should be between 0 and 4294967295 @param {number} num - Integer to convert to 4 bytes Uint8Array */
    numberTo4BytesUint8Array(num) {
        this.view4.setUint32(0, num, true); // true for little-endian
        return new Uint8Array(this.buffer4);
    }
    /** Number should be between 0 and 281474976710655 @param {number} num - Integer to convert to 6 bytes Uint8Array */
    numberTo6BytesUint8Array(num) {
        // Combine the 6 bytes into one number
        const numBig = BigInt(num);
        const lower = numBig & 0xFFFFFFFFn; // Read the lower 4 bytes
        const upper = numBig >> 32n; // Read the upper 2 bytes
        this.view6.setUint32(0, Number(lower), true);
        this.view6.setUint16(4, Number(upper), true);
        return new Uint8Array(this.buffer6);
    }
    numberTo8BytesUint8Array(num) {
        const bigInt = BigInt(num);
        this.view8.setBigUint64(0, bigInt, true);
        return new Uint8Array(this.buffer8);
    }
    bigIntTo8BytesUint8Array(bigInt) {
        this.view8.setBigUint64(0, bigInt, true);
        return new Uint8Array(this.buffer8);
    }
    /** Number should be between 0 and 281474976710655 @param {number} num - Integer to convert to the smallest Uint8Array possible */
    numberToUint8Array(num) {
        if (num > 281474976710655) { throw new Error('Number out of range: > 281474976710655'); }

        if (num > 4294967295) { return this.numberTo6BytesUint8Array(num); }
        if (num > 65535) { return this.numberTo4BytesUint8Array(num); }
        if (num > 255) { return this.numberTo2BytesUint8Array(num); }
        if (num >= 0) { return this.numberTo1ByteUint8Array(num); }
        
        throw new Error('Number out of range: < 0');
    }
    /** @param {string} hex - Hex string to convert to Uint8Array */
    hexToUint8Array(hex) {
        const length = hex.length / 2;
        const uint8Array = new Uint8Array(length);
        
        for (let i = 0, j = 0; i < length; ++i, j += 2) {
            uint8Array[i] = (this.hexMap[hex[j]] << 4) + this.hexMap[hex[j + 1]];
        }
    
        return uint8Array;
    }
    /** @param {string} hex - Hex string to convert to BigInt */
    hexToBigInt(hex) {
        return BigInt('0x' + hex);
    }

    /** @param {string} str - string to convert to Uint8Array */
    stringToUint8Array(str) {
        return new TextEncoder().encode(str);
    }
    /** @param {string} hex - Hex string to convert to base58 */
    hexToBase58(hex) {
        const num = this.hexToBigInt(hex);

        let base58 = '';
        let n = num;
        while (n > 0) {
            const remainder = n % BigInt(58);
            base58 = base58AlphabetArray[Number(remainder)] + base58;
            n = n / BigInt(58);
        }

        const bytes = isNode ? Buffer.from(base58) : new TextEncoder().encode(base58);

        for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
            base58 = '1' + base58;
        }

        return base58;
    }
    /** @param {string} base58 - Base58 string to convert to Hex */
    base58ToHex(base58, minLength = 0) {
        let num = BigInt(0);
        const base = BigInt(58);
        for (const char of base58) { num = num * base + BigInt(base58Alphabet[char]); }

        let hex = num.toString(16);
        if (hex.length % 2 !== 0) { hex = '0' + hex; }
        if (minLength > 0) { hex = hex.padStart(minLength, '0'); }
        return hex;
    }
    /** @param {string} addressBase58 - Base58 address to convert to Uint8Array(16 bytes) */
    addressBase58ToUint8Array(addressBase58) {
        const hex = this.base58ToHex(addressBase58, 32);
        return this.hexToUint8Array(hex);
    }
    /** @param {Uint8Array} addressUint8Array - Uint8Array(16 bytes) to convert to base58 */
    addressUint8ArrayToBase58(addressUint8Array) {
        const hex = this.uint8ArrayToHex(addressUint8Array, 32);
        //if (hex.length !== 32) { throw new Error('Invalid address length'); }
        return this.hexToBase58(hex);
    }
    /** @param {Uint8Array} uint8Array - Uint8Array to convert to string */
    uint8ArrayToHex(uint8Array, minLength = 0) {
        let hexStr = '';
        uint8Array.forEach(byte => hexStr += byte.toString(16).padStart(2, '0'));
        if (minLength > 0) { hexStr = hexStr.padStart(minLength, '0'); }
        return hexStr;
    }
    /** @param {Uint8Array} uint8Array - Uint8Array to convert to number */
    uint81ByteToNumber(uint8Array) {
        return uint8Array[0];
    }
    /** @param {Uint8Array} uint8Array - Uint8Array to convert to number */
    uint82BytesToNumber(uint8Array) {
        this.view2.setUint8(0, uint8Array[0]);
        this.view2.setUint8(1, uint8Array[1]);
        return this.view2.getUint16(0, true);
    }
    /** @param {Uint8Array} uint8Array - Uint8Array to convert to number */
    uint84BytesToNumber(uint8Array) {
        this.view4.setUint8(0, uint8Array[0]);
        this.view4.setUint8(1, uint8Array[1]);
        this.view4.setUint8(2, uint8Array[2]);
        this.view4.setUint8(3, uint8Array[3]);
        return this.view4.getUint32(0, true);
    }
    /** @param {Uint8Array} uint8Array - Uint8Array to convert to number */
    uint86BytesToNumber(uint8Array) {
        for (let i = 0; i < 8; i++) { this.view8.setUint8(i, 0); }
        for (let i = 0; i < 6; i++) { this.view8.setUint8(i, uint8Array[i]); }
        return Number(this.view8.getBigUint64(0, true));
    }
    /** @param {Uint8Array} uint8Array - Uint8Array to convert to number */
    uint88BytesToNumber(uint8Array) {
        for (let i = 0; i < 8; i++) { this.view8.setUint8(i, uint8Array[i]); }
        return Number(this.view8.getBigUint64(0, true));
    }
    /** @param {Uint8Array} uint8Array - Uint8Array to convert to bigInt */
    uint88BytesToBigInt(uint8Array) {
        for (let i = 0; i < 8; i++) { this.view8.setUint8(i, uint8Array[i]); }
        return this.view8.getBigUint64(0, true);
    }
};