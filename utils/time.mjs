import { MiniLogger } from '../miniLogger/mini-logger.mjs';
import ntpClient from 'ntp-client';

class TimeSynchronizer {
    currentServerIndex = 0;
    ntpPort = 123;
    syncInterval = 600_000; // 10 minutes
    epochInterval = 300_000; // 5 minutes
    roundInterval = 60_000; // 1 minute
    retryAttempts = 5;
    retryDelay = 5000;
    autoStart = true;
    stop = false;
    lastSyncedTime = null;
    offset = 0; // Time offset between system time and NTP time
    ntpServers = ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org', '3.pool.ntp.org'];
    /** 
     * @param {Object} options
     * @param {string[]} options.ntpServers
     * @param {number} options.ntpPort
     * @param {number} options.syncInterval
     * @param {number} options.epochInterval
     * @param {number} options.roundInterval
     * @param {number} options.retryAttempts
     * @param {number} options.retryDelay
     * @param {boolean} options.autoStart
     */
    constructor(options = {}) {
        /** @type {MiniLogger} */
        this.miniLogger = new MiniLogger('TimeSynchronizer');
        this.ntpServers = options.ntpServers || this.ntpServers;
        this.ntpPort = options.ntpPort || this.ntpPort;
        this.syncInterval = options.syncInterval || this.syncInterval;
        this.epochInterval = options.epochInterval || this.epochInterval;
        this.roundInterval = options.roundInterval || this.roundInterval;
        this.retryAttempts = options.retryAttempts || this.retryAttempts;
        this.retryDelay = options.retryDelay || this.retryDelay;
        this.autoStart = options.autoStart !== undefined ? options.autoStart : this.autoStart;
        if (this.autoStart) { this.#startSyncLoop(); }
    }
    async syncTimeWithRetry(attempts = this.retryAttempts, delay = this.retryDelay) {
        const ntpServer = this.ntpServers[this.currentServerIndex];
        this.miniLogger.log(`Attempting NTP sync with ${ntpServer}. Attempts left: ${attempts}`, (m) => { console.log(m); });

        for (let i = 0; i < attempts; i++) {
            try {
                await this.syncTimeWithNTP();
                const readableTime = new Date(this.getCurrentTime()).toLocaleString();
                this.miniLogger.log(`Time synchronized after ${i + 1} attempts, current time: ${readableTime}`, (m) => { console.log(m); });
                return true;
            } catch (err) {
                this.currentServerIndex = (this.currentServerIndex + 1) % this.ntpServers.length; // rotate to the next server
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        this.miniLogger.log(`Failed to sync with NTP after ${this.retryAttempts} attempts`, (m) => { console.warn(m); });
    }
    async #startSyncLoop() {
        while (true) {
            await new Promise(resolve => setTimeout(resolve, this.syncInterval));
            if (this.stop) { return; }
            await this.syncTimeWithRetry(); // Re-sync every syncInterval with retry
        }
    }
    async syncTimeWithNTP() {
        const ntpServer = this.ntpServers[this.currentServerIndex];
        this.miniLogger.log(`Syncing time with NTP server: ${ntpServer}`, (m) => { console.log(m); });
        return new Promise((resolve, reject) => {
            ntpClient.getNetworkTime(ntpServer, this.ntpPort, (err, date) => {
                if (err) {
                    this.miniLogger.log(`Failed to sync time with NTP server: ${err}`, (m) => { console.error(m); });
                    return reject(err);
                }
                
                const systemTime = Date.now();
                const offset = date.getTime() - systemTime;
                if (Math.abs(offset) > 600_000) {
                    this.miniLogger.log(`Large time offset detected: ${offset} ms`, (m) => { console.warn(m); });
                    return reject('Large time offset');
                }

                this.offset = offset;
                this.lastSyncedTime = date;
                this.miniLogger.log(`Time synchronized. Offset: ${this.offset} ms`, (m) => { console.log(m); });
                return resolve(this.offset);
            });
        });
    }

    // Get the synchronized current time
    getCurrentTime() {
        return Date.now() + this.offset;
    }
}

export { TimeSynchronizer };
export default TimeSynchronizer;