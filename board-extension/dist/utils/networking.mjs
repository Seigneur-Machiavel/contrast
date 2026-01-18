export class PendingRequest {
	/** @type {Function | undefined} */ #resolve;
	/** @type {Function | undefined} */ #reject;
	/** @type {NodeJS.Timeout | undefined} */ #timeout;

	/** @param {string} peerId @param {string} type @param {number} [timeout] */
	constructor(peerId, type, timeout = 3000) {
		this.peerId = peerId;
		this.type = type;
		
		this.promise = new Promise((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
			this.#timeout = setTimeout(() => reject(new Error(`Request timeout`)), timeout);
		});
	}
	/** @param {any} data */
	complete(data) {
		clearTimeout(this.#timeout);
		this.#resolve?.(data);
	}
	/** @param {any} error */
	fail(error) {
		clearTimeout(this.#timeout);
		this.#reject?.(error);
	}
}