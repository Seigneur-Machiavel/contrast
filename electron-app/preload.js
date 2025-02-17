const { contextBridge, ipcRenderer } = require('electron');

const electronAPI = {
    // Methods
    onMinimizeBtnClick: () => ipcRenderer.send('minimize-btn-click'),
    onMaximizeBtnClick: () => ipcRenderer.send('maximize-btn-click'),
    onCloseBtnClick: () => ipcRenderer.send('close-btn-click'),

    setPassword: (password) => ipcRenderer.send('set-password', password),
    generatePrivateKeyAndStartNode: () => ipcRenderer.send('generate-private-key-and-start-node'),
    setPrivateKeyAndStartNode: (privateKey) => ipcRenderer.send('set-private-key-and-start-node', privateKey),
    extractPrivateKey: (password) => ipcRenderer.send('extract-private-key', password),
    setAutoLaunch: (value) => ipcRenderer.send('set-auto-launch', value),

    // Listeners
    onNoExistingPassword: (func) => { ipcRenderer.on('no-existing-password', (event, ...args) => func(...args)); },
    onSetNewPasswordResult: (func) => { ipcRenderer.on('set-new-password-result', (event, ...args) => func(...args)); },

    onPasswordRequested: (func) => { ipcRenderer.on('password-requested', (event, ...args) => func(...args)); },
    onSetPasswordResult: (func) => { ipcRenderer.on('set-password-result', (event, ...args) => func(...args)); },

    onNoPasswordRequired: (func) => { ipcRenderer.on('no-password-required', (event, ...args) => func(...args)); },

    onAppVersion: (func) => { ipcRenderer.on('app-version', (event, ...args) => func(...args)); },
    onWaitingForPrivKey: (func) => { ipcRenderer.on('waiting-for-priv-key', (event, ...args) => func(...args)); },
    onNodeStarted: (func) => { ipcRenderer.on('node-started', (event, ...args) => func(...args)); },
    onConnexionResume: (func) => { ipcRenderer.on('connexion-resume', (event, ...args) => func(...args)); },
    onNodeSettingsSaved: (func) => { ipcRenderer.on('node-settings-saved', (event, ...args) => func(...args)); },

    onAssistantMessage: (func) => { ipcRenderer.on('assistant-message', (event, message) => func(message)); },
    onWindowToFront: (func) => { ipcRenderer.on('window-to-front', (event, appName) => func(appName)); },
};

// Expose protected methods that allow the renderer process to use
// specific IPC channels safely in isolation
contextBridge.exposeInMainWorld('electronAPI', electronAPI);