const socket = io();

// Durum Değişkenleri
let currentUser = null;
let currentServerId = null;
let currentChannelId = null;
let isLoginMode = true; // Giriş modu mu, kayıt modu mu?

// DOM Elementleri
const authOverlay = document.getElementById('auth-overlay');
const authTitle = document.getElementById('auth-title');
const authBtn = document.getElementById('auth-btn');
const toggleAuth = document.getElementById('toggle-auth');
const errorMsg = document.getElementById('error-msg');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');

const app = document.getElementById('app');
const serverList = document.getElementById('server-list');
const addServerBtn = document.getElementById('add-server-btn');
const channelList = document.getElementById('channel-list');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');

// --- AUTH (KİMLİK DOĞRULAMA) ---

// Giriş/Kayıt Modu Değiştirme
toggleAuth.addEventListener('click', () => {
    isLoginMode = !isLoginMode;
    if (isLoginMode) {
        authTitle.innerText = "Naberya'ya Giriş";
        authBtn.innerText = "Giriş Yap";
        toggleAuth.innerText = "Kayıt Ol";
    } else {
        authTitle.innerText = "Hesap Oluştur";
        authBtn.innerText = "Kayıt Ol";
        toggleAuth.innerText = "Giriş Yap";
    }
    errorMsg.innerText = "";
});

// Butona Tıklama
authBtn.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
        errorMsg.innerText = "Lütfen tüm alanları doldur.";
        return;
    }

    if (isLoginMode) {
        socket.emit('login', { username, password });
    } else {
        socket.emit('register', { username, password });
    }
});

// Sunucudan Cevaplar
socket.on('auth-error', (msg) => {
    errorMsg.innerText = msg;
});

socket.on('auth-success', (user) => {
    currentUser = user;
    authOverlay.style.display = 'none';
    app.style.display = 'flex';
    
    // Kullanıcı paneli
    document.getElementById('my-avatar').src = user.avatar;
    document.getElementById('my-username').textContent = user.username;
});

// --- SUNUCU YÖNETİMİ ---
socket.on('load-servers', (servers) => {
    serverList.innerHTML = '';
    servers.forEach(server => addServerIcon(server));
    if (servers.length > 0) selectServer(servers[0]._id);
});

addServerBtn.addEventListener('click', () => {
    const name = prompt("Yeni Sunucu Adı:");
    if (name) {
        socket.emit('create-server', { name, ownerId: currentUser._id });
    }
});

socket.on('server-created', (newServer) => {
    addServerIcon(newServer);
    selectServer(newServer._id);
});

function addServerIcon(server) {
    const div = document.createElement('div');
    div.className = 'server-icon';
    div.innerHTML = `<img src="${server.icon}" title="${server.name}">`;
    div.onclick = () => selectServer(server._id);
    serverList.appendChild(div);
}

function selectServer(serverId) {
    currentServerId = serverId;
    socket.emit('select-server', serverId);
}

socket.on('server-details', (server) => {
    document.getElementById('current-server-name').textContent = server.name;
    document.getElementById('current-server-name').innerHTML = `${server.name} <span style="font-size:10px; color:gray; cursor:pointer;" onclick="alert('Davet Kodu: ${server.inviteCode}')">(KOD: ${server.inviteCode})</span>`;
    channelList.innerHTML = '<div class="channel-group">METİN KANALLARI</div>';
    
    server.channels.forEach(channel => {
        const div = document.createElement('div');
        div.className = 'channel-item';
        if (currentChannelId === channel._id) div.classList.add('active');
        
        div.innerHTML = `<i class="fas fa-hashtag"></i> ${channel.name}`;
        div.onclick = () => joinChannel(channel._id, channel.name, div);
        channelList.appendChild(div);
    });

    // İlk kanalı otomatik seç (eğer varsa)
    if(server.channels.length > 0) {
        // Otomatik ilk kanala girme işlemi burada yapılabilir ama şimdilik manuel bırakalım
    }
});

// --- KANAL VE MESAJLAŞMA ---
function joinChannel(channelId, channelName, element) {
    currentChannelId = channelId;
    document.getElementById('current-channel-name').textContent = channelName;
    
    // CSS Active Sınıfını Güncelle
    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    element.classList.add('active');

    socket.emit('join-channel', channelId);
}

socket.on('load-messages', (messages) => {
    messagesContainer.innerHTML = '';
    messages.forEach(msg => appendMessage(msg));
    scrollToBottom();
});

// Mesaj Gönder (Enter ile)
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && messageInput.value.trim() && currentChannelId) {
        socket.emit('send-message', {
            content: messageInput.value,
            channelId: currentChannelId,
            senderId: currentUser._id,
            senderName: currentUser.username,
            senderAvatar: currentUser.avatar
        });
        messageInput.value = '';
    }
});

socket.on('new-message', (msg) => {
    if (msg.channelId === currentChannelId) {
        appendMessage(msg);
        scrollToBottom();
    }
});

function appendMessage(msg) {
    const time = new Date(msg.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    const div = document.createElement('div');
    div.className = 'message';
    div.innerHTML = `
        <img src="${msg.senderAvatar}" class="msg-avatar">
        <div class="msg-content">
            <div class="msg-header">
                <span class="msg-username">${msg.senderName}</span>
                <span class="msg-time">${time}</span>
            </div>
            <div class="msg-text">${msg.content}</div>
        </div>
    `;
    messagesContainer.appendChild(div);
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// --- SUNUCUYA KATILMA ---
const joinServerBtn = document.getElementById('join-server-btn');

joinServerBtn.addEventListener('click', () => {
    const code = prompt("Katılmak istediğin sunucunun DAVET KODUNU gir (Örn: A8F2K9):");
    if (code) {
        socket.emit('join-server-by-code', { code: code.trim(), userId: currentUser._id });
    }
});

socket.on('server-joined', (server) => {
    alert(`Başarılı! ${server.name} sunucusuna katıldın.`);
    addServerIcon(server); // Sol menüye ekle
    selectServer(server._id); // Oraya geçiş yap
});

// Hata mesajlarını dinle (Eğer client.js'de yoksa ekle)
socket.on('error', (msg) => alert(msg));