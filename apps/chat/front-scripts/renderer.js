class ChatRenderer {
    transfers = new Map();
    state = {
        currentChannel: 'system',
        channels: new Set(['system']),
        peers: new Set(),
        connectingPeers: new Set(),
        messageHistory: new Map(),
        lastMessageTime: new Map(),
        debug: true
    };
    log = {
        _ts: () => new Date().toISOString().split('T')[1].slice(0, -1),
        event: (category, action, data) => {
            if (this.state.debug) {
                console.log(
                    `%c${this.log._ts()}%c [${category}]%c ${action}`,
                    'color: #666',
                    'color: #2ecc71; font-weight: bold',
                    'color: inherit',
                    data || ''
                );
            }
        },
        error: (category, action, error) => {
            console.error(
                `%c${this.log._ts()}%c [${category}]%c ${action}: ${error}`,
                'color: #666',
                'color: #e74c3c; font-weight: bold',
                'color: inherit'
            );
        }
    };

    addMessageToHistory(msg) {
        if (!this.state.messageHistory.has(msg.channel)) {
            this.state.messageHistory.set(msg.channel, []);
        }
        
        const lastTime = this.state.lastMessageTime.get(msg.channel) || 0;
        const msgHash = `${msg.from}-${msg.content}-${msg.timestamp}`;
        const history = this.state.messageHistory.get(msg.channel);
        
        if (msg.timestamp <= lastTime && history.some(m => 
            `${m.from}-${m.content}-${m.timestamp}` === msgHash)) {
            this.log.event('Message', 'Duplicate skipped', { channel: msg.channel, hash: msgHash });
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
        div.innerHTML = `
            <div class="message-header">
                <span class="message-sender">${msg.from}</span>
                <span class="message-time">${new Date(msg.timestamp).toLocaleTimeString()}</span>
                ${msg.latency ? `<span class="message-latency">(${msg.latency}ms)</span>` : ''}
            </div>
            <div class="message-content">${msg.content}</div>
        `;
    
        const messages = document.getElementById('messages');
        messages.appendChild(div);
        scrollToBottom();
    }
    
    async start() {
        const nickname = document.getElementById('nickname').value.trim();
        if (!nickname) {
            notify('Please enter a nickname');
            return;
        }
    
        try {
            const result = await window.chat.startChat(nickname);
            if (!result.success) {
                notify('Failed to start: ' + result.error);
                return;
            }
    
            document.getElementById('status').textContent = 
                `Connected as: ${nickname}\nAddress: ${result.addr}`;
    
            document.getElementById('login').style.display = 'none';
            document.getElementById('app').style.display = 'grid';
            document.getElementById('message').addEventListener('keypress', e => {
                if (e.key === 'Enter') this.sendMessage();
            });
    
            this.log.event('Chat', 'Started', { nickname, addr: result.addr });
        } catch (err) {
            this.log.error('Chat', 'Start failed', err);
            notify('Failed to start chat: ' + err.message);
        }
    }
    
    async sendMessage() {
        const input = document.getElementById('message');
        const content = input.value.trim();
        if (!content) return;
    
        try {
            const result = await window.chat.sendMessage({
                channel: this.state.currentChannel,
                content
            });
    
            if (result.success) {
                input.value = '';
                this.log.event('Message', 'Sent', { channel: this.state.currentChannel, content });
            } else {
                notify('Failed to send: ' + result.error);
            }
        } catch (err) {
            this.log.error('Message', 'Send failed', err);
            notify('Failed to send message: ' + err.message);
        }
    }
    
    async joinChannel() {
        const input = document.getElementById('newChannel');
        const channel = input.value.trim();
        if (!channel) return;
    
        try {
            const result = await window.chat.joinChannel(channel);
            if (result.success) {
                this.state.channels.add(channel);
                input.value = '';
                updateChannelList();
                switchChannel(channel);
                notify(`Joined ${channel}`);
                this.log.event('Channel', 'Joined', channel);
            } else {
                notify('Failed to join: ' + result.error);
            }
        } catch (err) {
            this.log.error('Channel', 'Join failed', err);
            notify('Failed to join channel: ' + err.message);
        }
    }
    
    async connectPeer() {
        const input = document.getElementById('peerAddr');
        const addr = input.value.trim();
        if (!addr) return;
    
        try {
            const success = await window.chat.connectPeer(addr);
            if (success) {
                input.value = '';
                notify('Connected to peer');
                this.log.event('Peer', 'Connected', addr);
            } else {
                notify('Failed to connect to peer');
            }
        } catch (err) {
            this.log.error('Peer', 'Connect failed', err);
            notify('Failed to connect: ' + err.message);
        }
    }
    
    switchChannel(channel) {
        this.log.event('Channel', 'Switching', { from: this.state.currentChannel, to: channel });
        this.state.currentChannel = channel;
        updateChannelList();
        
        const messages = document.getElementById('messages');
        messages.innerHTML = '';
        
        const history = this.state.messageHistory.get(channel) || [];
        history.forEach(this.displayMessage);
    }
    
    updateChannelList() {
        const html = Array.from(this.state.channels)
            .map(channel => `
                <div class="channel ${channel === this.state.currentChannel ? 'active' : ''}"
                     onclick="switchChannel('${channel}')">
                    #${channel}
                </div>
            `).join('');
        document.getElementById('channels').innerHTML = html;
    }
    
    updatePeerList() {
        const html = Array.from(this.state.peers)
            .map(peer => `
                <div class="peer">
                    <span class="peer-id">${peer}</span>
                    <span class="peer-status ${this.state.connectingPeers.has(peer) ? 'connecting' : 'connected'}">
                        ${this.state.connectingPeers.has(peer) ? '🔄 Connecting...' : '🟢 Connected'}
                    </span>
                </div>
            `).join('');
        document.getElementById('peers').innerHTML = html;
    }
    
    notify(message) {
        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
        this.log.event('Notify', message);
    }

    setupListerners() {
        window.chat.onFileProgress((data) => {
            const progressElement = document.querySelector(`[data-file-progress="${data.filename}"]`);
            if (progressElement) {
                progressElement.style.width = `${data.progress}%`;
                this.log.event('Progress', `${data.filename}: ${data.progress}%`);
            }
        });
        window.chat.onChatMessage((msg) => {
            if (msg.content.startsWith('/file ')) {
                const [_, filename, cid, size, type] = msg.content.split(' ');
                
                this.transfers.set(cid, {
                    filename,
                    size: parseInt(size),
                    type,
                    announced: Date.now()
                });
                
                const div = document.createElement('div');
                div.className = 'message file-message';
                div.innerHTML = `
                    <div class="message-header">
                        <span class="message-sender">${msg.from}</span>
                        <span class="message-time">${new Date(msg.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <div class="message-content">
                        <div class="file-info">
                            <span>${getFileIcon(type)} ${filename} (${formatSize(size)})</span>
                            <div class="progress-bar">
                                <div class="progress" data-file-progress="${filename}" style="width: 0%"></div>
                            </div>
                            <button onclick="downloadFile('${cid}')" class="download-button">
                                Download
                            </button>
                        </div>
                    </div>
                `;
                document.getElementById('messages').appendChild(div);
                scrollToBottom();
                
                this.log.event('File', 'Announced', { 
                    filename, 
                    size: formatSize(size),
                    type,
                    cid
                });
            } else {
                try {
                    if (this.addMessageToHistory(msg) && msg.channel === state.currentChannel) {
                        this.displayMessage(msg);
                    }
                    this.log.event('Message', 'Received', { 
                        channel: msg.channel, 
                        from: msg.from, 
                        content: msg.content 
                    });
                } catch (err) {
                    this.log.error('Message', 'Display failed', err);
                }
            }
        });
        window.chat.onPeerConnecting((peer) => {
            state.connectingPeers.add(peer);
            updatePeerList();
            this.log.event('Peer', 'Connecting', peer);
        });
        window.chat.onPeerJoined((peer) => {
            state.peers.add(peer);
            state.connectingPeers.delete(peer);
            updatePeerList();
            notify('Peer joined: ' + peer.slice(0, 10) + '...');
            this.log.event('Peer', 'Joined', peer);
        });
        window.chat.onPeerLeft((peer) => {
            state.peers.delete(peer);
            state.connectingPeers.delete(peer);
            updatePeerList();
            notify('Peer left: ' + peer.slice(0, 10) + '...');
            this.log.event('Peer', 'Left', peer);
        });
        window.addEventListener('unload', () => {
            window.chat.removeAllListeners('chat-message');
            window.chat.removeAllListeners('peer-joined');
            window.chat.removeAllListeners('peer-left');
            window.chat.removeAllListeners('peer-connecting');
            window.chat.removeAllListeners('file:progress');
            window.chat.removeAllListeners('file:complete');
        });
        
        const controls = document.querySelector('.controls');
        const controlsButtons = controls.getElementsByTagName('button');
        controls.addEventListener('click', (e) => {

        /*controls.innerHTML = `
            <input type="file" id="fileInput" style="display: none">
            <button onclick="document.getElementById('fileInput').click()">
                Share File
            </button>
            <input type="text" id="message" placeholder="Type a message...">
            <button onclick="sendMessage()">Send</button>
        `;*/
    
        document.getElementById('fileInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
    
            const div = document.createElement('div');
            div.className = 'message file-message';
            div.innerHTML = `
                <div class="message-header">
                    <span class="message-sender">You</span>
                    <span class="message-time">${new Date().toLocaleTimeString()}</span>
                </div>
                <div class="message-content">
                    <div class="file-info">
                        <span>${getFileIcon(file.type)} ${file.name} (${formatSize(file.size)})</span>
                        <div class="progress-bar">
                            <div class="progress" data-file-progress="${file.name}" style="width: 0%"></div>
                        </div>
                        <span>Uploading...</span>
                    </div>
                </div>
            `;
            document.getElementById('messages').appendChild(div);
            scrollToBottom();
    
            try {
                const buffer = await file.arrayBuffer();
                const result = await window.chat.shareFile({
                    channel: state.currentChannel,
                    file: {
                        name: file.name,
                        size: file.size,
                        type: file.type,
                        content: Array.from(new Uint8Array(buffer))
                    }
                });
    
                if (result.success) {
                    notify(`Shared: ${file.name}`);
                    log.event('File', 'Shared', { 
                        name: file.name, 
                        size: formatSize(file.size)
                    });
                } else {
                    throw new Error(result.error);
                }
            } catch (err) {
                console.error('❌ File share failed:', err);
                notify('Failed to share file: ' + err.message);
                div.remove();
            }
    
            e.target.value = '';
        });
    }

    scrollToBottom() {
        requestAnimationFrame(() => {
            const messages = document.getElementById('messages');
            messages.scrollTop = messages.scrollHeight;
        });
    }
    
    getFileIcon(type) {
        const icons = {
            'image': '🖼️',
            'video': '🎥',
            'audio': '🎵',
            'text': '📄',
            'application': '📎'
        };
        return icons[type?.split('/')[0]] || '📄';
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
    
    async downloadFile(cid) {
        console.log('📥 Attempting to download file:', cid);
        
        try {
            const result = await window.chat.downloadFile({ cid });
            if (result.success) {
                notify(`Downloaded: ${result.metadata.filename}`);
                log.event('File', 'Downloaded', { 
                    name: result.metadata.filename, 
                    size: formatSize(result.metadata.size) 
                });
            } else {
                throw new Error(result.error);
            }
        } catch (err) {
            console.error('❌ Download failed:', err);
            notify('Failed to download file: ' + err.message);
        }
    }
    
    // Initialize channel list
    //updateChannelList();
}






