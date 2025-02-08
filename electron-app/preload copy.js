const { contextBridge, ipcRenderer } = require('electron');

const chatApi = {
    // Methods
    startChat: (nickname, listenAddr) => ipcRenderer.invoke('start-chat', nickname, listenAddr),
    sendMessage: (data) => ipcRenderer.invoke('send-message', data),
    joinChannel: (channel) => ipcRenderer.invoke('join-channel', channel),
    connectPeer: (addr) => ipcRenderer.invoke('connect-peer', addr),
    shareFile: (data) => ipcRenderer.invoke('share-file', data),
    downloadFile: (data) => ipcRenderer.invoke('download-file', data),

    // Listeners
    onChatMessage: (callback) => ipcRenderer.on('message', (event, data) => callback(data)),
    onPeerJoined: (callback) => ipcRenderer.on('peer-joined', (event, data) => callback(data)),
    onPeerLeft: (callback) => ipcRenderer.on('peer-left', (event, data) => callback(data)),
    onPeerConnecting: (callback) => ipcRenderer.on('peer-connecting', (event, data) => callback(data)),
    onFileProgress: (callback) => ipcRenderer.on('file-progress', (event, data) => callback(data)),
    onFileComplete: (callback) => ipcRenderer.on('file-complete', (event, data) => callback(data)),

    // Remove event listeners
    removeAllListeners: (channel) => { ipcRenderer.removeAllListeners(channel); }
};

// Expose protected methods that allow the renderer process to use
// specific IPC channels safely in isolation
contextBridge.exposeInMainWorld('chatAPI', chatApi);