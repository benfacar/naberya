require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 });

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Naberya DB Bağlandı 🚀'))
    .catch(err => console.error(err));

// --- ŞEMALAR ---
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    avatar: String,
    joinedServers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Server' }]
});
const User = mongoose.model('User', UserSchema);

const ServerSchema = new mongoose.Schema({
    name: String, icon: String, inviteCode: { type: String, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    channels: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Channel' }],
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});
const DiscordServer = mongoose.model('Server', ServerSchema);

const ChannelSchema = new mongoose.Schema({
    name: String, type: { type: String, enum: ['text', 'voice'], default: 'text' },
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server' },
});
const Channel = mongoose.model('Channel', ChannelSchema);

const MessageSchema = new mongoose.Schema({
    content: String, sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    senderName: String, senderAvatar: String, channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel' },
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// --- SOCKET ---
io.on('connection', (socket) => {
    console.log('Bağlandı:', socket.id);

    // --- OTURUM KURTARMA (YENİ) ---
    socket.on('login-with-id', async (userId) => {
        try {
            const user = await User.findById(userId);
            if (user) {
                socket.userId = user._id;
                socket.username = user.username;
                socket.emit('auth-success', user);
                const servers = await DiscordServer.find({ _id: { $in: user.joinedServers } });
                socket.emit('load-servers', servers);
            } else {
                socket.emit('auth-error', 'Oturum geçersiz.');
            }
        } catch (e) { console.log(e); }
    });

    // --- AUTH ---
    socket.on('register', async ({ username, password }) => {
        try {
            if (await User.findOne({ username })) { socket.emit('auth-error', 'Kullanıcı adı dolu!'); return; }
            const newUser = new User({ username, password, avatar: `https://api.dicebear.com/9.x/avataaars/svg?seed=${username}` });
            await newUser.save();
            socket.userId = newUser._id; socket.username = newUser.username;
            socket.emit('auth-success', newUser); socket.emit('load-servers', []);
        } catch (e) { socket.emit('auth-error', 'Hata.'); }
    });

    socket.on('login', async ({ username, password }) => {
        try {
            const user = await User.findOne({ username, password });
            if (!user) { socket.emit('auth-error', 'Hatalı bilgi!'); return; }
            socket.userId = user._id; socket.username = user.username;
            socket.emit('auth-success', user);
            const servers = await DiscordServer.find({ _id: { $in: user.joinedServers } });
            socket.emit('load-servers', servers);
        } catch (e) { socket.emit('auth-error', 'Hata.'); }
    });

    // --- SUNUCU ---
    socket.on('create-server', async ({ name, ownerId }) => {
        const textCh = new Channel({ name: 'genel', type: 'text' }); await textCh.save();
        const voiceCh = new Channel({ name: 'Sohbet Odası', type: 'voice' }); await voiceCh.save();
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        const newServer = new DiscordServer({ name, icon: `https://ui-avatars.com/api/?name=${name}&background=random`, inviteCode: code, owner: ownerId, channels: [textCh._id, voiceCh._id], members: [ownerId] });
        await newServer.save();
        textCh.serverId = newServer._id; await textCh.save();
        voiceCh.serverId = newServer._id; await voiceCh.save();
        await User.findByIdAndUpdate(ownerId, { $push: { joinedServers: newServer._id } });
        socket.emit('server-created', newServer);
    });

    socket.on('join-server-by-code', async ({ code, userId }) => {
        const server = await DiscordServer.findOne({ inviteCode: code });
        if (!server || server.members.includes(userId)) { socket.emit('error', 'Geçersiz/Zaten üye.'); return; }
        server.members.push(userId); await server.save();
        await User.findByIdAndUpdate(userId, { $push: { joinedServers: server._id } });
        socket.emit('server-joined', server);
    });

    socket.on('select-server', async (serverId) => {
        try {
            const server = await DiscordServer.findById(serverId).populate('channels').populate('members', 'username avatar');
            if (server) {
                socket.join(serverId);
                socket.emit('server-details', server);
            }
        } catch(e){}
    });

    // --- MESAJ ---
    socket.on('join-channel', async (channelId) => {
        socket.join(channelId);
        const msgs = await Message.find({ channelId }).sort({ createdAt: 1 }).limit(50);
        socket.emit('load-messages', msgs);
    });

    socket.on('send-message', async (data) => {
        // Güvenlik: Eğer sokette kullanıcı yoksa işlem yapma
        if (!socket.userId) return; 
        const msg = new Message({ content: data.content, channelId: data.channelId, sender: data.senderId, senderName: data.senderName, senderAvatar: data.senderAvatar });
        await msg.save();
        io.to(data.channelId).emit('new-message', msg);
    });

    // --- SESLİ SOHBET (WEBRTC) ---
    socket.on('join-voice', (channelId) => {
        const usersInRoom = Array.from(io.sockets.adapter.rooms.get(channelId) || []);
        socket.join(channelId);
        // Odadaki diğerlerine kendini duyur
        socket.emit('all-voice-users', usersInRoom.filter(id => id !== socket.id));
    });

    socket.on('sending-signal', payload => {
        io.to(payload.userToSignal).emit('user-joined-signal', { signal: payload.signal, callerID: payload.callerID });
    });

    socket.on('returning-signal', payload => {
        io.to(payload.callerID).emit('receiving-returned-signal', { signal: payload.signal, id: socket.id });
    });
    
    // Sesli sohbetten ayrılma sinyali (manuel ayrılma için)
    socket.on('leave-voice-room', (channelId) => {
        socket.leave(channelId);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Naberya Aktif!'));