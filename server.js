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
const io = new Server(server, { cors: { origin: "*" } });

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
    name: String,
    icon: String,
    inviteCode: { type: String, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    channels: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Channel' }],
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});
const DiscordServer = mongoose.model('Server', ServerSchema);

const ChannelSchema = new mongoose.Schema({
    name: String,
    type: { type: String, enum: ['text', 'voice'], default: 'text' },
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server' },
    messages: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Message' }]
});
const Channel = mongoose.model('Channel', ChannelSchema);

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
const voiceUsers = {}; // { socketId: { channelId, username } }

io.on('connection', (socket) => {
    
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

    // --- SUNUCU YÖNETİMİ ---
    socket.on('create-server', async ({ name, ownerId }) => {
        const textCh = new Channel({ name: 'genel', type: 'text' }); await textCh.save();
        const voiceCh = new Channel({ name: 'Sohbet Odası', type: 'voice' }); await voiceCh.save(); // Varsayılan Sesli Kanal

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
        if (!server || server.members.includes(userId)) { socket.emit('error', 'Geçersiz veya zaten üyesin.'); return; }
        server.members.push(userId); await server.save();
        await User.findByIdAndUpdate(userId, { $push: { joinedServers: server._id } });
        socket.emit('server-joined', server);
    });

    socket.on('select-server', async (serverId) => {
        const server = await DiscordServer.findById(serverId)
            .populate('channels')
            .populate('members', 'username avatar'); // Üye listesi için gerekli
        if (server) {
            socket.join(serverId);
            socket.emit('server-details', server);
        }
    });

    // --- KANAL YÖNETİMİ (YENİ: SİLME) ---
    socket.on('create-channel', async ({ serverId, name, type }) => {
        const ch = new Channel({ name, type, serverId }); await ch.save();
        await DiscordServer.findByIdAndUpdate(serverId, { $push: { channels: ch._id } });
        const server = await DiscordServer.findById(serverId).populate('channels').populate('members', 'username avatar');
        io.to(serverId).emit('server-updated', server); // Herkese güncelle
    });

    socket.on('delete-server', async ({ serverId, userId }) => {
        const server = await DiscordServer.findById(serverId);
        if(server.owner.toString() === userId) {
            await Channel.deleteMany({ serverId });
            await Message.deleteMany({ channelId: { $in: server.channels } });
            await DiscordServer.findByIdAndDelete(serverId);
            // Tüm üyelerden bu sunucuyu silmek gerekir (Basitlik için atlıyoruz, ama UI'da kaybolur)
            io.to(serverId).emit('server-deleted', serverId);
        }
    });

    socket.on('delete-channel', async ({ channelId, serverId, userId }) => {
        const server = await DiscordServer.findById(serverId);
        if(server.owner.toString() === userId) {
            await Channel.findByIdAndDelete(channelId);
            await DiscordServer.findByIdAndUpdate(serverId, { $pull: { channels: channelId } });
            const updated = await DiscordServer.findById(serverId).populate('channels').populate('members', 'username avatar');
            io.to(serverId).emit('server-updated', updated);
        }
    });

    // --- MODERASYON (KICK) ---
    socket.on('kick-user', async ({ serverId, userId, ownerId }) => {
        const server = await DiscordServer.findById(serverId);
        if (server.owner.toString() === ownerId && userId !== ownerId) {
            server.members = server.members.filter(m => m.toString() !== userId);
            await server.save();
            await User.findByIdAndUpdate(userId, { $pull: { joinedServers: serverId } });
            const updated = await DiscordServer.findById(serverId).populate('members', 'username avatar');
            io.to(serverId).emit('update-member-list', updated.members);
            // Atılan kişiye özel mesaj (Socket odasından atma mantığı client tarafında reload ile çözülür)
        }
    });

    // --- MESAJLAŞMA ---
    socket.on('join-channel', async (channelId) => {
        socket.join(channelId);
        const msgs = await Message.find({ channelId }).sort({ createdAt: 1 }).limit(50);
        socket.emit('load-messages', msgs);
    });

    socket.on('send-message', async (data) => {
        const msg = new Message({ content: data.content, channelId: data.channelId, sender: data.senderId, senderName: data.senderName, senderAvatar: data.senderAvatar });
        await msg.save();
        io.to(data.channelId).emit('new-message', msg);
    });

    // --- SESLİ SOHBET (WEBRTC SIGNALING) ---
    socket.on('join-voice', (channelId) => {
        const user = { id: socket.id, username: socket.username };
        voiceUsers[socket.id] = { channelId, username: socket.username };
        
        // Odadaki diğer kullanıcılara "Ben geldim" de
        const usersInRoom = Array.from(io.sockets.adapter.rooms.get(channelId) || []);
        socket.emit('all-voice-users', usersInRoom); // Mevcutları al
        
        socket.join(channelId);
        // Diğerlerine sinyal gönder
        socket.to(channelId).emit('user-joined-voice', socket.id);
    });

    socket.on('sending-signal', payload => {
        io.to(payload.userToSignal).emit('user-joined-signal', { signal: payload.signal, callerID: payload.callerID });
    });

    socket.on('returning-signal', payload => {
        io.to(payload.callerID).emit('receiving-returned-signal', { signal: payload.signal, id: socket.id });
    });

    socket.on('leave-voice', (channelId) => {
        socket.leave(channelId);
        delete voiceUsers[socket.id];
        io.to(channelId).emit('user-left-voice', socket.id);
    });

    socket.on('disconnect', () => {
        // Sesli sohbetten düşerse
        if(voiceUsers[socket.id]) {
            const chId = voiceUsers[socket.id].channelId;
            io.to(chId).emit('user-left-voice', socket.id);
            delete voiceUsers[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Naberya v2.0 Aktif! 🚀'));