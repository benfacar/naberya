const socket = io();
let currentUser = null, currentServerId = null, currentChannelId = null;
let isLoginMode = true, isServerOwner = false;
let peers = []; // Sesli sohbet bağlantıları
let localStream = null;

// DOM
const authOverlay = document.getElementById('auth-overlay');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const authBtn = document.getElementById('auth-btn');
const toggleAuth = document.getElementById('toggle-auth');
const app = document.getElementById('app');
const serverList = document.getElementById('server-list');
const channelList = document.getElementById('channel-list');
const membersList = document.getElementById('members-list');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const deleteServerBtn = document.getElementById('delete-server-btn');
const addChannelBtn = document.getElementById('add-channel-btn');
const deleteChannelBtn = document.getElementById('delete-channel-btn');

// --- AUTH ---
toggleAuth.addEventListener('click', () => { isLoginMode = !isLoginMode; document.getElementById('auth-title').innerText = isLoginMode ? "Giriş" : "Kayıt"; authBtn.innerText = isLoginMode ? "Giriş" : "Kayıt"; });
authBtn.addEventListener('click', () => {
    const u = usernameInput.value.trim(), p = passwordInput.value.trim();
    if(u && p) socket.emit(isLoginMode ? 'login' : 'register', { username: u, password: p });
});
socket.on('auth-success', (user) => {
    currentUser = user; authOverlay.style.display = 'none'; app.style.display = 'flex';
    document.getElementById('my-avatar').src = user.avatar; document.getElementById('my-username').textContent = user.username;
});
socket.on('auth-error', msg => alert(msg));

// --- SUNUCU ---
socket.on('load-servers', s => { serverList.innerHTML = ''; s.forEach(addServerIcon); if(s.length>0) selectServer(s[0]._id); });
document.getElementById('add-server-btn').onclick = () => { const n = prompt("Sunucu Adı:"); if(n) socket.emit('create-server', { name: n, ownerId: currentUser._id }); };
document.getElementById('join-server-btn').onclick = () => { const c = prompt("Davet Kodu:"); if(c) socket.emit('join-server-by-code', { code: c, userId: currentUser._id }); };
socket.on('server-created', s => { addServerIcon(s); selectServer(s._id); });
socket.on('server-joined', s => { addServerIcon(s); selectServer(s._id); });
socket.on('server-updated', s => { if(currentServerId === s._id) loadServerUI(s); });
socket.on('server-deleted', id => { if(currentServerId === id) location.reload(); }); // Basit reset

function addServerIcon(s) {
    const d = document.createElement('div'); d.className = 'server-icon'; d.innerHTML = `<img src="${s.icon}" title="${s.name}">`;
    d.onclick = () => selectServer(s._id); serverList.appendChild(d);
}
function selectServer(id) { currentServerId = id; socket.emit('select-server', id); }

socket.on('server-details', loadServerUI);

function loadServerUI(server) {
    document.getElementById('current-server-name').innerHTML = `${server.name} <span style="font-size:10px;color:gray;">(${server.inviteCode})</span>`;
    isServerOwner = (server.owner === currentUser._id);
    
    // Yönetim Butonları
    deleteServerBtn.style.display = isServerOwner ? 'block' : 'none';
    addChannelBtn.style.display = isServerOwner ? 'block' : 'none';
    deleteServerBtn.onclick = () => { if(confirm('Sunucu silinsin mi?')) socket.emit('delete-server', { serverId: server._id, userId: currentUser._id }); };
    addChannelBtn.onclick = () => { 
        const n = prompt("Kanal Adı:"); 
        const t = confirm("Sesli kanal mı? (Tamam=Ses, İptal=Metin)") ? 'voice' : 'text';
        if(n) socket.emit('create-channel', { serverId: server._id, name: n, type: t }); 
    };

    // Kanallar
    channelList.innerHTML = '';
    const textChs = server.channels.filter(c => c.type === 'text');
    const voiceChs = server.channels.filter(c => c.type === 'voice');

    if(textChs.length) channelList.innerHTML += `<div class="channel-group">METİN</div>`;
    textChs.forEach(c => {
        const d = document.createElement('div'); d.className = 'channel-item'; d.innerHTML = `<i class="fas fa-hashtag"></i> ${c.name}`;
        if(currentChannelId === c._id) d.classList.add('active');
        d.onclick = () => joinTextChannel(c);
        channelList.appendChild(d);
    });

    if(voiceChs.length) channelList.innerHTML += `<div class="channel-group">SES</div>`;
    voiceChs.forEach(c => {
        const d = document.createElement('div'); d.className = 'channel-item'; d.innerHTML = `<i class="fas fa-volume-up"></i> ${c.name}`;
        d.onclick = () => joinVoiceChannel(c);
        channelList.appendChild(d);
    });

    // Üyeler
    updateMembers(server.members, server.owner);
}

function updateMembers(members, ownerId) {
    membersList.innerHTML = '';
    members.forEach(m => {
        const d = document.createElement('div'); d.className = 'member-item';
        const crown = m._id === ownerId ? '<i class="fas fa-crown owner-crown"></i>' : '';
        let kick = '';
        if(isServerOwner && m._id !== currentUser._id) {
            kick = `<i class="fas fa-user-times kick-btn" onclick="kickUser('${m._id}')"></i>`;
        }
        d.innerHTML = `<img src="${m.avatar}" class="member-avatar"><span class="member-name">${m.username}</span>${crown}${kick}`;
        membersList.appendChild(d);
    });
}
window.kickUser = (uid) => { if(confirm('Atılsın mı?')) socket.emit('kick-user', { serverId: currentServerId, userId: uid, ownerId: currentUser._id }); };
socket.on('update-member-list', m => updateMembers(m, currentUser._id)); // Owner ID tam doğru gelmeyebilir burada ama görsel yenilenir

// --- MESAJLAŞMA ---
function joinTextChannel(c) {
    currentChannelId = c._id; 
    document.getElementById('current-channel-name').innerText = c.name;
    document.getElementById('chat-header-icon').className = 'fas fa-hashtag';
    document.getElementById('input-area').style.display = 'block';
    
    deleteChannelBtn.style.display = isServerOwner ? 'block' : 'none';
    deleteChannelBtn.onclick = () => { if(confirm('Kanal silinsin mi?')) socket.emit('delete-channel', { channelId: c._id, serverId: currentServerId, userId: currentUser._id }); };

    socket.emit('join-channel', c._id);
    document.querySelectorAll('.channel-item').forEach(e => e.classList.remove('active'));
}

socket.on('load-messages', msgs => { messagesContainer.innerHTML = ''; msgs.forEach(appendMessage); });
socket.on('new-message', m => { if(m.channelId === currentChannelId) { appendMessage(m); messagesContainer.scrollTop = messagesContainer.scrollHeight; } });

messageInput.addEventListener('keypress', (e) => {
    if(e.key === 'Enter' && messageInput.value.trim() && currentChannelId) {
        socket.emit('send-message', { content: messageInput.value, channelId: currentChannelId, senderId: currentUser._id, senderName: currentUser.username, senderAvatar: currentUser.avatar });
        messageInput.value = '';
    }
});

function appendMessage(msg) {
    const t = new Date(msg.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const d = document.createElement('div'); d.className = 'message';
    d.innerHTML = `<img src="${msg.senderAvatar}" class="msg-avatar"><div class="msg-content"><div class="msg-header"><span class="msg-username">${msg.senderName}</span><span class="msg-time">${t}</span></div><div class="msg-text">${msg.content}</div></div>`;
    messagesContainer.appendChild(d);
}

// --- SESLİ SOHBET (WEBRTC MESH) ---
function joinVoiceChannel(c) {
    navigator.mediaDevices.getUserMedia({ video: false, audio: true }).then(stream => {
        localStream = stream;
        document.getElementById('voice-status-panel').style.display = 'block';
        document.getElementById('voice-channel-name').innerText = c.name;
        
        socket.emit('join-voice', c._id);

        socket.on('all-voice-users', users => {
            users.forEach(userId => {
                if(userId !== socket.id) createPeer(userId, socket.id, stream);
            });
        });

        socket.on('user-joined-voice', userID => {
            // Yeni gelen sinyal bekler, peer create etme, bekle
        });

        socket.on('user-joined-signal', payload => {
            const peer = addPeer(payload.signal, payload.callerID, stream);
            peers.push({ peerID: payload.callerID, peer });
        });

        socket.on('receiving-returned-signal', payload => {
            const item = peers.find(p => p.peerID === payload.id);
            item.peer.signal(payload.signal);
        });

        socket.on('user-left-voice', id => {
            const peerObj = peers.find(p => p.peerID === id);
            if(peerObj) peerObj.peer.destroy();
            peers = peers.filter(p => p.peerID !== id);
        });
    });
}

function createPeer(userToSignal, callerID, stream) {
    const peer = new SimplePeer({ initiator: true, trickl: false, stream });
    peer.on('signal', signal => socket.emit('sending-signal', { userToSignal, callerID, signal }));
    addAudioEvent(peer);
    peers.push({ peerID: userToSignal, peer });
}

function addPeer(incomingSignal, callerID, stream) {
    const peer = new SimplePeer({ initiator: false, trickl: false, stream });
    peer.on('signal', signal => socket.emit('returning-signal', { signal, callerID }));
    addAudioEvent(peer);
    return peer;
}

function addAudioEvent(peer) {
    peer.on('stream', stream => {
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        document.body.appendChild(audio); // Gizli audio elementi
    });
}

window.leaveVoice = () => {
    if(localStream) localStream.getTracks().forEach(t => t.stop());
    peers.forEach(p => p.peer.destroy());
    peers = [];
    document.getElementById('voice-status-panel').style.display = 'none';
    // Sunucuya haber ver (socket disconnect veya event ile) ama reload en temizidir
    location.reload(); 
};