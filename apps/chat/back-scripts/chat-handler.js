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
        
        this.events = {
            'message': 'chat-message',
            'peer:join': 'peer-joined',
            'peer:left': 'peer-left',
            'file:progress': 'file:progress',
            'file:complete': 'file:complete',
            'peer:connecting': 'peer-connecting'
        };

        Object.getOwnPropertyNames(P2PChatHandler.prototype)
            .filter(method => method !== 'constructor')
            .forEach(method => this[method] = this[method].bind(this));

        this.handlers = Object.fromEntries(
            ['start-chat', 'send-message', 'join-channel', 'connect-peer', 'share-file', 'download-file']
            .map(name => [name, this[name.replace(/-./g, x => x[1].toUpperCase())]])
        );

        this.moduleReady = this.initP2PModule();
    }

    async initP2PModule() {
        const { P2P } = await import('./p2p.mjs');
        return P2P; // Store promise result for later use
    }

    /**
     * @param {'info'|'error'|'success'|'file'|'network'|'peer'} type
     * @param {string} action
     * @param {*} data
     */
    log(type, action, data) {
        const emojis = {
            info: '📝', error: '❌', success: '✅', 
            file: '📁', network: '🔗', peer: '👤'
        };
        console.log(`${emojis[type]} [${action}]`, data);
    }

    /**
     * @param {*} p2pInstance
     */
    setupP2PEvents(p2pInstance) {
        this.log('network', 'setup', 'Initializing P2P events');
        Object.entries(this.events).forEach(([p2pEvent, ipcEvent]) => {
            p2pInstance.on(p2pEvent, data => {
                this.log('info', p2pEvent, data);
                this.mainWindow?.webContents.send(ipcEvent, data);
            });
        });
    }

    /**
     * @param {*} event
     * @param {string} nickname
     */
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

    /**
     * @param {*} event
     * @param {{channel: string, file: FileData}} params
     */
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

    /**
     * @param {*} event
     * @param {{cid: string}} params
     */
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

    /**
     * @param {*} event
     * @param {{channel: string, content: string}} params
     */
    async sendMessage(event, { channel, content }) {
        return this.wrapP2PCall('send-message', () => this.p2p.sendMessage(channel, content));
    }

    /**
     * @param {*} event
     * @param {string} channel
     */
    async joinChannel(event, channel) {
        return this.wrapP2PCall('join-channel', () => this.p2p.joinChannel(channel));
    }

    /**
     * @param {*} event
     * @param {string} addr
     */
    async connectPeer(event, addr) {
        return this.wrapP2PCall('connect-peer', () => this.p2p.connectToPeer(addr));
    }

    /**
     * @param {string} action
     * @param {Function} fn
     */
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
        Object.entries(this.handlers).forEach(([name, handler]) => {
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
    }

    async cleanup() {
        if (this.p2p) {
            try {
                await this.p2p.stop();
                this.log('info', 'cleanup', 'P2P network stopped cleanly');
            } catch (err) {
                this.log('error', 'cleanup', err);
            }
        }

        // cleanup ipcMain
        //Object.keys(this.handlers).forEach(name => ipcMain.removeHandler(name));
    }
}

module.exports = { P2PChatHandler };