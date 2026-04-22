// front-crypto-wrapper.mjs
// Drop-in async interface for argon2+xchacha operations offloaded to a Worker.
// Usage:
//   const crypto = new FrontCryptoWorker();
//   const encrypted = await crypto.cipher(uint8Data, 'my-password');
//   const decrypted = await crypto.decipher(encrypted, 'my-password');

export class FrontCryptoWorker {

	/** Pending promise callbacks, keyed by message id 
	 * @type {Object<string, { resolve: function, reject: function }>} */
    #pending = {};
    #nextId  = 0;
    #worker;

    constructor(workerPath = './front-crypto-worker.mjs') {
        this.#worker = new Worker(new URL(workerPath, import.meta.url), { type: 'module' });
        this.#worker.onmessage = ({ data }) => this.#onMessage(data);
        this.#worker.onerror   = (e) => this.#onWorkerError(e);
    }

	/** Handle incoming messages from the worker, resolve or reject the corresponding promise */
    #onMessage({ id, result, error }) {
        const pending = this.#pending[id];
        if (!pending) return;
        delete this.#pending[id];
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
    }

	/** Reject all pending promises if the worker crashes */
    #onWorkerError(e) {
		for (const id in this.#pending) this.#pending[id].reject(new Error(`Worker error: ${e.message}`));
        this.#pending = {};
    }

    /** Send a message to the worker, return a promise that resolves with the result */
    #dispatch(op, payload, transfer = []) {
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#pending[id] = { resolve, reject };
            this.#worker.postMessage({ id, op, payload }, transfer);
        });
    }

    /** Encrypt data with a password using Argon2Id + XChaCha20-Poly1305
     * @param {Uint8Array} data @param {string} password @returns {Promise<Uint8Array>} */
    cipher(data, password) {
        // Transfer data.buffer — avoids memory copy (data becomes unusable after this call)
        return this.#dispatch('cipher', { data, password }, [data.buffer]);
    }

    /** Decrypt a blob produced by cipher()
     * @param {Uint8Array} blob @param {string} password @returns {Promise<Uint8Array>} */
    decipher(blob, password) {
        return this.#dispatch('decipher', { blob, password }, [blob.buffer]);
    }

    /** Terminate the worker when no longer needed */
    terminate() { this.#worker.terminate(); }
}
