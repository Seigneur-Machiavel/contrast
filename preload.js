const { contextBridge } = require('electron');
const ChatApi = require('./apps/chat/chat-back-api.js');

// Expose protected methods that allow the renderer process to use
// specific IPC channels safely in isolation
contextBridge.exposeInMainWorld('chat', ChatApi);