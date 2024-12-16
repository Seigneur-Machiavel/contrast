/**
 * @typedef {{from: string, content: string, timestamp: number, channel: string, latency?: number}} Message
 */
class ChatUI {
    /** @param {HTMLElement} parentDiv */
    constructor(parentDiv) {
        /** @type {HTMLElement} */
        this.document = parentDiv;
        this.eHTML = {
            login: document.getElementById('chat-login'),
            nickname: document.getElementById('chat-login').getElementsByTagName('input')[0],
            listenAddr: document.getElementById('chat-login').getElementsByTagName('input')[1],
            app: document.getElementById('chat-app'),
            status: document.getElementById('chat-status'),
            messages: document.getElementById('chat-messages'),
            message: document.getElementById('chat-message'),
            channels: document.getElementById('chat-channels'),
            newChannel: document.getElementById('chat-newChannel'),
            peerAddr: document.getElementById('chat-peerAddr'),
            peers: document.getElementById('chat-peers')
        }
        this.state = {
            currentChannel: 'system',
            channels: new Set(['system']),
            peers: new Set(),
            connectingPeers: new Set(),
            messageHistory: new Map(),
            lastMessageTime: new Map(),
            transfers: new Map(),
            debug: true
        };

   
        // Bind methods
        Object.getOwnPropertyNames(ChatUI.prototype)
            .filter(method => method !== 'constructor')
            .forEach(method => this[method] = this[method].bind(this));

        this.updateChannelList();
        window.addEventListener('unload', this.cleanup);
        this.initializeEventListeners();
        
        this.eHTML.listenAddr.value = '/ip4/0.0.0.0/tcp/27260';
        
        this.initializeFrontListeners();
    }

    log(type, action, data) {
        if (!this.state.debug) return;
        const ts = new Date().toISOString().split('T')[1].slice(0, -1);
        console.log(
            `%c${ts}%c [${type}]%c ${action}`,
            'color: #666',
            `color: ${type === 'error' ? '#e74c3c' : '#2ecc71'}; font-weight: bold`,
            'color: inherit',
            data || ''
        );
    }

    initializeEventListeners() {
        window.chatAPI.onFileProgress(this.handleFileProgress);
        window.chatAPI.onChatMessage(this.handleChatMessage);
        window.chatAPI.onPeerConnecting(this.handlePeerConnecting);
        window.chatAPI.onPeerJoined(this.handlePeerJoined);
        window.chatAPI.onPeerLeft(this.handlePeerLeft);
    }
    initializeFrontListeners() {
        this.document.addEventListener('click', e => {
            switch (e.target.dataset.action) {
                case 'start': if (e.target.tagName === 'BUTTON') this.start(); break;
                case 'joinChannel': this.joinChannel(); break;
                case 'switchChannel': this.switchChannel(e.target.dataset.value); break;
                case 'connectPeer': this.connectPeer(); break;
                case 'sendMessage': if (e.target.tagName === 'BUTTON') this.sendMessage(); break;
            }
        });

        this.document.addEventListener('keypress', e => {
            switch (e.target.dataset.action) {
                case 'start': if (e.key === 'Enter') this.start(); break;
                case 'sendMessage': if (e.key === 'Enter') this.sendMessage(); break;
            }
        });
    }

    async start() {
        const nickname = this.eHTML.nickname.value.trim();
        const listenAddr = this.eHTML.listenAddr.value.trim();
        console.log('start', nickname, listenAddr);
        if (!nickname) { this.notify('Please enter a nickname'); return; }
        if (!listenAddr) { this.notify('Please enter a listen address'); return; }
        try {
            const result = await window.chatAPI.startChat(nickname, listenAddr);
            if (!result.success) { throw new Error(result.error); }

            this.eHTML.status.textContent = `Connected as: ${nickname}\nAddress: ${result.addr}`;
            this.eHTML.login.style.display = 'none';
            this.eHTML.app.style.display = 'grid';

            this.log('Chat', 'Started', { nickname, addr: result.addr });
        } catch (err) {
            this.log('error', 'Start failed', err);
            this.notify('Failed to start chat: ' + err.message);
        }
    }

    async sendMessage() {
        const content = this.eHTML.message.value.trim();
        if (!content) return;

        console.log('sendMessage', content);
        try {
            const result = await window.chatAPI.sendMessage({
                channel: this.state.currentChannel,
                content
            });

            if (result.success) {
                this.eHTML.message.value = '';
                this.log('Message', 'Sent', { channel: this.state.currentChannel, content });
            } else {
                this.notify('Failed to send: ' + result.error);
            }
        } catch (err) {
            this.log('error', 'Send failed', err);
            this.notify('Failed to send message: ' + err.message);
        }
    }

    async joinChannel() {
        const channel = this.eHTML.newChannel.value.trim();
        if (!channel) return;

        try {
            const result = await window.chatAPI.joinChannel(channel);
            if (result.success) {
                this.state.channels.add(channel);
                this.eHTML.newChannel.value = '';
                this.updateChannelList();
                this.switchChannel(channel);
                this.notify(`Joined ${channel}`);
                this.log('Channel', 'Joined', channel);
            } else {
                this.notify('Failed to join: ' + result.error);
            }
        } catch (err) {
            this.log('error', 'Join failed', err);
            this.notify('Failed to join channel: ' + err.message);
        }
    }

    async connectPeer() {
        const addr = this.eHTML.peerAddr.value.trim();
        if (!addr) return;

        try {
            const success = await window.chatAPI.connectPeer(addr);
            if (success === true) {
                console.log(success);
                this.eHTML.peerAddr.value = '';
                this.notify('Connected to peer');
                this.log('Peer', 'Connected', addr);
            } else {
                console.log(success);
                this.notify('Failed to connect to peer');
            }
        } catch (err) {
            this.log('error', 'Connect failed', err);
            this.notify('Failed to connect: ' + err.message);
        }
    }

    async handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        const div = this.createFileMessage(file, 'You');
        this.eHTML.messages.appendChild(div);
        this.scrollToBottom();

        try {
            const buffer = await file.arrayBuffer();
            const result = await window.chatAPI.shareFile({
                channel: this.state.currentChannel,
                file: {
                    name: file.name,
                    size: file.size,
                    type: file.type,
                    content: Array.from(new Uint8Array(buffer))
                }
            });

            if (result.success) {
                this.notify(`Shared: ${file.name}`);
                this.log('File', 'Shared', { name: file.name, size: this.formatSize(file.size) });
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            this.log('error', 'Share failed', err);
            this.notify('Failed to share file: ' + err.message);
            div.remove();
        }

        e.target.value = '';
    }

    async downloadFile(cid) {
        this.log('File', 'Download started', { cid });
        try {
            const result = await window.chatAPI.downloadFile({ cid });
            if (result.success) {
                this.notify(`Downloaded: ${result.metadata.filename}`);
                this.log('File', 'Downloaded', { 
                    name: result.metadata.filename, 
                    size: this.formatSize(result.metadata.size) 
                });
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            this.log('error', 'Download failed', err);
            this.notify('Failed to download file: ' + err.message);
        }
    }

    handleFileProgress(data) {
        const progressElement = this.document.querySelector(`[data-file-progress="${data.filename}"]`);
        if (progressElement) {
            progressElement.style.width = `${data.progress}%`;
            this.log('Progress', `${data.filename}: ${data.progress}%`);
        }
    }

    handleChatMessage(msg) {
        if (msg.content.startsWith('/file ')) {

        } else if (this.addMessageToHistory(msg) && msg.channel === this.state.currentChannel) {
            this.displayMessage(msg);
            this.log('Message', 'Received', { 
                channel: msg.channel, 
                from: msg.from, 
                content: msg.content 
            });
        }
    }

    addMessageToHistory(msg) {
        if (!this.state.messageHistory.has(msg.channel)) {
            this.state.messageHistory.set(msg.channel, []);
        }
        
        const lastTime = this.state.lastMessageTime.get(msg.channel) || 0;
        const msgHash = `${msg.from}-${msg.content}-${msg.timestamp}`;
        const history = this.state.messageHistory.get(msg.channel);
        
        if (msg.timestamp <= lastTime && history.some(m => 
            `${m.from}-${m.content}-${m.timestamp}` === msgHash)) {
            this.log('Message', 'Duplicate skipped', { channel: msg.channel, hash: msgHash });
            return false;
        }

        this.state.lastMessageTime.set(msg.channel, msg.timestamp);
        history.push(msg);
        if (history.length > 100) history.shift();
        return true;
    }

    displayMessage(msg) {
        const div = document.createElement('div');
        div.className = 'message';

        const header = document.createElement('div');
        header.className = 'message-header';
        div.appendChild(header);

        const sender = document.createElement('span');
        sender.className = 'message-sender';
        sender.textContent = msg.from;
        header.appendChild(sender);
        
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = msg.content;
        div.appendChild(content);

        const time = document.createElement('span');
        time.className = 'message-time';
        time.textContent = new Date(msg.timestamp).toLocaleTimeString();
        header.appendChild(time);

        this.eHTML.messages.appendChild(div);
        this.scrollToBottom();
    }

    switchChannel(channel) {
        this.log('Channel', 'Switching', { from: this.state.currentChannel, to: channel });
        this.state.currentChannel = channel;
        this.updateChannelList();
        
        this.eHTML.messages.innerHTML = '';
        
        const history = this.state.messageHistory.get(channel) || [];
        history.forEach(msg => this.displayMessage(msg));
    }

    updateChannelList() {
        this.eHTML.channels.innerHTML = '';
        const html = Array.from(this.state.channels)
        for (const channel of html) {
            const div = document.createElement('div');
            div.classList.add('channel');
            if (channel === this.state.currentChannel) div.classList.add('active');

            div.dataset.action = 'switchChannel';
            div.dataset.value = channel;
            
            div.textContent = '#' + channel;
            this.eHTML.channels.appendChild(div);
        }
    }

    updatePeerList() {
        this.eHTML.peers.innerHTML = '';
        
        const peers = Array.from(this.state.peers);
        for (const peer of peers) {
            const div = this.createPeerDiv(peer);
            this.eHTML.peers.appendChild(div);
        }
    }
    createPeerDiv(peer) {
        const div = document.createElement('div');
        div.className = 'peer';

        const idSpan = document.createElement('span');
        idSpan.className = 'peer-id';
        idSpan.textContent = peer;
        div.appendChild(idSpan);

        const statusSpan = document.createElement('span');
        statusSpan.className = 'peer-status';
        statusSpan.classList.add(this.state.connectingPeers.has(peer) ? 'connecting' : 'connected');
        statusSpan.textContent = this.state.connectingPeers.has(peer) ? '🔄' : '🟢';
        div.appendChild(statusSpan);

        return div;
    }

    handlePeerConnecting(peer) {
        this.state.connectingPeers.add(peer);
        this.updatePeerList();
        this.log('Peer', 'Connecting', peer);
    }

    handlePeerJoined(peer) {
        this.state.peers.add(peer);
        this.state.connectingPeers.delete(peer);
        this.updatePeerList();
        this.notify('Peer joined: ' + peer.slice(0, 10) + '...');
        this.log('Peer', 'Joined', peer);
    }

    handlePeerLeft(peer) {
        this.state.peers.delete(peer);
        this.state.connectingPeers.delete(peer);
        this.updatePeerList();
        this.notify('Peer left: ' + peer.slice(0, 10) + '...');
        this.log('Peer', 'Left', peer);
    }

    notify(message, duration = 3000) {
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), duration);
        this.log('Notify', message);
    }

    scrollToBottom() {
        requestAnimationFrame(() => {
            this.eHTML.messages.scrollTop = this.eHTML.messages.scrollHeight;
        });
    }

    getFileIcon(type) {
        return {
            'image': '🖼️',
            'video': '🎥',
            'audio': '🎵',
            'text': '📄',
            'application': '📎'
        }[type?.split('/')[0]] || '📄';
    }

    formatSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = parseInt(bytes);
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024;
            unit++;
        }
        return `${size.toFixed(1)} ${units[unit]}`;
    }

    cleanup() {
        window.chatAPI.removeAllListeners('chat-message');
        window.chatAPI.removeAllListeners('peer-joined');
        window.chatAPI.removeAllListeners('peer-left');
        window.chatAPI.removeAllListeners('peer-connecting');
        window.chatAPI.removeAllListeners('file:progress');
        window.chatAPI.removeAllListeners('file:complete');
    }
}

//window.ChatUI = ChatUI;
/*export { ChatUI };
export default ChatUI;*/

// Just used for completion
if (typeof exports !== 'undefined') { module.exports = ChatUI; }