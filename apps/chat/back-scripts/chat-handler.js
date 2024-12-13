if (false) {
    const { BrowserWindow } = require('electron');
}

/**
 * @typedef {{name: string, size: number, type: string, content: Uint8Array}} FileData
 */

const { ipcMain, dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');

class P2PChatHandler {
    /** @param {BrowserWindow} mainWindow */
    constructor(mainWindow) {
        /** @type {BrowserWindow} */
        this.mainWindow = mainWindow;
        this.p2p = null;
        
        this.events = ['message', 'peer-joined', 'peer-left', 'file-progress', 'file-complete', 'peer-connecting'];

        this.boundHandlers = {
            'start-chat': this.startChat.bind(this),
            'send-message': this.sendMessage.bind(this),
            'join-channel': this.joinChannel.bind(this),
            'connect-peer': this.connectPeer.bind(this),
            'share-file': this.shareFile.bind(this),
            'download-file': this.downloadFile.bind(this)
        };

        // Wizard: Auto-map kebab-case names to camelCase methods
        this.handlers = Object.fromEntries(
            ['start-chat', 'send-message', 'join-channel', 'connect-peer', 'share-file', 'download-file']
            .map(name => [name, this[name.replace(/-./g, x => x[1].toUpperCase())]])
        );

        // Initialize module right away but don't block constructor
        this.moduleReady = this.#initP2PModule();
        
    }

    async #initP2PModule() {
        const { P2P } = await import('./p2p.mjs');
        return P2P;
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
        console.log(`${emojis[type]} [${action}]`, data);
    }
    
    setupP2PEvents(p2pInstance) {
        this.log('network', 'setup', 'Initializing P2P events');
        // Wizard: Simple loop through event array since event names are identical
        this.events.forEach(event => {
            const handler = data => {
                this.log('info', event, data);
                this.mainWindow.webContents.send(event, data);
            };
            p2pInstance.on(event, handler);
        });
    }

    /** @param {string} nickname */
    async startChat(event, nickname) {
        try {
            const P2P = await this.moduleReady;
            this.p2p = new P2P(nickname);
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
        return this.wrapP2PCall('connect-peer', () => this.p2p.connectToPeer(addr));
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
        Object.entries(this.boundHandlers).forEach(([name, handler]) => {
            ipcMain.handle(name, async (event, ...args) => {
                try {
                    this.log('info', `${name}-called`, args);
                    return await handler(event, ...args);
                } catch (err) {
                    this.log('error', name, err);
                    return { success: false, error: err.message };
                }
            });
        });

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
    }
}

module.exports = { P2PChatHandler };