require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // Büyük resimler için limit artırımı
});

// --- VERİTABANI BAĞLANTISI ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Naberya DB Bağlandı 🚀'))
    .catch(err => console.error('DB Hatası:', err));

// --- ŞEMALAR (MODELS) ---

// 1. KULLANICI
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    avatar: String,
    joinedServers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Server' }]
});
const User = mongoose.model('User', UserSchema);

// 2. SUNUCU (Davet Kodu Eklendi)
const ServerSchema = new mongoose.Schema({
    name: String,
    icon: String,
    inviteCode: { type: String, unique: true }, // Örn: A8F2K9
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    channels: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Channel' }],
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});
const DiscordServer = mongoose.model('Server', ServerSchema);

// 3. KANAL
const ChannelSchema = new mongoose.Schema({
    name: String,
    type: { type: String, enum: ['text', 'voice'], default: 'text' },
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server' },
    messages: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Message' }]
});
const Channel = mongoose.model('Channel', ChannelSchema);

// 4. MESAJ
const MessageSchema = new mongoose.Schema({
    content: String,
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    senderName: String,
    senderAvatar: String,
    channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel' },
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// --- SOCKET MANTIĞI ---
io.on('connection', (socket) => {
    console.log('Kullanıcı bağlandı:', socket.id);

    // --- KAYIT OL (REGISTER) ---
    socket.on('register', async ({ username, password }) => {
        try {
            const existingUser = await User.findOne({ username });
            if (existingUser) {
                socket.emit('auth-error', 'Bu kullanıcı adı zaten alınmış!');
                return;
            }

            const newUser = new User({
                username,
                password,
                avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`
            });
            await newUser.save();

            socket.userId = newUser._id;
            socket.username = newUser.username;
            socket.emit('auth-success', newUser);
            socket.emit('load-servers', []); // Yeni üyenin sunucusu yoktur

        } catch (err) {
            console.error(err);
            socket.emit('auth-error', 'Kayıt hatası.');
        }
    });

    // --- GİRİŞ YAP (LOGIN) ---
    socket.on('login', async ({ username, password }) => {
        try {
            const user = await User.findOne({ username, password });
            if (!user) {
                socket.emit('auth-error', 'Kullanıcı adı veya şifre hatalı!');
                return;
            }

            socket.userId = user._id;
            socket.username = user.username;
            socket.emit('auth-success', user);

            // Üye olduğu sunucuları bul ve gönder
            const servers = await DiscordServer.find({ _id: { $in: user.joinedServers } });
            socket.emit('load-servers', servers);

        } catch (err) {
            console.error(err);
            socket.emit('auth-error', 'Giriş hatası.');
        }
    });

    // --- SUNUCU OLUŞTURMA (DAVET KODU İLE) ---
    socket.on('create-server', async ({ name, ownerId }) => {
        try {
            // Varsayılan kanal
            const defaultChannel = new Channel({ name: 'genel', type: 'text' });
            await defaultChannel.save();

            // Rastgele Davet Kodu Üret (6 Haneli)
            const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();

            const newServer = new DiscordServer({
                name,
                icon: `https://ui-avatars.com/api/?name=${name}&background=random&color=fff`,
                inviteCode: inviteCode,
                owner: ownerId,
                channels: [defaultChannel._id],
                members: [ownerId]
            });
            await newServer.save();
            
            // Kanalın serverId'sini güncelle
            defaultChannel.serverId = newServer._id;
            await defaultChannel.save();

            // Kullanıcı listesine ekle
            await User.findByIdAndUpdate(ownerId, { $push: { joinedServers: newServer._id } });

            socket.emit('server-created', newServer);
        } catch (err) {
            console.error(err);
        }
    });

    // --- SUNUCUYA KATILMA (KOD İLE) ---
    socket.on('join-server-by-code', async ({ code, userId }) => {
        try {
            const server = await DiscordServer.findOne({ inviteCode: code });
            
            if (!server) {
                socket.emit('error', 'Geçersiz Davet Kodu! Lütfen kontrol et.');
                return;
            }

            // Zaten üye mi?
            if (server.members.includes(userId)) {
                socket.emit('error', 'Zaten bu sunucudasın!');
                return;
            }

            // Üye yap
            server.members.push(userId);
            await server.save();

            // Kullanıcının listesine ekle
            await User.findByIdAndUpdate(userId, { $push: { joinedServers: server._id } });

            socket.emit('server-joined', server); // Başarı mesajı gönder
            
        } catch (err) {
            console.error(err);
            socket.emit('error', 'Katılırken bir hata oluştu.');
        }
    });

    // --- SUNUCU SEÇME VE DETAYLARI GETİRME ---
    socket.on('select-server', async (serverId) => {
        try {
            const server = await DiscordServer.findById(serverId).populate('channels');
            if (server) {
                socket.join(serverId); // Soketi sunucu odasına al (İleride anlık bildirimler için)
                socket.emit('server-details', server);
            }
        } catch (err) {
            console.error(err);
        }
    });

    // --- KANALA GİRME VE MESAJLARI YÜKLEME ---
    socket.on('join-channel', async (channelId) => {
        try {
            socket.join(channelId); // Soketi kanal odasına al
            const messages = await Message.find({ channelId }).sort({ createdAt: 1 }).limit(100);
            socket.emit('load-messages', messages);
        } catch (err) {
            console.error(err);
        }
    });

    // --- MESAJ GÖNDERME ---
    socket.on('send-message', async ({ content, channelId, senderId, senderName, senderAvatar }) => {
        try {
            const msg = new Message({
                content,
                channelId,
                sender: senderId,
                senderName,
                senderAvatar
            });
            await msg.save();
            
            // Kanaldaki herkese gönder
            io.to(channelId).emit('new-message', msg);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('disconnect', () => {
        console.log('Kullanıcı ayrıldı:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Naberya Sunucusu Aktif! 🚀'));