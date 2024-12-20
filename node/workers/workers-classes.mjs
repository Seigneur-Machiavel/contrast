import utils from '../src/utils.mjs';

/**
 * @typedef {import("../src/block-classes.mjs").BlockData} BlockData
 */

// CLASS FOR EASY USAGE OF THE WORKER
export class ValidationWorker {
    constructor (id = 0) {
        this.id = id;
        this.state = 'idle';

        /** @type {Worker} worker */
        this.worker = utils.newWorker('../workers/validation-worker-nodejs.mjs');
        this.worker.on('exit', (code) => { console.log(`ValidationWorker ${this.id} stopped with exit code ${code}`); });
        this.worker.on('close', () => { console.log('ValidationWorker ${this.id} closed'); });
    }
    addressOwnershipConfirmation(involvedUTXOs, transactions, impliedKnownPubkeysAddresses, useDevArgon2) {
        /** @type {Promise<{ discoveredPubKeysAddresses: {}, isValid: boolean }>} */
        const promise = new Promise((resolve, reject) => {
            this.worker.postMessage({
                id: this.id,
                type: 'addressOwnershipConfirmation',
                involvedUTXOs,
                transactions,
                impliedKnownPubkeysAddresses,
                useDevArgon2,
            });
            this.worker.on('message', (message) => {
                if (message.id !== this.id) { return; }
                if (message.error) { return reject({ isValid: message.isValid, error: message.error }); }
                    //reject(message.error); }

                const result = {
                    discoveredPubKeysAddresses: message.discoveredPubKeysAddresses,
                    isValid: message.isValid
                };
                //console.info(`ValidationWorker ${this.id} addressOwnershipConfirmation result: ${JSON.stringify(result)}`);
                resolve(result);
            });
        });
        return promise;
    }
    terminateAsync() {
        //console.info(`ValidationWorker ${this.id} terminating...`);
        this.worker.postMessage({ type: 'terminate', id: this.id });
        return new Promise((resolve, reject) => {
            this.worker.on('message', (message) => {
                if (message.id !== this.id) { return; }
                if (!message.error) { return } 
                console.error(message.error);
                reject(message.error);
            });
            this.worker.on('exit', (code) => {
                resolve();
            });
        });
    }
}

export class MinerWorker {
    constructor (rewardAddress = '', bet = 0, timeOffset = 0) {
        this.terminate = false;
        this.rewardAddress = rewardAddress;
        this.bet = bet;
        this.timeOffset = timeOffset;
        /** @type {BlockData} */
        this.blockCandidate = null;
        
        /** @type {BlockData} */
        this.result = null;
        this.isWorking = false;
        this.hashRate = 0;
        //this.totalHashCount = 0;
        this.startTime = Date.now();

        /** @type {Worker} worker */
        this.worker = utils.newWorker('../workers/miner-worker-nodejs.mjs');
        this.worker.on('close', () => { console.log('MinerWorker closed'); });
        this.worker.on('message', (message) => {
            if (message.hashCount) {
                const upTime = Date.now() - this.startTime;
                const hashRate = message.hashCount / upTime * 1000;
                this.hashRate = hashRate;

                this.startTime = Date.now();
                //this.totalHashCount += message.hashCount;
                //console.log(`MinerWorker totalHashCount: ${this.totalHashCount}`);
                return;
            }

            if (message.result.error) {
                console.error(message.result.error);
            } else {
                this.result = message.result;
            }

            this.isWorking = false;
        });
    }

    async updateInfo(rewardAddress, bet, timeOffset) {
        if (this.terminate) { return; }
        const isSame = this.rewardAddress === rewardAddress && this.bet === bet && this.timeOffset === timeOffset;
        if (isSame) { return; }

        this.rewardAddress = rewardAddress;
        this.bet = bet;
        this.timeOffset = timeOffset;

        this.worker.postMessage({ type: 'updateInfo', rewardAddress, bet, timeOffset });

        // await 200 ms to allow the worker to process the new info
        return new Promise(resolve => setTimeout(resolve, 200));
    }
    /** @param {BlockData} blockCandidate */
    async updateCandidate(blockCandidate) {
        if (this.terminate) { return; }
        if (this.#isSameBlockCandidate(blockCandidate)) { return; }

        this.blockCandidate = blockCandidate;
        this.worker.postMessage({ type: 'newCandidate', blockCandidate });

        // await 200 ms to allow the worker to process the new candidate
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    /** @param {BlockData} blockCandidate */
    #isSameBlockCandidate(blockCandidate) {
        if (this.blockCandidate === null) { return false; }

        const sameIndex = this.blockCandidate.index === blockCandidate.index;
        const samePrevHash = this.blockCandidate.prevHash === blockCandidate.prevHash;

        const currentCandidateValidatorAddress = this.blockCandidate.Txs[0].outputs[0].address;
        const newCandidateValidatorAddress = blockCandidate.Txs[0].outputs[0].address;
        const sameValidatorAddress = currentCandidateValidatorAddress === newCandidateValidatorAddress;

        return sameIndex && samePrevHash && sameValidatorAddress;
    }
    async mineUntilValid() {
        if (this.terminate) { return; }
        if (this.isWorking) { return; }
        this.isWorking = true;
        this.result = null;

        this.worker.postMessage({
            type: 'mineUntilValid',
            rewardAddress: this.rewardAddress,
            bet: this.bet,
            timeOffset: this.timeOffset
        });
    }
    getResultAndClear() {
        const finalizedBlock = this.result;
        this.result = null;
        return finalizedBlock;
    }
    pause() {
        this.worker.postMessage({ type: 'pause' });
    }
    resume() {
        this.worker.postMessage({ type: 'resume' });
    }
    terminateAsync() {
        this.terminate = true;
        this.worker.postMessage({ type: 'terminate' });
        return new Promise((resolve, reject) => {
            this.worker.on('exit', (code) => {
                console.log(`MinerWorker stopped with exit code ${code}`);
                resolve();
            });
            this.worker.on('close', () => {
                console.log('MinerWorker closed');
                resolve();
            });

            setTimeout(() => {
                console.error('MinerWorker termination timeout');
                resolve();
            }, 5000);
        });
    }
}

export class AccountDerivationWorker {
    constructor (id = 0) {
        this.id = id;
        this.state = 'idle';

        /** @type {Worker} worker */
        this.worker = utils.isNode ?
        utils.newWorker('../workers/account-worker-nodejs.mjs') :
        utils.newWorker(undefined, accountWorkerCode);
    }
    async derivationUntilValidAccount(seedModifierStart, maxIterations, masterHex, desiredPrefix) {
        this.state = 'working';

        if (utils.isNode) {
            this.worker.removeAllListeners();
        } else {
            this.worker.onmessage = null;
        }
        //this.promise = new Promise((resolve, reject) => {
        const promise = new Promise((resolve, reject) => {
            if (utils.isNode) {
                this.state = 'working';
                this.worker.on('exit', (code) => { console.log(`DerivationWorker ${this.id} stopped with exit code ${code}`); });
                this.worker.on('close', () => { console.log('DerivationWorker ${this.id} closed'); });
                this.worker.on('message', (message) => {
                    if (message.id !== this.id) { return; }
                    if (message.error) { return reject({ isValid: message.isValid, error: message.error }); }

                    //response = { id, isValid: false, seedModifierHex: '', pubKeyHex: '', privKeyHex: '', addressBase58: '', error: false };
                    const result = {
                        id: message.id,
                        isValid: message.isValid,
                        seedModifierHex: message.seedModifierHex,
                        pubKeyHex: message.pubKeyHex,
                        privKeyHex: message.privKeyHex,
                        addressBase58: message.addressBase58,
                        iterations: message.iterations
                    };

                    resolve(result);
                });
            } else {
                this.state = 'working';
                this.worker.onmessage = (e) => {
                    const message = e.data;
                    if (message.error) { return reject({ isValid: message.isValid, error: message.error }); }

                    //response = { id, isValid: false, seedModifierHex: '', pubKeyHex: '', privKeyHex: '', addressBase58: '', error: false };
                    const result = {
                        id: message.id,
                        isValid: message.isValid,
                        seedModifierHex: message.seedModifierHex,
                        pubKeyHex: message.pubKeyHex,
                        privKeyHex: message.privKeyHex,
                        addressBase58: message.addressBase58,
                        iterations: message.iterations
                    };

                    resolve(result);
                };
            }

            this.worker.postMessage({
                id: this.id,
                type: 'derivationUntilValidAccount',
                seedModifierStart,
                maxIterations,
                masterHex,
                desiredPrefix
            });
        });
        const resolvedPromise = await promise;
        this.state = 'idle';
        //console.log(`DerivationWorker ${this.id} derivationUntilValidAccount result: ${JSON.stringify(resolvedPromise)}`);
        return resolvedPromise;
    }
    abortOperation() {
        if (this.state === 'idle') { return; }
        this.worker.postMessage({ type: 'abortOperation' });
    }
    terminateAsync() {
        //console.info(`DerivationWorker ${this.id} terminating...`);
        this.worker.postMessage({ type: 'terminate', id: this.id });
        return new Promise((resolve, reject) => {
            this.worker.on('message', (message) => {
                if (message.id !== this.id) { return; }
                if (message.error) { return reject(message.error); }
                resolve();
            });
            this.worker.on('exit', (code) => {
                console.log(`DerivationWorker ${this.id} stopped with exit code ${code}`);
                resolve();
            });
        });
    }
}