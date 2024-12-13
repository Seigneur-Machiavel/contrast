/**
 * @typedef {{from: string, content: string, timestamp: number, channel: string, latency?: number}} Message
 */
class ChatUI {
    constructor(document) {
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
        this.document = document;
        // Bind methods
        Object.getOwnPropertyNames(ChatUI.prototype)
            .filter(method => method !== 'constructor')
            .forEach(method => this[method] = this[method].bind(this));

        // Initialize on DOM ready
        this.document.addEventListener('DOMContentLoaded', this.initializeUI);
        window.addEventListener('unload', this.cleanup);
        this.initializeEventListeners();
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
        window.chat.onFileProgress(this.handleFileProgress);
        window.chat.onChatMessage(this.handleChatMessage);
        window.chat.onPeerConnecting(this.handlePeerConnecting);
        window.chat.onPeerJoined(this.handlePeerJoined);
        window.chat.onPeerLeft(this.handlePeerLeft);
    }

    initializeUI() {
        const controls = this.document.querySelector('.controls');
        controls.innerHTML = `
            <input type="file" id="fileInput" style="display: none">
            <button onclick="chatUI.handleFileButtonClick()">Share File</button>
            <input type="text" id="message" placeholder="Type a message...">
            <button onclick="chatUI.sendMessage()">Send</button>
        `;

        this.document.getElementById('fileInput').addEventListener('change', this.handleFileUpload);
        this.document.getElementById('message').addEventListener('keypress', e => {
            if (e.key === 'Enter') this.sendMessage();
        });

        this.updateChannelList();
    }

    handleFileButtonClick() {
        this.document.getElementById('fileInput').click();
    }

    async start() {
        const nickname = this.document.getElementById('nickname').value.trim();
        if (!nickname) {
            this.notify('Please enter a nickname');
            return;
        }

        try {
            const result = await window.chat.startChat(nickname);
            if (!result.success) {
                throw new Error(result.error);
            }

            this.document.getElementById('status').textContent = 
                `Connected as: ${nickname}\nAddress: ${result.addr}`;

            this.document.getElementById('login').style.display = 'none';
            this.document.getElementById('app').style.display = 'grid';
            this.document.getElementById('message').addEventListener('keypress', e => {
                if (e.key === 'Enter') this.sendMessage();
            });

            this.log('Chat', 'Started', { nickname, addr: result.addr });
        } catch (err) {
            this.log('error', 'Start failed', err);
            this.notify('Failed to start chat: ' + err.message);
        }
    }

    async sendMessage() {
        const input = this.document.getElementById('message');
        const content = input.value.trim();
        if (!content) return;

        try {
            const result = await window.chat.sendMessage({
                channel: this.state.currentChannel,
                content
            });

            if (result.success) {
                input.value = '';
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
        const input = this.document.getElementById('newChannel');
        const channel = input.value.trim();
        if (!channel) return;

        try {
            const result = await window.chat.joinChannel(channel);
            if (result.success) {
                this.state.channels.add(channel);
                input.value = '';
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
        const input = this.document.getElementById('peerAddr');
        const addr = input.value.trim();
        if (!addr) return;

        try {
            const success = await window.chat.connectPeer(addr);
            if (success) {
                input.value = '';
                this.notify('Connected to peer');
                this.log('Peer', 'Connected', addr);
            } else {
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
        this.document.getElementById('messages').appendChild(div);
        this.scrollToBottom();

        try {
            const buffer = await file.arrayBuffer();
            const result = await window.chat.shareFile({
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
            const result = await window.chat.downloadFile({ cid });
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
            const [_, filename, cid, size, type] = msg.content.split(' ');
            this.state.transfers.set(cid, {
                filename,
                size: parseInt(size),
                type,
                announced: Date.now()
            });
            
            const div = this.createFileMessage({ name: filename, size, type }, msg.from, cid);
            this.document.getElementById('messages').appendChild(div);
            this.scrollToBottom();
            
            this.log('File', 'Announced', { filename, size: this.formatSize(size), type, cid });
        } else if (this.addMessageToHistory(msg) && msg.channel === this.state.currentChannel) {
            this.displayMessage(msg);
            this.log('Message', 'Received', { 
                channel: msg.channel, 
                from: msg.from, 
                content: msg.content 
            });
        }
    }

    createFileMessage(file, from, cid = null) {
        const div = this.document.createElement('div');
        div.className = 'message file-message';
        div.innerHTML = `
            <div class="message-header">
                <span class="message-sender">${from}</span>
                <span class="message-time">${new Date().toLocaleTimeString()}</span>
            </div>
            <div class="message-content">
                <div class="file-info">
                    <span>${this.getFileIcon(file.type)} ${file.name} (${this.formatSize(file.size)})</span>
                    <div class="progress-bar">
                        <div class="progress" data-file-progress="${file.name}" style="width: 0%"></div>
                    </div>
                    ${cid ? `<button onclick="chatUI.downloadFile('${cid}')" class="download-button">Download</button>`
                         : '<span>Uploading...</span>'}
                </div>
            </div>
        `;
        return div;
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
        const div = this.document.createElement('div');
        div.className = 'message';
        div.innerHTML = `
            <div class="message-header">
                <span class="message-sender">${msg.from}</span>
                <span class="message-time">${new Date(msg.timestamp).toLocaleTimeString()}</span>
                ${msg.latency ? `<span class="message-latency">(${msg.latency}ms)</span>` : ''}
            </div>
            <div class="message-content">${msg.content}</div>
        `;
        this.document.getElementById('messages').appendChild(div);
        this.scrollToBottom();
    }

    switchChannel(channel) {
        this.log('Channel', 'Switching', { from: this.state.currentChannel, to: channel });
        this.state.currentChannel = channel;
        this.updateChannelList();
        
        const messages = document.getElementById('messages');
        messages.innerHTML = '';
        
        const history = this.state.messageHistory.get(channel) || [];
        history.forEach(msg => this.displayMessage(msg));
    }

    updateChannelList() {
        const html = Array.from(this.state.channels)
            .map(channel => `
                <div class="channel ${channel === this.state.currentChannel ? 'active' : ''}"
                     onclick="chatUI.switchChannel('${channel}')">
                    #${channel}
                </div>
            `).join('');
        this.document.getElementById('channels').innerHTML = html;
    }

    updatePeerList() {
        const html = Array.from(this.state.peers)
            .map(peer => `
                <div class="peer">
                    <span class="peer-id">${peer}</span>
                    <span class="peer-status ${this.state.connectingPeers.has(peer) ? 'connecting' : 'connected'}">
                        ${this.state.connectingPeers.has(peer) ? '🔄' : '🟢'}
                    </span>
                </div>
            `).join('');
        this.document.getElementById('peers').innerHTML = html;
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
        const notification = this.document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        this.document.body.appendChild(notification);
        setTimeout(() => notification.remove(), duration);
        this.log('Notify', message);
    }

    scrollToBottom() {
        requestAnimationFrame(() => {
            const messages = this.document.getElementById('messages');
            messages.scrollTop = messages.scrollHeight;
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
        window.chat.removeAllListeners('chat-message');
        window.chat.removeAllListeners('peer-joined');
        window.chat.removeAllListeners('peer-left');
        window.chat.removeAllListeners('peer-connecting');
        window.chat.removeAllListeners('file:progress');
        window.chat.removeAllListeners('file:complete');
    }
}

export { ChatUI };  // Named export
export default ChatUI; // Default export