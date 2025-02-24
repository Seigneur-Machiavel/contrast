class FrontStorage {
    initiator;
    constructor(initiator = 'global') { this.initiator = initiator; }

    save(key, value) {
        const valueType = typeof value;
        localStorage.setItem(`${this.initiator}-${key}-type`, valueType);

        if (valueType === 'object') value = JSON.stringify(value);
        localStorage.setItem(`${this.initiator}-${key}`, value);

        console.log(`[FrontStorage] ${key} saved, value: ${value}`);
    }
    load(key, parsing = 'default') {
        const valueType = localStorage.getItem(`${this.initiator}-${key}-type`);
        if (!valueType) return null;
        let value = localStorage.getItem(`${this.initiator}-${key}`);

        if (parsing === 'default') {
            if (valueType === 'object') value = JSON.parse(value);
            if (valueType === 'number') value = parseFloat(value);
            if (valueType === 'boolean') value = value === 'true';

            if (typeof value !== valueType) {
                console.error(`[FrontStorage] Error: ${key} is not a ${valueType}`);
                return null;
            }
        }

        console.log(`[FrontStorage] ${key} loaded, value: ${value}`);
        return value;
    }
}

module.exports = { FrontStorage };