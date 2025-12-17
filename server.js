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
const io = new Server(server, { cors: { origin: "*" } });

// DB Bağlantısı
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Naberya DB Bağlandı'))
    .catch(err => console.log(err));

// --- ŞEMALAR ---

// 1. KULLANICI (Şifre alanı eklendi)
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true }, // Gerçek projede şifrelenmeli (bcrypt)
    avatar: String,
    joinedServers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Server' }]
});
const User = mongoose.model('User', UserSchema);

// 2. SUNUCU
const ServerSchema = new mongoose.Schema({
    name: String,
    icon: String,
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

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {

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
                password, // Şifreyi kaydediyoruz
                avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`
            });
            await newUser.save();

            // Kayıt başarılı, otomatik giriş yapalım
            socket.userId = newUser._id;
            socket.username = newUser.username;
            socket.emit('auth-success', newUser);
            
            // Kullanıcının sunucularını yükle (Yeni olduğu için boştur ama olsun)
            socket.emit('load-servers', []);

        } catch (err) {
            socket.emit('auth-error', 'Kayıt olurken bir hata oluştu.');
        }
    });

    // --- GİRİŞ YAP (LOGIN) ---
    socket.on('login', async ({ username, password }) => {
        try {
            const user = await User.findOne({ username, password }); // İsim ve şifre eşleşmeli
            if (!user) {
                socket.emit('auth-error', 'Kullanıcı adı veya şifre hatalı!');
                return;
            }

            socket.userId = user._id;
            socket.username = user.username;
            socket.emit('auth-success', user);

            // Kullanıcının sunucularını yükle
            const servers = await DiscordServer.find({ _id: { $in: user.joinedServers } });
            socket.emit('load-servers', servers);

        } catch (err) {
            socket.emit('auth-error', 'Giriş sırasında hata oluştu.');
        }
    });

    // --- SUNUCU OLUŞTURMA ---
    socket.on('create-server', async ({ name, ownerId }) => {
        const defaultChannel = new Channel({ name: 'genel', type: 'text' });
        await defaultChannel.save();

        const newServer = new DiscordServer({
            name,
            icon: `https://ui-avatars.com/api/?name=${name}&background=random`,
            owner: ownerId,
            channels: [defaultChannel._id],
            members: [ownerId]
        });
        await newServer.save();
        
        defaultChannel.serverId = newServer._id;
        await defaultChannel.save();

        await User.findByIdAndUpdate(ownerId, { $push: { joinedServers: newServer._id } });
        socket.emit('server-created', newServer);
    });

    // --- SUNUCU SEÇME ---
    socket.on('select-server', async (serverId) => {
        const server = await DiscordServer.findById(serverId).populate('channels');
        socket.join(serverId);
        socket.emit('server-details', server);
    });

    // --- KANALA KATILMA ---
    socket.on('join-channel', async (channelId) => {
        socket.join(channelId); // Soketi odaya al
        const messages = await Message.find({ channelId }).sort({createdAt: 1}).limit(50);
        socket.emit('load-messages', messages);
    });

    // --- MESAJ GÖNDERME ---
    socket.on('send-message', async ({ content, channelId, senderId, senderName, senderAvatar }) => {
        const msg = new Message({ content, channelId, sender: senderId, senderName, senderAvatar });
        await msg.save();
        io.to(channelId).emit('new-message', msg);
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log('Naberya Sunucusu Aktif!'));