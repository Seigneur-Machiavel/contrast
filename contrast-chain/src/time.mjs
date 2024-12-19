import ntpClient from 'ntp-client';

class TimeSynchronizer {
    constructor(options = {}) {
        this.ntpServers = options.ntpServers || [
            '0.pool.ntp.org',
            '1.pool.ntp.org',
            '2.pool.ntp.org',
            '3.pool.ntp.org'
        ];
        this.currentServerIndex = 0;
        this.ntpPort = options.ntpPort || 123;
        this.syncInterval = options.syncInterval || 600_000; // 10 minutes
        this.epochInterval = options.epochInterval || 300_000; // 5 minutes
        this.roundInterval = options.roundInterval || 60_000; // 1 minute
        this.retryAttempts = options.retryAttempts || 5;
        this.retryDelay = options.retryDelay || 5000; // 5 seconds delay between retries
        this.autoStart = options.autoStart === undefined ? true : options.autoStart; // Add this line
        this.stop = false;

        this.lastSyncedTime = null;
        this.offset = 0; // Time offset between system time and NTP time

        if (this.autoStart) {
            this.#startSyncLoop(); // Start the sync loop only if autoStart is true
        }
    }

    getCurrentNtpServer() {
        return this.ntpServers[this.currentServerIndex];
    }

    rotateNtpServer() {
        this.currentServerIndex = (this.currentServerIndex + 1) % this.ntpServers.length;
    }

    async syncTimeWithRetry(attempts = this.retryAttempts, delay) {
        console.log(`Attempting NTP sync with ${this.getCurrentNtpServer()}. Attempts left: ${attempts}`);

        for (let i = 0; i < attempts; i++) {
            try {
                await this.syncTimeWithNTP();
                const readableTime = new Date(this.getCurrentTime()).toLocaleString();
                console.log(`Time synchronized after ${i + 1} attempts, current time: ${readableTime}`);
                return true;
            } catch (err) {
                this.rotateNtpServer();
                await new Promise(resolve => setTimeout(resolve, delay || this.retryDelay));
            }
        }

        console.warn(`Failed to sync with NTP after ${this.retryAttempts} attempts`);
    }
    async #startSyncLoop() {
        while (true) {
            await new Promise(resolve => setTimeout(resolve, this.syncInterval));
            if (this.stop) { return; }
            await this.syncTimeWithRetry(); // Re-sync every syncInterval with retry
        }
    }
    
    async syncTimeWithNTP() {
        console.log(`Syncing time with NTP server: ${this.getCurrentNtpServer()}`);
        return new Promise((resolve, reject) => {
            ntpClient.getNetworkTime(this.getCurrentNtpServer(), this.ntpPort, (err, date) => {
                if (err) {
                    console.error(`Failed to sync time with NTP server: ${err}`);
                    return reject(err);
                }
                
                const systemTime = Date.now();
                const offset = date.getTime() - systemTime;
                if (Math.abs(offset) > 600_000) {
                    console.warn(`Large time offset detected: ${offset} ms`);
                    return reject('Large time offset');
                }

                this.offset = offset;
                this.lastSyncedTime = date;
                console.log(`Time synchronized. Offset: ${this.offset} ms`);
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
