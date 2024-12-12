const { ipcMain, dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');

// Dynamic import for P2P
let P2P;
(async () => {
    const { P2P: P2PModule } = await import('./p2p.mjs');
    P2P = P2PModule;
})();

let p2p = null;

function setupP2PEvents(p2pInstance) {
    console.log('🔗 Setting up P2P events...');
    const events = {
        'message': 'chat-message',
        'peer:join': 'peer-joined',
        'peer:left': 'peer-left',
        'file:progress': 'file:progress',
        'file:complete': 'file:complete'
    };

    Object.entries(events).forEach(([p2pEvent, ipcEvent]) => {
        p2pInstance.on(p2pEvent, data => {
            console.log(`🔄 [${p2pEvent}]`, data);
            if (global.mainWindow) {
                global.mainWindow.webContents.send(ipcEvent, data);
            }
        });
    });

    p2pInstance.on('peer:connecting', peerId => {
        if (global.mainWindow) {
            global.mainWindow.webContents.send('peer-connecting', peerId);
        }
    });
}

const handlers = {
    'start-chat': async (event, nickname) => {
        try {
            if (!P2P) {
                throw new Error('P2P module not initialized');
            }
            p2p = new P2P(nickname);
            setupP2PEvents(p2p);
            const addr = await p2p.start();
            return { success: true, addr };
        } catch (err) {
            console.error('Failed to start chat:', err);
            return { success: false, error: err.message };
        }
    },

    'send-message': async (event, { channel, content }) => {
        try {
            await p2p.sendMessage(channel, content);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    'join-channel': async (event, channel) => {
        try {
            await p2p.joinChannel(channel);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    'connect-peer': async (event, addr) => {
        try {
            return await p2p.connectToPeer(addr);
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    'share-file': async (event, { channel, file }) => {
        console.log(`📁 [share-file] Processing:`, {
            name: file.name,
            size: file.size,
            type: file.type
        });
        
        if (!file || !file.content) {
            throw new Error('Invalid file data received');
        }

        try {
            const fileData = {
                name: file.name,
                size: file.size,
                type: file.type,
                stream: async function* () {
                    yield new Uint8Array(file.content);
                }
            };
            
            const fileId = await p2p.shareFile(channel, fileData);
            console.log(`📤 [share-file] Success:`, { fileId, name: file.name });
            return { success: true, fileId };
        } catch (err) {
            console.error(`❌ [share-file] Failed:`, err);
            return { success: false, error: err.message };
        }
    },

    'download-file': async (event, { cid }) => {
        console.log(`📥 [download-file] Starting:`, cid);
        
        try {
            const { content, metadata } = await p2p.downloadFile(cid);
            console.log(`📥 [download-file] Got content:`, {
                name: metadata.filename,
                size: metadata.size
            });
            
            const { filePath } = await dialog.showSaveDialog(global.mainWindow, {
                defaultPath: path.join(app.getPath('downloads'), metadata.filename),
                filters: [
                    { name: 'All Files', extensions: ['*'] }
                ]
            });
            
            if (!filePath) {
                throw new Error('Save cancelled by user');
            }

            fs.writeFileSync(filePath, Buffer.from(content));
            
            console.log(`💾 [download-file] Saved to:`, filePath);
            return {
                success: true,
                metadata,
                path: filePath
            };
        } catch (err) {
            console.error(`❌ [download-file] Failed:`, err);
            return { success: false, error: err.message };
        }
    }
};

function setupHandlers() {
    console.log('🔗 Setting up IPC handlers...');
    Object.entries(handlers).forEach(([name, handler]) => {
        ipcMain.handle(name, async (event, ...args) => {
            try {
                console.log(`📥 [${name}] Called with:`, ...args);
                const result = await handler(event, ...args);
                console.log(`📤 [${name}] Result:`, result);
                return result;
            } catch (err) {
                console.error(`❌ [${name}] Failed:`, err);
                return { success: false, error: err.message };
            }
        });
    });
}

// Cleanup function for P2P instance
async function cleanup() {
    if (p2p) {
        try {
            await p2p.stop();
            console.log('🛑 P2P network stopped cleanly');
        } catch (err) {
            console.error('Error stopping P2P network:', err);
        }
    }
}

module.exports = {
    setupHandlers,
    cleanup
};