if (false) {
    const { BrowserWindow } = require('electron');
}

/**
 * @typedef {{name: string, size: number, type: string, content: Uint8Array}} FileData
*/

const { MiniLogger } = require('../../../miniLogger/mini-logger.js');
const { ipcMain, dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');

class P2PChatHandler {
    /** @param {BrowserWindow} mainWindow */
    constructor(mainWindow) {
        /** @type {MiniLogger} */
        this.miniLogger = new MiniLogger('chat');
        /** @type {BrowserWindow} */
        this.mainWindow = mainWindow;
        this.p2p = null;
        
        this.events = ['message', 'peer-joined', 'peer-left', 'file-progress', 'file-complete', 'peer-connecting'];

        this.handlers = {
            'start-chat': this.startChat.bind(this),
            'send-message': this.sendMessage.bind(this),
            'join-channel': this.joinChannel.bind(this),
            'connect-peer': this.connectPeer.bind(this),
            'share-file': this.shareFile.bind(this),
            'download-file': this.downloadFile.bind(this)
        };

        // Initialize module right away but don't block constructor
        this.P2P;
        this.#initP2PModule();
    }

    async #initP2PModule() {
        const { P2P } = await import('./p2p.mjs');
        this.P2P = P2P;
    }

    setupP2PEvents(p2pInstance) {
        this.miniLogger.log('Setting up P2P events', (m) => { console.log(m); });
        this.events.forEach(event => {
            const handler = data => {
                this.miniLogger.log(`P2P event ${event} received`, (m) => { console.log(m); });
                this.mainWindow.webContents.send(event, data);
            };
            p2pInstance.on(event, handler);
        });
    }

    /** @param {string} nickname */
    async startChat(event, nickname, listenAddr) {
        while (!this.P2P) {
            this.miniLogger.log('P2P module not initialized yet', (m) => { console.warn(m); });
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        try {
            this.miniLogger.log(`Starting chat with ${nickname} on ${listenAddr}`, (m) => { console.log(m); });
            this.p2p = new this.P2P(nickname, listenAddr);
            this.setupP2PEvents(this.p2p);
            const addr = await this.p2p.start();
            
            this.miniLogger.log(`Chat started with ${nickname} on ${addr}`, (m) => { console.log(m); });
            return { success: true, addr };
        } catch (err) {
            this.miniLogger.log(err, (m) => { console.error(m); });
            return { success: false, error: err.message };
        }
    }

    /** @param {{channel: string, file: FileData}} param1 */
    async shareFile(event, { channel, file }) {
        if (!file?.content) {
            this.miniLogger.log('Invalid file data received', (m) => { console.error(m); });
            return { success: false, error: 'Invalid file data received' };
        }
        
        this.miniLogger.log(`Sharing file on channel ${channel}: ${file.name}`, (m) => { console.log(m); });
        try {
            const fileId = await this.p2p.shareFile(channel, {
                ...file,
                stream: async function* () { yield new Uint8Array(file.content); }
            });
            this.miniLogger.log(`File shared on channel ${channel}: ${file.name}`, (m) => { console.log(m); });
            return { success: true, fileId };
        } catch (err) {
            this.miniLogger.log(err, (m) => { console.error(m); });
            return { success: false, error: err.message };
        }
    }

    /** @param {{cid: string}} param1 */
    async downloadFile(event, { cid }) {
        this.miniLogger.log(`Downloading file ${cid}`, (m) => { console.log(m); });
        try {
            const { content, metadata } = await this.p2p.downloadFile(cid);
            const { filePath } = await dialog.showSaveDialog(this.mainWindow, {
                defaultPath: path.join(app.getPath('downloads'), metadata.filename),
                filters: [{ name: 'All Files', extensions: ['*'] }]
            });
            
            if (!filePath) {
                this.miniLogger.log('Save cancelled by user', (m) => { console.log(m); });
                return { success: false, error: 'Save cancelled by user' };
            }
            
            fs.writeFileSync(filePath, Buffer.from(content));
            this.miniLogger.log(`File downloaded to ${filePath}`, (m) => { console.log(m); });
            return { success: true, metadata, path: filePath };
        } catch (err) {
            this.miniLogger.log(err, (m) => { console.error(m); });
            return { success: false, error: err.message };
        }
    }

    /** @param {{channel: string, content: string}} param1 */
    async sendMessage(event, { channel, content }) {
        try {
            await this.p2p.sendMessage(channel, content);
            this.miniLogger.log(`Message sent to ${channel}: ${content.slice(0, 50)}`, (m) => { console.log(m); });
            return { success: true };
        } catch (err) {
            this.miniLogger.log(err, (m) => { console.error(m); });
            return { success: false, error: err.message };
        }
    }

    /** @param {string} channel */
    async joinChannel(event, channel) {
        try {
            await this.p2p.joinChannel(channel);
            this.miniLogger.log(`Joined channel ${channel}`, (m) => { console.log(m); });
            return { success: true };
        } catch (err) {
            this.miniLogger.log(err, (m) => { console.error(m); });
            return { success: false, error: err.message };
        }
    }

    /** @param {string} addr */
    async connectPeer(event, addr) {
        try {
            const connected = await this.p2p.connectToPeer(addr);
            this.miniLogger.log(`Connection ${connected ? 'succeeded' : 'failed'} to ${addr}`, (m) => { console.log(m); });
            return { 
                success: connected,
                error: connected ? null : 'Failed to establish connection'
            };
        } catch (err) {
            this.miniLogger.log(err, (m) => { console.error(m); });
            return { success: false, error: err.message };
        }
    }

    setupHandlers() {
        this.miniLogger.log('Registering IPC handlers', (m) => { console.log(m); });
        for (const [name, handler] of Object.entries(this.handlers)) {
            ipcMain.handle(name, async (event, ...args) => {
                try {
                    this.miniLogger.log(`IPC handler ${name} called`, (m) => { console.log(m); });
                    return await handler(event, ...args);
                } catch (err) {
                    this.miniLogger.log(err, (m) => { console.error(m); });
                    return { success: false, error: err.message };
                }
            });
        }
        return this.handlers;
    }

    async cleanup() {
        if (this.p2p) {
            try {
                await this.p2p.stop();
                this.p2p = null;
                this.miniLogger.log('P2P network stopped cleanly', (m) => { console.log(m); });
            } catch (err) {
                this.miniLogger.log(err, (m) => { console.error(m); });
                throw err;
            }
        }

        const appHandlers = Object.keys(this.handlers);
        for (const key of appHandlers) { ipcMain.removeHandler(key); }
    }
}

module.exports = { P2PChatHandler };