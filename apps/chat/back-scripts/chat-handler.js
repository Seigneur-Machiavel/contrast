if (false) {
    const { BrowserWindow } = require('electron');
    const { MiniLogger } = require('../../../miniLogger/mini-logger.js');
}

/**
 * @typedef {{name: string, size: number, type: string, content: Uint8Array}} FileData
 */

const { ipcMain, dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');

class P2PChatHandler {
    /** @param {BrowserWindow} mainWindow @param {MiniLogger} miniLogger */
    constructor(mainWindow, miniLogger) {
        this.miniLogger = miniLogger;
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

    /**
     * @param {'info'|'error'|'success'|'file'|'network'|'peer'} type
     * @param {string} action
     */
    log(type, action, data) {
        const emojis = {
            info: '📝', error: '❌', success: '✅', 
            file: '📁', network: '🔗', peer: '👤'
        };
        this.miniLogger.log('chat', `${emojis[type]} [${action}]`, data);
    }

    setupP2PEvents(p2pInstance) {
        this.log('network', 'setup', 'Initializing P2P events');
        this.events.forEach(event => {
            const handler = data => {
                this.log('info', event, data);
                this.mainWindow.webContents.send(event, data);
            };
            p2pInstance.on(event, handler);
        });
    }

    /** @param {string} nickname */
    async startChat(event, nickname, listenAddr) {
        while (!this.P2P) {
            this.miniLogger.warn('chat', 'P2P module not initialized yet');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        try {
            console.log('Starting chat with', nickname, listenAddr);
            this.p2p = new this.P2P(nickname,listenAddr);
            this.setupP2PEvents(this.p2p);
            const addr = await this.p2p.start();
            this.log('success', 'chat-started', { nickname, addr });
            return { success: true, addr };
        } catch (err) {
            this.log('error', 'start-chat-failed', err);
            return { success: false, error: err.message };
        }
    }

    /** @param {{channel: string, file: FileData}} param1 */
    async shareFile(event, { channel, file }) {
        if (!file?.content) throw new Error('Invalid file data received');
        
        this.log('file', 'share-start', { name: file.name, size: file.size });
        try {
            const fileId = await this.p2p.shareFile(channel, {
                ...file,
                stream: async function* () { yield new Uint8Array(file.content); }
            });
            this.log('success', 'share-complete', { fileId, name: file.name });
            return { success: true, fileId };
        } catch (err) {
            this.log('error', 'share-failed', err);
            return { success: false, error: err.message };
        }
    }

    /** @param {{cid: string}} param1 */
    async downloadFile(event, { cid }) {
        this.log('file', 'download-start', { cid });
        try {
            const { content, metadata } = await this.p2p.downloadFile(cid);
            const { filePath } = await dialog.showSaveDialog(this.mainWindow, {
                defaultPath: path.join(app.getPath('downloads'), metadata.filename),
                filters: [{ name: 'All Files', extensions: ['*'] }]
            });
            
            if (!filePath) throw new Error('Save cancelled by user');
            
            fs.writeFileSync(filePath, Buffer.from(content));
            this.log('success', 'download-complete', { path: filePath, metadata });
            return { success: true, metadata, path: filePath };
        } catch (err) {
            this.log('error', 'download-failed', err);
            return { success: false, error: err.message };
        }
    }

    /** @param {{channel: string, content: string}} param1 */
    async sendMessage(event, { channel, content }) {
        return this.wrapP2PCall('send-message', () => this.p2p.sendMessage(channel, content));
    }

    /** @param {string} channel */
    async joinChannel(event, channel) {
        return this.wrapP2PCall('join-channel', () => this.p2p.joinChannel(channel));
    }

    /** @param {string} addr */
    async connectPeer(event, addr) {
        try {
            const connected = await this.p2p.connectToPeer(addr);
            this.log('network', 'connect-peer', `Connection ${connected ? 'succeeded' : 'failed'} to ${addr}`);
            return { 
                success: connected, // Actually use the connection result
                error: connected ? null : 'Failed to establish connection'
            };
        } catch (err) {
            this.log('error', 'connect-peer', `Connection failed to ${addr}: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    /** @param {string} action @param {Function} fn */
    async wrapP2PCall(action, fn) {
        try {
            await fn();
            this.log('success', action, 'completed');
            return { success: true };
        } catch (err) {
            this.log('error', action, err);
            return { success: false, error: err.message };
        }
    }

    setupHandlers() {
        this.log('info', 'setup', 'Registering IPC handlers');
        for (const [name, handler] of Object.entries(this.handlers)) {
            ipcMain.handle(name, async (event, ...args) => {
                try {
                    this.log('info', `${name}-called`, args);
                    return await handler(event, ...args);
                } catch (err) {
                    this.log('error', name, err);
                    return { success: false, error: err.message };
                }
            });
        }

        return this.handlers;
    }

    async cleanup() {
        // Stop P2P network
        if (this.p2p) {
            try {
                await this.p2p.stop();
                this.p2p = null;
                this.log('success', 'cleanup', 'P2P network stopped cleanly');
            } catch (err) {
                this.log('error', 'cleanup', `Failed to stop P2P: ${err.message}`);
                throw err; // Propagate error for proper error handling
            }
        }

        // Remove IPC handlers
        const appHandlers = Object.keys(this.handlers);
        for (const key of appHandlers) ipcMain.removeHandler(key);
    }
}

module.exports = { P2PChatHandler };