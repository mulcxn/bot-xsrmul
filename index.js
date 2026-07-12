// ============================================================
// BOT PREMIUM XSRMUL - index.js
// Library: @whiskeysockets/baileys
// Author  : Xsrmulz
// ============================================================

'use strict';

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    getContentType,
    jidDecode,
    generateWAMessageFromContent,
    proto
} = require('@whiskeysockets/baileys');

const pino       = require('pino');
const fs         = require('fs');
const fse        = require('fs-extra');
const path       = require('path');
const axios      = require('axios');
const Jimp       = require('jimp');
const ffmpeg     = require('fluent-ffmpeg');
const mime       = require('mime-types');
const NodeCache  = require('node-cache');
const { execSync, exec } = require('child_process');

const config     = require('./settings');

// ============================================================
// DETEKSI OTOMATIS TERMUX & PENGARAHAN PATH FFMPEG / FFPROBE
// ============================================================
const isTermux = (() => {
    try {
        const prefix = process.env.PREFIX || '';
        return prefix.includes('com.termux') ||
               fs.existsSync('/data/data/com.termux') ||
               (process.env.HOME && process.env.HOME.includes('com.termux'));
    } catch {
        return false;
    }
})();

if (isTermux) {
    const termuxBin = process.env.PREFIX
        ? path.join(process.env.PREFIX, 'bin')
        : '/data/data/com.termux/files/usr/bin';

    const ffmpegPath  = path.join(termuxBin, 'ffmpeg');
    const ffprobePath = path.join(termuxBin, 'ffprobe');

    if (fs.existsSync(ffmpegPath))  ffmpeg.setFfmpegPath(ffmpegPath);
    if (fs.existsSync(ffprobePath)) ffmpeg.setFfprobePath(ffprobePath);

    console.log('\x1b[32m[TERMUX]\x1b[0m Terdeteksi Termux Android.');
    console.log(`\x1b[32m[TERMUX]\x1b[0m ffmpeg path : ${ffmpegPath}`);
} else {
    console.log('\x1b[36m[SYSTEM]\x1b[0m Berjalan di lingkungan non-Termux.');
}

// ============================================================
// WHITELIST HELPER — user.json
// ============================================================
const USER_FILE = path.join(__dirname, 'user.json');

function loadUsers() {
    try {
        const raw = fs.readFileSync(USER_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch {
        const def = { whitelist: [config.ownerNumber], pending: [] };
        fs.writeFileSync(USER_FILE, JSON.stringify(def, null, 2));
        return def;
    }
}

function saveUsers(data) {
    fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2));
}

function isOwner(sender) {
    const num = sender.replace(/[^0-9]/g, '');
    return num === config.ownerNumber.replace(/[^0-9]/g, '');
}

function isWhitelisted(sender) {
    const users = loadUsers();
    const num   = sender.replace(/[^0-9]/g, '');
    return users.whitelist.some(n => n.replace(/[^0-9]/g, '') === num);
}

function addWhitelist(number) {
    const users = loadUsers();
    const clean = number.replace(/[^0-9]/g, '');
    if (!users.whitelist.includes(clean)) {
        users.whitelist.push(clean);
        users.pending = users.pending.filter(n => n.replace(/[^0-9]/g, '') !== clean);
        saveUsers(users);
        return true;
    }
    return false;
}

function rejectPending(number) {
    const users = loadUsers();
    const clean = number.replace(/[^0-9]/g, '');
    users.pending = users.pending.filter(n => n.replace(/[^0-9]/g, '') !== clean);
    saveUsers(users);
}

function addPending(number) {
    const users = loadUsers();
    const clean = number.replace(/[^0-9]/g, '');
    if (!users.pending.includes(clean) && !users.whitelist.includes(clean)) {
        users.pending.push(clean);
        saveUsers(users);
        return true;
    }
    return false;
}

// ============================================================
// AUTO-REPLY HELPER — autoreply.json
// ============================================================
const AR_FILE = path.join(__dirname, 'autoreply.json');

function loadReplies() {
    try {
        const raw = fs.readFileSync(AR_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch {
        const def = { replies: [] };
        fs.writeFileSync(AR_FILE, JSON.stringify(def, null, 2));
        return def;
    }
}

function saveReplies(data) {
    fs.writeFileSync(AR_FILE, JSON.stringify(data, null, 2));
}

function addAutoReply(keyword, balasan) {
    const data  = loadReplies();
    const lower = keyword.toLowerCase();
    const idx   = data.replies.findIndex(r => r.keyword.toLowerCase() === lower);
    if (idx >= 0) {
        data.replies[idx].balasan = balasan;
    } else {
        data.replies.push({ keyword: lower, balasan });
    }
    saveReplies(data);
}

function delAutoReply(keyword) {
    const data  = loadReplies();
    const lower = keyword.toLowerCase();
    const before = data.replies.length;
    data.replies = data.replies.filter(r => r.keyword.toLowerCase() !== lower);
    saveReplies(data);
    return data.replies.length < before;
}

function checkAutoReply(text) {
    const data  = loadReplies();
    const lower = text.toLowerCase().trim();
    return data.replies.find(r => lower.includes(r.keyword.toLowerCase())) || null;
}

// ============================================================
// RATE LIMITER — hanya untuk user non-owner
// ============================================================
// Map struktur: sender -> { count, windowStart, coolingUntil, warned }
const rateLimitMap = new Map();

function checkRateLimit(sender) {
    if (isOwner(sender)) return { allowed: true };

    const rl  = config.rateLimit;
    const now = Date.now();
    let   rec = rateLimitMap.get(sender);

    // Inisialisasi record baru
    if (!rec) {
        rec = { count: 0, windowStart: now, coolingUntil: 0, warned: false };
        rateLimitMap.set(sender, rec);
    }

    // Sedang dalam cooldown
    if (rec.coolingUntil > now) {
        const sisaDetik = Math.ceil((rec.coolingUntil - now) / 1000);
        return {
            allowed: false,
            cooldown: true,
            sisaDetik
        };
    }

    // Reset window jika sudah lewat jendela waktu
    if (now - rec.windowStart >= rl.windowMs) {
        rec.count      = 0;
        rec.windowStart = now;
        rec.warned      = false;
    }

    rec.count++;

    // Kena limit — aktifkan cooldown
    if (rec.count > rl.maxCommands) {
        rec.coolingUntil = now + rl.cooldownMs;
        rec.count        = 0;
        rec.warned       = false;
        rateLimitMap.set(sender, rec);
        const sisaDetik = Math.ceil(rl.cooldownMs / 1000);
        return { allowed: false, cooldown: true, sisaDetik };
    }

    // Kirim peringatan mendekati limit
    if (rec.count >= rl.warnAt && !rec.warned) {
        rec.warned = true;
        rateLimitMap.set(sender, rec);
        const sisa = rl.maxCommands - rec.count;
        return { allowed: true, warning: true, sisaCommand: sisa };
    }

    rateLimitMap.set(sender, rec);
    return { allowed: true };
}

// Bersihkan map setiap 5 menit agar tidak bocor memori
setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of rateLimitMap.entries()) {
        if (rec.coolingUntil < now && (now - rec.windowStart) > config.rateLimit.windowMs * 2) {
            rateLimitMap.delete(key);
        }
    }
}, 5 * 60 * 1000);

// ============================================================
// HELPER UMUM
// ============================================================
const msgRetryCounterCache = new NodeCache();

function cleanJid(jid) {
    if (!jid) return '';
    return jid.replace(/:[0-9]+@/, '@');
}

function getSender(msg) {
    const jid = msg.key.remoteJid || '';
    if (jid.endsWith('@g.us')) {
        return msg.key.participant || msg.pushName || '';
    }
    return jid;
}

function getBody(msg) {
    const m = msg.message;
    if (!m) return '';
    const type = getContentType(m);
    return (
        m?.conversation ||
        m?.extendedTextMessage?.text ||
        m?.imageMessage?.caption ||
        m?.videoMessage?.caption ||
        m?.buttonsResponseMessage?.selectedButtonId ||
        m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ''
    );
}

function getQuotedMsg(msg) {
    const m = msg.message;
    if (!m) return null;
    const type = getContentType(m);
    return m?.[type]?.contextInfo?.quotedMessage || null;
}

function isGroupMsg(msg) {
    return msg.key.remoteJid?.endsWith('@g.us') || false;
}

function formatJid(number) {
    return number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
}

const startTime = Date.now();

function getRuntime() {
    const uptime = Date.now() - startTime;
    const s = Math.floor(uptime / 1000) % 60;
    const m = Math.floor(uptime / 60000) % 60;
    const h = Math.floor(uptime / 3600000);
    return `${h} jam ${m} menit ${s} detik`;
}

// ============================================================
// DOWNLOAD MEDIA HELPER
// ============================================================
async function dlMedia(msg, type) {
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: null });
        return buffer;
    } catch (e) {
        console.error('[dlMedia]', e);
        return null;
    }
}

// ============================================================
// KONVERSI FFMPEG HELPER (ANTI-ERROR TERMUX)
// ============================================================
function ffmpegConvert(inputPath, outputPath, options = []) {
    return new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath);
        options.forEach(o => cmd = cmd.outputOption(o));
        cmd.save(outputPath)
            .on('end', resolve)
            .on('error', reject);
    });
}

async function toSticker(inputBuf, isAnimated = false) {
    const tmpIn  = path.join(__dirname, `tmp_in_${Date.now()}`);
    const tmpOut = path.join(__dirname, `tmp_out_${Date.now()}.webp`);
    fs.writeFileSync(tmpIn, inputBuf);
    try {
        if (isAnimated) {
            await ffmpegConvert(tmpIn, tmpOut, [
                '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15',
                '-loop', '0',
                '-preset', 'default',
                '-an',
                '-vsync', '0'
            ]);
        } else {
            await ffmpegConvert(tmpIn, tmpOut, [
                '-vf', 'scale=512:512:force_original_aspect_ratio=decrease',
                '-lossless', '1'
            ]);
        }
        const buf = fs.readFileSync(tmpOut);
        return buf;
    } finally {
        if (fs.existsSync(tmpIn))  fs.unlinkSync(tmpIn);
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    }
}

async function toImg(stickerBuf) {
    const tmpIn  = path.join(__dirname, `tmp_in_${Date.now()}.webp`);
    const tmpOut = path.join(__dirname, `tmp_out_${Date.now()}.png`);
    fs.writeFileSync(tmpIn, stickerBuf);
    try {
        await ffmpegConvert(tmpIn, tmpOut, []);
        const buf = fs.readFileSync(tmpOut);
        return buf;
    } finally {
        if (fs.existsSync(tmpIn))  fs.unlinkSync(tmpIn);
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    }
}

async function toMp3(videoBuf) {
    const tmpIn  = path.join(__dirname, `tmp_in_${Date.now()}.mp4`);
    const tmpOut = path.join(__dirname, `tmp_out_${Date.now()}.mp3`);
    fs.writeFileSync(tmpIn, videoBuf);
    try {
        await new Promise((resolve, reject) => {
            ffmpeg(tmpIn)
                .noVideo()
                .audioCodec('libmp3lame')
                .audioBitrate(128)
                .save(tmpOut)
                .on('end', resolve)
                .on('error', reject);
        });
        const buf = fs.readFileSync(tmpOut);
        return buf;
    } finally {
        if (fs.existsSync(tmpIn))  fs.unlinkSync(tmpIn);
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    }
}

async function toVideo(gifBuf) {
    const tmpIn  = path.join(__dirname, `tmp_in_${Date.now()}.gif`);
    const tmpOut = path.join(__dirname, `tmp_out_${Date.now()}.mp4`);
    fs.writeFileSync(tmpIn, gifBuf);
    try {
        await ffmpegConvert(tmpIn, tmpOut, ['-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']);
        const buf = fs.readFileSync(tmpOut);
        return buf;
    } finally {
        if (fs.existsSync(tmpIn))  fs.unlinkSync(tmpIn);
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    }
}

// ============================================================
// TEKS MENU
// ============================================================
const MENU_TEXT = `*WELCOME TO BOT XSRMUL* ⚔️🔥

╔════════════════════╗
        *OWNER*
╠════════════════════╝
│ ├ .broadcast [pesan]
│ ├ .clear
│ ├ .block [nomor]
│ ├ .unblock [nomor]
│ ├ .listuser
│ ├ .acc [nomor]
│ ├ .tolak [nomor]
│ ├ .setlimit [angka]
│ ├ .setreply [kata]|[balas]
│ ├ .delreply [kata]
│ ├ .listreply
│
╔════════════════════╗
      *DOWNLOADER*
╠════════════════════╝
│ ├ .tiktok [link]
│ ├ .tt [link]
│ ├ .instagram [link]
│ ├ .facebook [link]
│ ├ .twitter [link]
│ ├ .youtube [link]
│ ├ .play [judul]
│ ├ .pinterest [query]
│ ├ .spotify [judul]
│
╔════════════════════╗
     *GROUP MANAGE*
╠════════════════════╝
│ ├ .kick [@tag]
│ ├ .add [nomor]
│ ├ .promote [@tag]
│ ├ .demote [@tag]
│ ├ .tagall [pesan]
│ ├ .hidetag [pesan]
│ ├ .group [open/close]
│ ├ .link
│ ├ .setdesc [teks]
│
╔════════════════════╗
        *MAKER*
╠════════════════════╝
│ ├ .sticker
│ ├ .stickerteks [teks]
│ ├ .toimg
│ ├ .tovideo
│ ├ .tomp3
│ ├ .tourl
│ ├ .qrcode [teks]
│ ├ .remini
│ ├ .removebg
│
╔════════════════════╗
     *AI & TOOLS*
╠════════════════════╝
│ ├ .ai [teks]
│ ├ .ai2 [teks]
│ ├ .gemini [teks]
│ ├ .brainly [teks]
│ ├ .gimage [teks]
│ ├ .translate [lang] [teks]
│ ├ .lyric [judul]
│ ├ .kbbi [kata]
│ ├ .weather [kota]
│ ├ .sholat [kota]
│ ├ .shortlink [url]
│ ├ .calc [ekspresi]
│ ├ .tts [teks]
│ ├ .runtime
│ ├ .speed
│
╔════════════════════╗
         *FUN*
╠════════════════════╝
│ ├ .tebakgambar
│ ├ .tebakkata
│ ├ .gantengcek
│ ├ .couplecek
│ ├ .truth
│ ├ .dare
│ ├ .meme
│ ├ .fakta
│ ├ .quotes
│
╚════════════════════╝
*STATUS: ACTIVE | SECURE*`;

// ============================================================
// KONEKSI UTAMA
// ============================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const conn = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        browser: ['BOT XSRMUL', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
    });

    // ─── Pairing Code otomatis dengan delay 6 detik ───────────
    if (!conn.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const botNum = config.botNumber.replace(/[^0-9]/g, '');
                const code   = await conn.requestPairingCode(botNum);
                const fmt    = code.match(/.{1,4}/g)?.join('-') || code;
                console.log('\n\x1b[1m\x1b[33m╔══════════════════════════╗\x1b[0m');
                console.log('\x1b[1m\x1b[33m║   KODE PAIRING ANDA      ║\x1b[0m');
                console.log(`\x1b[1m\x1b[32m║       ${fmt}       ║\x1b[0m`);
                console.log('\x1b[1m\x1b[33m╚══════════════════════════╝\x1b[0m\n');
            } catch (e) {
                console.error('[PAIRING ERROR]', e.message);
            }
        }, 6000);
    }

    // ─── Koneksi update ──────────────────────────────────────
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('[CONN] Koneksi terputus.', shouldReconnect ? 'Mencoba reconnect...' : 'Sesi logout.');
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        }

        if (connection === 'open') {
            console.log(`\x1b[32m[CONN]\x1b[0m Bot ${config.botName} berhasil terhubung!`);
        }
    });

    conn.ev.on('creds.update', saveCreds);

    // ─── Handler pesan masuk ─────────────────────────────────
    conn.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const from    = msg.key.remoteJid;
            const sender  = cleanJid(getSender(msg));
            const body    = getBody(msg).trim();
            const isGroup = isGroupMsg(msg);
            const isOw    = isOwner(sender);
            const isWL    = isWhitelisted(sender);
            const args    = body.split(' ');
            const cmd     = args[0].toLowerCase();

            // ── Pesan masuk ke log ──────────────────────────
            // ── Whitelist Gate ──────────────────────────────
            if (!isOw && !isWL) {
                if (cmd === '.request') {
                    const added = addPending(sender);
                    const ownerJid = formatJid(config.ownerNumber);
                    if (added) {
                        await conn.sendMessage(from, {
                            text: `✅ Permintaan akses dari *${sender}* telah dikirim ke Owner. Harap tunggu konfirmasi.`
                        }, { quoted: msg });
                        await conn.sendMessage(ownerJid, {
                            text: `🔔 *PERMINTAAN WHITELIST*\n\nNomor: *${sender}*\nmengirim permintaan akses bot.\n\nBalas dengan:\n*.acc ${sender}* — untuk setujui\n*.tolak ${sender}* — untuk tolak`
                        });
                    } else {
                        await conn.sendMessage(from, {
                            text: '⏳ Permintaan kamu sudah tercatat dan sedang menunggu persetujuan Owner.'
                        }, { quoted: msg });
                    }
                } else {
                    await conn.sendMessage(from, {
                        text: `🚫 *AKSES DITOLAK!*\nNomor kamu belum terdaftar di whitelist bot.\n\nKetik *.request* untuk meminta akses kepada Owner.`
                    }, { quoted: msg });
                }
                continue;
            }

            // ── Auto-Reply Check (berlaku untuk semua pesan) ─
            if (!body.startsWith('.')) {
                const arMatch = checkAutoReply(body);
                if (arMatch) {
                    await conn.sendMessage(from, { text: arMatch.balasan }, { quoted: msg });
                }
                continue;
            }

            // ── Rate Limit Gate ──────────────────────────────
            const rlResult = checkRateLimit(sender);
            if (!rlResult.allowed) {
                await conn.sendMessage(from, {
                    text: `⏳ *RATE LIMIT!*\nKamu mengirim terlalu banyak perintah.\n\n🕒 Tunggu *${rlResult.sisaDetik} detik* sebelum bisa menggunakan bot lagi.`
                }, { quoted: msg });
                continue;
            }
            if (rlResult.warning) {
                await conn.sendMessage(from, {
                    text: `⚠️ *PERINGATAN!* Kamu sudah hampir mencapai batas perintah.\nSisa: *${rlResult.sisaCommand} perintah* sebelum cooldown ${Math.ceil(config.rateLimit.cooldownMs / 1000)}s.`
                }, { quoted: msg });
            }

            // ────────────────────────────────────────────────
            // MENU
            // ────────────────────────────────────────────────
            if (cmd === '.menu' || cmd === '.mennu') {
                try {
                    const imgRes = await axios.get(config.menuImage, { responseType: 'arraybuffer', timeout: 15000 });
                    await conn.sendMessage(from, {
                        image: Buffer.from(imgRes.data),
                        caption: MENU_TEXT
                    }, { quoted: msg });
                } catch {
                    await conn.sendMessage(from, { text: MENU_TEXT }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // RUNTIME
            // ────────────────────────────────────────────────
            if (cmd === '.runtime') {
                await conn.sendMessage(from, {
                    text: `⏱️ *Runtime Bot*\n${getRuntime()}`
                }, { quoted: msg });
                continue;
            }

            // ────────────────────────────────────────────────
            // SPEED / PING
            // ────────────────────────────────────────────────
            if (cmd === '.speed' || cmd === '.ping') {
                const t1  = Date.now();
                const tmp = await conn.sendMessage(from, { text: '⚡ Mengecek speed...' }, { quoted: msg });
                const t2  = Date.now();
                await conn.sendMessage(from, {
                    text: `⚡ *Speed Bot*: ${t2 - t1}ms`
                }, { quoted: msg });
                continue;
            }

            // ────────────────────────────────────────────────
            // STICKER / STIKER
            // ────────────────────────────────────────────────
            if (cmd === '.sticker' || cmd === '.stiker') {
                const msgType    = getContentType(msg.message);
                const quotedMsg  = getQuotedMsg(msg);
                const quotedType = quotedMsg ? getContentType(quotedMsg) : null;

                const hasDirectImg  = ['imageMessage', 'videoMessage'].includes(msgType);
                const hasQuotedImg  = quotedMsg && ['imageMessage', 'videoMessage'].includes(quotedType);

                if (!hasDirectImg && !hasQuotedImg) {
                    await conn.sendMessage(from, {
                        text: '⚠️ *FORMAT SALAH!* Gagal membuat stiker. Cara penggunaan: Kirim gambar dengan caption *.sticker* ATAU balas (reply) gambar yang sudah ada dengan mengetik *.sticker*.'
                    }, { quoted: msg });
                    continue;
                }

                await conn.sendMessage(from, { text: '🎴 Membuat stiker...' }, { quoted: msg });
                try {
                    let mediaBuf;
                    let isAnim = false;
                    if (hasDirectImg) {
                        mediaBuf = await dlMedia(msg, msgType);
                        isAnim   = msgType === 'videoMessage';
                    } else {
                        const fakeMsg = { message: quotedMsg, key: msg.key };
                        mediaBuf = await dlMedia(fakeMsg, quotedType);
                        isAnim   = quotedType === 'videoMessage';
                    }
                    const stickerBuf = await toSticker(mediaBuf, isAnim);
                    await conn.sendMessage(from, {
                        sticker: stickerBuf
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal membuat stiker: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TOIMG (stiker → gambar)
            // ────────────────────────────────────────────────
            if (cmd === '.toimg') {
                const quotedMsg  = getQuotedMsg(msg);
                const quotedType = quotedMsg ? getContentType(quotedMsg) : null;
                const msgType    = getContentType(msg.message);
                const isStickerDirect = msgType === 'stickerMessage';
                const isStickerQuoted = quotedType === 'stickerMessage';

                if (!isStickerDirect && !isStickerQuoted) {
                    await conn.sendMessage(from, { text: '⚠️ *FORMAT SALAH!* Reply atau kirim stiker dengan caption *.toimg*' }, { quoted: msg });
                    continue;
                }

                try {
                    let buf;
                    if (isStickerDirect) {
                        buf = await dlMedia(msg, 'stickerMessage');
                    } else {
                        const fakeMsg = { message: quotedMsg, key: msg.key };
                        buf = await dlMedia(fakeMsg, 'stickerMessage');
                    }
                    const imgBuf = await toImg(buf);
                    await conn.sendMessage(from, { image: imgBuf, caption: '✅ Berhasil dikonversi ke gambar!' }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal konversi: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TOMP3 (video → mp3)
            // ────────────────────────────────────────────────
            if (cmd === '.tomp3') {
                const quotedMsg  = getQuotedMsg(msg);
                const quotedType = quotedMsg ? getContentType(quotedMsg) : null;
                const msgType    = getContentType(msg.message);
                const isVid      = msgType === 'videoMessage' || quotedType === 'videoMessage';

                if (!isVid) {
                    await conn.sendMessage(from, { text: '⚠️ *FORMAT SALAH!* Reply atau kirim video dengan caption *.tomp3*' }, { quoted: msg });
                    continue;
                }

                await conn.sendMessage(from, { text: '🎵 Mengkonversi video ke MP3...' }, { quoted: msg });
                try {
                    let buf;
                    if (msgType === 'videoMessage') {
                        buf = await dlMedia(msg, 'videoMessage');
                    } else {
                        const fakeMsg = { message: quotedMsg, key: msg.key };
                        buf = await dlMedia(fakeMsg, 'videoMessage');
                    }
                    const mp3Buf = await toMp3(buf);
                    await conn.sendMessage(from, {
                        audio: mp3Buf,
                        mimetype: 'audio/mpeg',
                        ptt: false
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal konversi: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TOVIDEO (gif → mp4)
            // ────────────────────────────────────────────────
            if (cmd === '.tovideo') {
                const quotedMsg  = getQuotedMsg(msg);
                const quotedType = quotedMsg ? getContentType(quotedMsg) : null;
                const msgType    = getContentType(msg.message);
                const isGif      = msgType === 'videoMessage' || quotedType === 'videoMessage';

                if (!isGif) {
                    await conn.sendMessage(from, { text: '⚠️ *FORMAT SALAH!* Reply atau kirim GIF/video dengan caption *.tovideo*' }, { quoted: msg });
                    continue;
                }

                await conn.sendMessage(from, { text: '🎬 Mengkonversi...' }, { quoted: msg });
                try {
                    let buf;
                    if (msgType === 'videoMessage') {
                        buf = await dlMedia(msg, 'videoMessage');
                    } else {
                        const fakeMsg = { message: quotedMsg, key: msg.key };
                        buf = await dlMedia(fakeMsg, 'videoMessage');
                    }
                    const vidBuf = await toVideo(buf);
                    await conn.sendMessage(from, { video: vidBuf, caption: '✅ Konversi selesai!' }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TOURL — upload gambar ke catbox
            // ────────────────────────────────────────────────
            if (cmd === '.tourl') {
                const msgType   = getContentType(msg.message);
                const quotedMsg = getQuotedMsg(msg);
                const qType     = quotedMsg ? getContentType(quotedMsg) : null;
                const hasMedia  = ['imageMessage', 'videoMessage', 'stickerMessage'].includes(msgType)
                               || ['imageMessage', 'videoMessage', 'stickerMessage'].includes(qType);

                if (!hasMedia) {
                    await conn.sendMessage(from, { text: '⚠️ *FORMAT SALAH!* Reply atau kirim media dengan caption *.tourl*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '🔗 Mengupload media...' }, { quoted: msg });
                try {
                    let buf, ext;
                    const useType = ['imageMessage', 'videoMessage', 'stickerMessage'].includes(msgType)
                        ? msgType : qType;
                    const useMsg  = ['imageMessage', 'videoMessage', 'stickerMessage'].includes(msgType)
                        ? msg : { message: quotedMsg, key: msg.key };

                    buf = await dlMedia(useMsg, useType);
                    ext = useType === 'imageMessage' ? 'jpg' : useType === 'videoMessage' ? 'mp4' : 'webp';

                    const FormData = require('form-data');
                    const form = new FormData();
                    form.append('reqtype', 'fileupload');
                    form.append('fileToUpload', buf, { filename: `file.${ext}` });
                    const res = await axios.post('https://catbox.moe/user.php', form, {
                        headers: form.getHeaders(),
                        timeout: 30000
                    });
                    await conn.sendMessage(from, { text: `🔗 *URL Media:*\n${res.data}` }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal upload: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TIKTOK / TT DOWNLOADER
            // ────────────────────────────────────────────────
            if (cmd === '.tiktok' || cmd === '.tt') {
                const link = args[1];
                if (!link) {
                    await conn.sendMessage(from, { text: '⚠️ *LINK MASIH KOSONG!* Sediakan link yang valid setelah perintah.' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '⏳ Memproses TikTok...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(link)}`, { timeout: 20000 });
                    const data = res.data;
                    const videoUrl = data?.video?.noWatermark || data?.video?.watermark;
                    if (!videoUrl) throw new Error('Tidak ditemukan video');
                    const videoBuf = (await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 30000 })).data;
                    await conn.sendMessage(from, {
                        video: Buffer.from(videoBuf),
                        caption: `🎵 *${data?.title || 'TikTok Video'}*\n\n📥 Download via BOT XSRMUL`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal download TikTok: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // INSTAGRAM DOWNLOADER
            // ────────────────────────────────────────────────
            if (cmd === '.instagram' || cmd === '.ig') {
                const link = args[1];
                if (!link) {
                    await conn.sendMessage(from, { text: '⚠️ *LINK MASIH KOSONG!* Sediakan link yang valid setelah perintah.' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '⏳ Memproses Instagram...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.instagramdl.live/api?url=${encodeURIComponent(link)}`, { timeout: 20000 });
                    const data = res.data?.data?.[0] || res.data?.result?.[0];
                    if (!data?.url) throw new Error('Media tidak ditemukan');
                    const mediaBuf = (await axios.get(data.url, { responseType: 'arraybuffer', timeout: 30000 })).data;
                    const isVideo  = data.type === 'video' || data.url.includes('.mp4');
                    if (isVideo) {
                        await conn.sendMessage(from, { video: Buffer.from(mediaBuf), caption: '📥 Instagram Video | BOT XSRMUL' }, { quoted: msg });
                    } else {
                        await conn.sendMessage(from, { image: Buffer.from(mediaBuf), caption: '📥 Instagram Image | BOT XSRMUL' }, { quoted: msg });
                    }
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal download Instagram: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // YOUTUBE DOWNLOADER (video)
            // ────────────────────────────────────────────────
            if (cmd === '.youtube' || cmd === '.yt') {
                const link = args[1];
                if (!link) {
                    await conn.sendMessage(from, { text: '⚠️ *LINK MASIH KOSONG!* Sediakan link yang valid setelah perintah.' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '⏳ Memproses YouTube...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.agcracker.xyz/api/ytdl?url=${encodeURIComponent(link)}`, { timeout: 25000 });
                    const data = res.data;
                    const videoUrl = data?.result?.download?.video || data?.result?.mp4;
                    if (!videoUrl) throw new Error('Video tidak ditemukan');
                    await conn.sendMessage(from, { text: `🎬 *${data?.result?.title || 'YouTube Video'}*\n\n🔗 Link download:\n${videoUrl}\n\n📥 BOT XSRMUL` }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // PLAY — YouTube search + download mp3
            // ────────────────────────────────────────────────
            if (cmd === '.play') {
                const query = args.slice(1).join(' ');
                if (!query) {
                    await conn.sendMessage(from, { text: '⚠️ *LINK MASIH KOSONG!* Sediakan judul lagu setelah perintah.' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: `🎵 Mencari: *${query}*...` }, { quoted: msg });
                try {
                    const searchRes = await axios.get(`https://api.agcracker.xyz/api/ytsearch?q=${encodeURIComponent(query)}`, { timeout: 15000 });
                    const first = searchRes.data?.result?.[0];
                    if (!first) throw new Error('Tidak ditemukan');
                    const dlRes = await axios.get(`https://api.agcracker.xyz/api/ytdl?url=${encodeURIComponent(first.url)}`, { timeout: 25000 });
                    const audioUrl = dlRes.data?.result?.download?.audio || dlRes.data?.result?.mp3;
                    if (!audioUrl) throw new Error('Audio tidak ditemukan');
                    const audioBuf = (await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 30000 })).data;
                    await conn.sendMessage(from, {
                        audio: Buffer.from(audioBuf),
                        mimetype: 'audio/mpeg',
                        ptt: false
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal .play: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // PINTEREST
            // ────────────────────────────────────────────────
            if (cmd === '.pinterest' || cmd === '.pin') {
                const query = args.slice(1).join(' ');
                if (!query) {
                    await conn.sendMessage(from, { text: '⚠️ *LINK MASIH KOSONG!* Sediakan query pencarian setelah perintah.' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: `🖼️ Mencari gambar Pinterest: *${query}*...` }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.agcracker.xyz/api/pinterest?q=${encodeURIComponent(query)}`, { timeout: 15000 });
                    const images = res.data?.result?.slice(0, 5);
                    if (!images || images.length === 0) throw new Error('Gambar tidak ditemukan');
                    for (const imgUrl of images) {
                        const imgBuf = (await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 15000 })).data;
                        await conn.sendMessage(from, { image: Buffer.from(imgBuf), caption: `📌 Pinterest | BOT XSRMUL` });
                    }
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal Pinterest: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // AI — ChatGPT via free API
            // ────────────────────────────────────────────────
            if (cmd === '.ai') {
                const prompt = args.slice(1).join(' ');
                if (!prompt) {
                    await conn.sendMessage(from, { text: '⚠️ Tulis pertanyaan setelah perintah *.ai*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '🤖 Memproses dengan ChatGPT...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.agcracker.xyz/api/gpt?text=${encodeURIComponent(prompt)}`, { timeout: 30000 });
                    const answer = res.data?.result || res.data?.message || res.data?.response || 'Tidak ada jawaban.';
                    await conn.sendMessage(from, { text: `🤖 *ChatGPT*\n\n${answer}` }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ AI Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // AI2 — Logic Alternative (fallback API)
            // ────────────────────────────────────────────────
            if (cmd === '.ai2') {
                const prompt = args.slice(1).join(' ');
                if (!prompt) {
                    await conn.sendMessage(from, { text: '⚠️ Tulis pertanyaan setelah perintah *.ai2*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '🧠 Memproses AI2...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/ai/meta-llama?prompt=${encodeURIComponent(prompt)}`, { timeout: 30000 });
                    const answer = res.data?.data || res.data?.result || 'Tidak ada jawaban.';
                    await conn.sendMessage(from, { text: `🧠 *AI2 (LLaMA)*\n\n${answer}` }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ AI2 Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // GEMINI
            // ────────────────────────────────────────────────
            if (cmd === '.gemini') {
                const prompt = args.slice(1).join(' ');
                if (!prompt) {
                    await conn.sendMessage(from, { text: '⚠️ Tulis pertanyaan setelah perintah *.gemini*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '✨ Memproses dengan Gemini...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/ai/gemini-pro?prompt=${encodeURIComponent(prompt)}`, { timeout: 30000 });
                    const answer = res.data?.data || res.data?.result || 'Tidak ada jawaban.';
                    await conn.sendMessage(from, { text: `✨ *Gemini*\n\n${answer}` }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gemini Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // BRAINLY
            // ────────────────────────────────────────────────
            if (cmd === '.brainly') {
                const query = args.slice(1).join(' ');
                if (!query) {
                    await conn.sendMessage(from, { text: '⚠️ Tulis pertanyaan setelah *.brainly*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '📚 Mencari di Brainly...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/s/brainly?q=${encodeURIComponent(query)}`, { timeout: 20000 });
                    const data = res.data?.data?.[0];
                    if (!data) throw new Error('Tidak ditemukan');
                    await conn.sendMessage(from, {
                        text: `📚 *Brainly*\n\n❓ *Pertanyaan:*\n${data.question}\n\n✅ *Jawaban:*\n${data.answer}`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Brainly Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // GIMAGE — generate gambar dengan AI
            // ────────────────────────────────────────────────
            if (cmd === '.gimage') {
                const prompt = args.slice(1).join(' ');
                if (!prompt) {
                    await conn.sendMessage(from, { text: '⚠️ Tulis deskripsi gambar setelah *.gimage*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '🎨 Membuat gambar AI...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/ai/text2img?prompt=${encodeURIComponent(prompt)}`, {
                        responseType: 'arraybuffer',
                        timeout: 30000
                    });
                    await conn.sendMessage(from, { image: Buffer.from(res.data), caption: `🎨 *Generated:* ${prompt}` }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal generate: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // KBBI
            // ────────────────────────────────────────────────
            if (cmd === '.kbbi') {
                const kata = args.slice(1).join(' ');
                if (!kata) {
                    await conn.sendMessage(from, { text: '⚠️ Tulis kata setelah *.kbbi*' }, { quoted: msg });
                    continue;
                }
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/s/kbbi?q=${encodeURIComponent(kata)}`, { timeout: 15000 });
                    const data = res.data?.data;
                    if (!data) throw new Error('Kata tidak ditemukan');
                    let text = `📖 *KBBI — ${kata.toUpperCase()}*\n\n`;
                    if (Array.isArray(data)) {
                        data.forEach((d, i) => {
                            text += `*${i + 1}.* ${d.arti || d}\n`;
                        });
                    } else {
                        text += data;
                    }
                    await conn.sendMessage(from, { text }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ KBBI Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // WEATHER
            // ────────────────────────────────────────────────
            if (cmd === '.weather' || cmd === '.cuaca') {
                const kota = args.slice(1).join(' ');
                if (!kota) {
                    await conn.sendMessage(from, { text: '⚠️ Tulis nama kota setelah *.weather*' }, { quoted: msg });
                    continue;
                }
                try {
                    const res = await axios.get(`https://wttr.in/${encodeURIComponent(kota)}?format=j1`, { timeout: 15000 });
                    const d   = res.data;
                    const cur = d?.current_condition?.[0];
                    const loc = d?.nearest_area?.[0];
                    if (!cur) throw new Error('Kota tidak ditemukan');
                    await conn.sendMessage(from, {
                        text: `🌤️ *Cuaca ${kota.toUpperCase()}*\n\n📍 Lokasi: ${loc?.areaName?.[0]?.value}, ${loc?.country?.[0]?.value}\n🌡️ Suhu: ${cur.temp_C}°C\n💧 Kelembaban: ${cur.humidity}%\n🌬️ Angin: ${cur.windspeedKmph} km/h\n☁️ Kondisi: ${cur.weatherDesc?.[0]?.value}`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Weather Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TTS — Text to Speech
            // ────────────────────────────────────────────────
            if (cmd === '.tts') {
                const teks = args.slice(1).join(' ');
                if (!teks) {
                    await conn.sendMessage(from, { text: '⚠️ Tulis teks setelah *.tts*' }, { quoted: msg });
                    continue;
                }
                try {
                    const ttsUrl = `https://api.siputzx.my.id/api/tools/tts?text=${encodeURIComponent(teks)}&lang=id`;
                    const res = await axios.get(ttsUrl, { responseType: 'arraybuffer', timeout: 15000 });
                    await conn.sendMessage(from, {
                        audio: Buffer.from(res.data),
                        mimetype: 'audio/mpeg',
                        ptt: true
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ TTS Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // REMINI — enhance gambar
            // ────────────────────────────────────────────────
            if (cmd === '.remini') {
                const msgType   = getContentType(msg.message);
                const quotedMsg = getQuotedMsg(msg);
                const qType     = quotedMsg ? getContentType(quotedMsg) : null;
                const hasImg    = msgType === 'imageMessage' || qType === 'imageMessage';
                if (!hasImg) {
                    await conn.sendMessage(from, { text: '⚠️ *FORMAT SALAH!* Reply atau kirim gambar dengan caption *.remini*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '✨ Enhancing gambar...' }, { quoted: msg });
                try {
                    let buf;
                    if (msgType === 'imageMessage') {
                        buf = await dlMedia(msg, 'imageMessage');
                    } else {
                        buf = await dlMedia({ message: quotedMsg, key: msg.key }, 'imageMessage');
                    }
                    const FormData = require('form-data');
                    const form = new FormData();
                    form.append('image', buf, { filename: 'img.jpg', contentType: 'image/jpeg' });
                    const res = await axios.post('https://api.siputzx.my.id/api/tools/remini', form, {
                        headers: form.getHeaders(),
                        responseType: 'arraybuffer',
                        timeout: 60000
                    });
                    await conn.sendMessage(from, { image: Buffer.from(res.data), caption: '✨ Hasil Remini | BOT XSRMUL' }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Remini Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // REMOVEBG
            // ────────────────────────────────────────────────
            if (cmd === '.removebg') {
                const msgType   = getContentType(msg.message);
                const quotedMsg = getQuotedMsg(msg);
                const qType     = quotedMsg ? getContentType(quotedMsg) : null;
                const hasImg    = msgType === 'imageMessage' || qType === 'imageMessage';
                if (!hasImg) {
                    await conn.sendMessage(from, { text: '⚠️ Reply atau kirim gambar dengan caption *.removebg*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '🖼️ Menghapus background...' }, { quoted: msg });
                try {
                    let buf;
                    if (msgType === 'imageMessage') {
                        buf = await dlMedia(msg, 'imageMessage');
                    } else {
                        buf = await dlMedia({ message: quotedMsg, key: msg.key }, 'imageMessage');
                    }
                    const FormData = require('form-data');
                    const form = new FormData();
                    form.append('image_file', buf, { filename: 'img.png', contentType: 'image/png' });
                    form.append('size', 'auto');
                    const res = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
                        headers: { ...form.getHeaders(), 'X-Api-Key': 'DEMO' },
                        responseType: 'arraybuffer',
                        timeout: 30000
                    });
                    await conn.sendMessage(from, { image: Buffer.from(res.data), caption: '✅ Background dihapus | BOT XSRMUL' }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ RemoveBG Error: ${e.message}\n\n*Catatan:* Ganti DEMO dengan API key dari remove.bg` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // QUOTES
            // ────────────────────────────────────────────────
            if (cmd === '.quotes') {
                try {
                    const res = await axios.get('https://api.siputzx.my.id/api/r/quotes-islami', { timeout: 10000 });
                    const q   = res.data?.data?.quotes || res.data?.data?.quote || 'Tidak ada quote tersedia.';
                    const a   = res.data?.data?.author || '';
                    await conn.sendMessage(from, {
                        text: `💬 *Quotes of the Day*\n\n_"${q}"_\n\n— ${a}`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Quotes Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TEBAK GAMBAR
            // ────────────────────────────────────────────────
            if (cmd === '.tebakgambar') {
                try {
                    const res = await axios.get('https://api.siputzx.my.id/api/g/tebak-gambar', { timeout: 10000 });
                    const data = res.data?.data;
                    const soalUrl = data?.soal || data?.image;
                    const jawaban = data?.jawaban || data?.answer;
                    if (!soalUrl) throw new Error('Soal tidak tersedia');
                    const imgBuf = (await axios.get(soalUrl, { responseType: 'arraybuffer', timeout: 15000 })).data;
                    await conn.sendMessage(from, {
                        image: Buffer.from(imgBuf),
                        caption: `❓ *TEBAK GAMBAR*\n\nTebak gambar ini!\nKetik *.jawab [jawaban]* untuk menjawab.\n\n||Kunci: ${jawaban}||`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // GANTENG CEK
            // ────────────────────────────────────────────────
            if (cmd === '.gantengcek') {
                const skor = Math.floor(Math.random() * 100) + 1;
                const msg2 = skor >= 80 ? '💪 Kamu memang tampan!' : skor >= 50 ? '😊 Lumayan ganteng juga!' : '😅 Masih bisa ditingkatkan!';
                await conn.sendMessage(from, {
                    text: `💎 *GANTENG METER*\n\n👤 Nama: ${msg.pushName || sender}\n📊 Skor: ${skor}/100\n${msg2}\n\n_Hasil random, jangan baper!_ 😂`
                }, { quoted: msg });
                continue;
            }

            // ────────────────────────────────────────────────
            // COUPLE CEK
            // ────────────────────────────────────────────────
            if (cmd === '.couplecek') {
                const partner = args[1];
                const skor    = Math.floor(Math.random() * 100) + 1;
                const nama1   = msg.pushName || sender;
                const nama2   = partner ? partner.replace('@', '') : 'Pasangan Rahasia';
                await conn.sendMessage(from, {
                    text: `💑 *COUPLE CHECKER*\n\n👫 ${nama1} & ${nama2}\n❤️ Cocok: ${skor}%\n\n${skor >= 80 ? '🔥 Jodoh banget kalian!' : skor >= 50 ? '😍 Lumayan cocok!' : '😬 Perlu lebih kenal lagi!'}\n\n_Sekadar fun, jangan serius!_ 😂`
                }, { quoted: msg });
                continue;
            }

            // ────────────────────────────────────────────────
            // OWNER TOOLS — hanya untuk owner
            // ────────────────────────────────────────────────
            if (!isOw && ['broadcast', '.clear', '.block', '.unblock', '.listuser', '.acc', '.tolak'].some(c => cmd === c)) {
                await conn.sendMessage(from, { text: '🚫 Perintah ini hanya untuk *Owner*.' }, { quoted: msg });
                continue;
            }

            // .acc [nomor]
            if (cmd === '.acc') {
                const target = (args[1] || '').replace(/[^0-9]/g, '');
                if (!target) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.acc [nomor]*' }, { quoted: msg });
                    continue;
                }
                const ok = addWhitelist(target);
                const targetJid = target + '@s.whatsapp.net';
                if (ok) {
                    await conn.sendMessage(from, { text: `✅ Nomor *${target}* telah disetujui & ditambahkan ke whitelist.` }, { quoted: msg });
                    await conn.sendMessage(targetJid, { text: `✅ *Akses kamu telah disetujui oleh Owner!*\nSekarang kamu bisa menggunakan semua fitur bot.\n\nKetik *.menu* untuk lihat fitur.` });
                } else {
                    await conn.sendMessage(from, { text: `⚠️ Nomor ${target} sudah ada di whitelist.` }, { quoted: msg });
                }
                continue;
            }

            // .tolak [nomor]
            if (cmd === '.tolak') {
                const target = (args[1] || '').replace(/[^0-9]/g, '');
                if (!target) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.tolak [nomor]*' }, { quoted: msg });
                    continue;
                }
                rejectPending(target);
                const targetJid = target + '@s.whatsapp.net';
                await conn.sendMessage(from, { text: `❌ Permintaan dari *${target}* telah ditolak.` }, { quoted: msg });
                await conn.sendMessage(targetJid, { text: `❌ Maaf, permintaan akses kamu *ditolak* oleh Owner.` });
                continue;
            }

            // .listuser
            if (cmd === '.listuser') {
                const users = loadUsers();
                let text = `📋 *DAFTAR WHITELIST*\n\n`;
                text += `✅ *Terdaftar (${users.whitelist.length})*:\n`;
                users.whitelist.forEach((n, i) => { text += `${i + 1}. ${n}\n`; });
                text += `\n⏳ *Pending (${users.pending.length})*:\n`;
                users.pending.forEach((n, i) => { text += `${i + 1}. ${n}\n`; });
                await conn.sendMessage(from, { text }, { quoted: msg });
                continue;
            }

            // .block [nomor atau tag]
            if (cmd === '.block') {
                const target = args[1];
                if (!target) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.block [nomor]*' }, { quoted: msg });
                    continue;
                }
                const jid = target.includes('@') ? target.replace(/[^0-9]/g, '') + '@s.whatsapp.net' : target.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                await conn.updateBlockStatus(jid, 'block');
                await conn.sendMessage(from, { text: `✅ Nomor *${target}* berhasil diblokir.` }, { quoted: msg });
                continue;
            }

            // .unblock [nomor]
            if (cmd === '.unblock') {
                const target = args[1];
                if (!target) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.unblock [nomor]*' }, { quoted: msg });
                    continue;
                }
                const jid = target.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                await conn.updateBlockStatus(jid, 'unblock');
                await conn.sendMessage(from, { text: `✅ Nomor *${target}* berhasil di-unblok.` }, { quoted: msg });
                continue;
            }

            // .broadcast [pesan]
            if (cmd === '.broadcast') {
                const pesan = args.slice(1).join(' ');
                if (!pesan) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.broadcast [pesan]*' }, { quoted: msg });
                    continue;
                }
                const users = loadUsers();
                let berhasil = 0;
                for (const num of users.whitelist) {
                    try {
                        await conn.sendMessage(num + '@s.whatsapp.net', {
                            text: `📢 *BROADCAST — BOT XSRMUL*\n\n${pesan}`
                        });
                        berhasil++;
                        await new Promise(r => setTimeout(r, 1500));
                    } catch {}
                }
                await conn.sendMessage(from, { text: `✅ Broadcast terkirim ke *${berhasil}* nomor.` }, { quoted: msg });
                continue;
            }

            // .clear — hapus session auth
            if (cmd === '.clear') {
                await conn.sendMessage(from, { text: '⚠️ Menghapus sesi & restart bot...' }, { quoted: msg });
                setTimeout(() => {
                    try {
                        fse.removeSync(path.join(__dirname, 'auth_session'));
                    } catch {}
                    process.exit(0);
                }, 2000);
                continue;
            }

            // ────────────────────────────────────────────────
            // GROUP TOOLS
            // ────────────────────────────────────────────────
            if (cmd === '.kick') {
                if (!isGroup) {
                    await conn.sendMessage(from, { text: '⚠️ Perintah ini hanya bisa digunakan di grup.' }, { quoted: msg });
                    continue;
                }
                const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (mentioned.length === 0) {
                    await conn.sendMessage(from, { text: '⚠️ Tag member yang ingin di-kick. Contoh: *.kick @nomor*' }, { quoted: msg });
                    continue;
                }
                try {
                    await conn.groupParticipantsUpdate(from, mentioned, 'remove');
                    await conn.sendMessage(from, { text: `✅ Berhasil kick ${mentioned.length} member.` }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal kick: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            if (cmd === '.add') {
                if (!isGroup) {
                    await conn.sendMessage(from, { text: '⚠️ Perintah ini hanya bisa digunakan di grup.' }, { quoted: msg });
                    continue;
                }
                const num = (args[1] || '').replace(/[^0-9]/g, '');
                if (!num) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.add [nomor]*' }, { quoted: msg });
                    continue;
                }
                try {
                    await conn.groupParticipantsUpdate(from, [num + '@s.whatsapp.net'], 'add');
                    await conn.sendMessage(from, { text: `✅ Berhasil menambahkan ${num}.` }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal add: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            if (cmd === '.group') {
                if (!isGroup) {
                    await conn.sendMessage(from, { text: '⚠️ Perintah ini hanya bisa digunakan di grup.' }, { quoted: msg });
                    continue;
                }
                const mode = args[1]?.toLowerCase();
                if (mode !== 'open' && mode !== 'close') {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.group open* atau *.group close*' }, { quoted: msg });
                    continue;
                }
                try {
                    await conn.groupSettingUpdate(from, mode === 'open' ? 'not_announcement' : 'announcement');
                    await conn.sendMessage(from, { text: `✅ Grup sekarang ${mode === 'open' ? '*terbuka* (semua bisa kirim pesan)' : '*tertutup* (hanya admin)'}` }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal ubah setting grup: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // PROMOTE & DEMOTE
            // ────────────────────────────────────────────────
            if (cmd === '.promote' || cmd === '.demote') {
                if (!isGroup) {
                    await conn.sendMessage(from, { text: '⚠️ Hanya bisa di grup.' }, { quoted: msg });
                    continue;
                }
                const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (!mentioned.length) {
                    await conn.sendMessage(from, { text: `⚠️ Tag member yang ingin di-${cmd === '.promote' ? 'promote' : 'demote'}.` }, { quoted: msg });
                    continue;
                }
                try {
                    await conn.groupParticipantsUpdate(from, mentioned, cmd === '.promote' ? 'promote' : 'demote');
                    await conn.sendMessage(from, {
                        text: `✅ Berhasil ${cmd === '.promote' ? '👑 menjadikan admin' : '🔻 mencabut admin'} ${mentioned.length} member.`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TAGALL
            // ────────────────────────────────────────────────
            if (cmd === '.tagall') {
                if (!isGroup) {
                    await conn.sendMessage(from, { text: '⚠️ Hanya bisa di grup.' }, { quoted: msg });
                    continue;
                }
                try {
                    const groupMeta = await conn.groupMetadata(from);
                    const members   = groupMeta.participants;
                    const pesan     = args.slice(1).join(' ') || '📢 Perhatian semua member!';
                    let text        = `${pesan}\n\n`;
                    const mentions  = [];
                    members.forEach(m => {
                        text += `@${m.id.replace('@s.whatsapp.net', '')} `;
                        mentions.push(m.id);
                    });
                    await conn.sendMessage(from, { text, mentions }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal tagall: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // HIDETAG
            // ────────────────────────────────────────────────
            if (cmd === '.hidetag') {
                if (!isGroup) {
                    await conn.sendMessage(from, { text: '⚠️ Hanya bisa di grup.' }, { quoted: msg });
                    continue;
                }
                try {
                    const groupMeta = await conn.groupMetadata(from);
                    const members   = groupMeta.participants;
                    const pesan     = args.slice(1).join(' ') || '📢 Pesan untuk semua member.';
                    const mentions  = members.map(m => m.id);
                    await conn.sendMessage(from, { text: pesan, mentions }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal hidetag: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // LINK GRUP
            // ────────────────────────────────────────────────
            if (cmd === '.link') {
                if (!isGroup) {
                    await conn.sendMessage(from, { text: '⚠️ Hanya bisa di grup.' }, { quoted: msg });
                    continue;
                }
                try {
                    const code = await conn.groupInviteCode(from);
                    await conn.sendMessage(from, {
                        text: `🔗 *Link Grup:*\nhttps://chat.whatsapp.com/${code}`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal ambil link: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // SET DESKRIPSI GRUP
            // ────────────────────────────────────────────────
            if (cmd === '.setdesc') {
                if (!isGroup) {
                    await conn.sendMessage(from, { text: '⚠️ Hanya bisa di grup.' }, { quoted: msg });
                    continue;
                }
                const deskripsi = args.slice(1).join(' ');
                if (!deskripsi) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.setdesc [teks deskripsi]*' }, { quoted: msg });
                    continue;
                }
                try {
                    await conn.groupUpdateDescription(from, deskripsi);
                    await conn.sendMessage(from, { text: '✅ Deskripsi grup berhasil diubah!' }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // FACEBOOK DOWNLOADER
            // ────────────────────────────────────────────────
            if (cmd === '.facebook' || cmd === '.fb') {
                const link = args[1];
                if (!link) {
                    await conn.sendMessage(from, { text: '⚠️ *LINK MASIH KOSONG!* Sediakan link yang valid setelah perintah.' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '⏳ Memproses Facebook...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(link)}`, { timeout: 20000 });
                    const data = res.data?.data;
                    const videoUrl = data?.hd || data?.sd || data?.url;
                    if (!videoUrl) throw new Error('Video tidak ditemukan');
                    const videoBuf = (await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 30000 })).data;
                    await conn.sendMessage(from, {
                        video: Buffer.from(videoBuf),
                        caption: `📥 *Facebook Video*\n${data?.title || ''}\n\nBOT XSRMUL`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal download Facebook: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TWITTER / X DOWNLOADER
            // ────────────────────────────────────────────────
            if (cmd === '.twitter' || cmd === '.twit' || cmd === '.x') {
                const link = args[1];
                if (!link) {
                    await conn.sendMessage(from, { text: '⚠️ *LINK MASIH KOSONG!* Sediakan link yang valid setelah perintah.' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '⏳ Memproses Twitter/X...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/d/twitter?url=${encodeURIComponent(link)}`, { timeout: 20000 });
                    const data = res.data?.data;
                    const videoUrl = data?.video?.[0]?.url || data?.url;
                    if (!videoUrl) throw new Error('Video tidak ditemukan');
                    const videoBuf = (await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 30000 })).data;
                    await conn.sendMessage(from, {
                        video: Buffer.from(videoBuf),
                        caption: `📥 *Twitter/X Video*\n\nBOT XSRMUL`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal download Twitter: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // SPOTIFY SEARCH
            // ────────────────────────────────────────────────
            if (cmd === '.spotify') {
                const query = args.slice(1).join(' ');
                if (!query) {
                    await conn.sendMessage(from, { text: '⚠️ *LINK MASIH KOSONG!* Sediakan judul lagu setelah perintah.' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: `🎵 Mencari di Spotify: *${query}*...` }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/s/spotify?q=${encodeURIComponent(query)}`, { timeout: 15000 });
                    const data = res.data?.data?.[0];
                    if (!data) throw new Error('Lagu tidak ditemukan');
                    let text = `🎵 *Hasil Spotify*\n\n`;
                    text += `🎤 *Judul:* ${data.name || '-'}\n`;
                    text += `👤 *Artis:* ${data.artists?.map(a => a.name).join(', ') || '-'}\n`;
                    text += `💿 *Album:* ${data.album?.name || '-'}\n`;
                    text += `⏱️ *Durasi:* ${Math.floor((data.duration_ms || 0) / 60000)}:${String(Math.floor(((data.duration_ms || 0) % 60000) / 1000)).padStart(2, '0')}\n`;
                    text += `🔗 *Link:* ${data.external_urls?.spotify || '-'}`;
                    await conn.sendMessage(from, { text }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Spotify Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // STICKER TEKS
            // ────────────────────────────────────────────────
            if (cmd === '.stickerteks') {
                const teks = args.slice(1).join(' ');
                if (!teks) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.stickerteks [teks kamu]*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '🎨 Membuat stiker teks...' }, { quoted: msg });
                try {
                    const imgUrl = `https://api.siputzx.my.id/api/tools/buat-stiker?text=${encodeURIComponent(teks)}`;
                    const res = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 15000 });
                    const stickerBuf = await toSticker(Buffer.from(res.data));
                    await conn.sendMessage(from, { sticker: stickerBuf }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal buat stiker teks: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // QRCODE
            // ────────────────────────────────────────────────
            if (cmd === '.qrcode' || cmd === '.qr') {
                const teks = args.slice(1).join(' ');
                if (!teks) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.qrcode [teks/link]*' }, { quoted: msg });
                    continue;
                }
                try {
                    const res = await axios.get(`https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(teks)}`, {
                        responseType: 'arraybuffer',
                        timeout: 10000
                    });
                    await conn.sendMessage(from, {
                        image: Buffer.from(res.data),
                        caption: `📷 *QR Code*\n_${teks}_`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal buat QR: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TRANSLATE
            // ────────────────────────────────────────────────
            if (cmd === '.translate' || cmd === '.tr') {
                const lang = args[1];
                const teks = args.slice(2).join(' ');
                if (!lang || !teks) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.translate [kode bahasa] [teks]*\nContoh: *.translate en Halo dunia*\nKode: en=Inggris, ja=Jepang, ko=Korea, ar=Arab, zh=Mandarin' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: '🌐 Menerjemahkan...' }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/tools/translate?text=${encodeURIComponent(teks)}&to=${lang}`, { timeout: 15000 });
                    const hasil = res.data?.data?.translatedText || res.data?.result || 'Gagal menerjemahkan.';
                    await conn.sendMessage(from, {
                        text: `🌐 *Terjemahan (→${lang.toUpperCase()})*\n\n📝 Asli: ${teks}\n✅ Hasil: ${hasil}`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Translate Error: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // LIRIK LAGU
            // ────────────────────────────────────────────────
            if (cmd === '.lyric' || cmd === '.lirik') {
                const query = args.slice(1).join(' ');
                if (!query) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.lyric [judul lagu]*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: `🎵 Mencari lirik: *${query}*...` }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.siputzx.my.id/api/s/lirik?q=${encodeURIComponent(query)}`, { timeout: 15000 });
                    const data = res.data?.data;
                    if (!data) throw new Error('Lirik tidak ditemukan');
                    const lirikText = typeof data === 'string' ? data : data.lyrics || data.lirik || JSON.stringify(data);
                    const judul = data.title || data.judul || query;
                    const artist = data.artist || data.artis || '';
                    let text = `🎵 *${judul}*${artist ? `\n👤 ${artist}` : ''}\n\n${lirikText}`;
                    if (text.length > 4000) text = text.substring(0, 3990) + '\n...[terpotong]';
                    await conn.sendMessage(from, { text }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Lirik tidak ditemukan: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // JADWAL SHOLAT
            // ────────────────────────────────────────────────
            if (cmd === '.sholat' || cmd === '.jadwalsholat') {
                const kota = args.slice(1).join(' ');
                if (!kota) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.sholat [nama kota]*\nContoh: *.sholat Jakarta*' }, { quoted: msg });
                    continue;
                }
                await conn.sendMessage(from, { text: `🕌 Mencari jadwal sholat ${kota}...` }, { quoted: msg });
                try {
                    const res = await axios.get(`https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(kota)}&country=ID&method=20`, { timeout: 15000 });
                    const timings = res.data?.data?.timings;
                    const date    = res.data?.data?.date?.readable;
                    if (!timings) throw new Error('Kota tidak ditemukan');
                    await conn.sendMessage(from, {
                        text: `🕌 *Jadwal Sholat — ${kota.toUpperCase()}*\n📅 ${date}\n\n` +
                              `🌅 Subuh   : ${timings.Fajr}\n` +
                              `🌞 Dhuha   : ${timings.Sunrise}\n` +
                              `☀️ Dzuhur  : ${timings.Dhuhr}\n` +
                              `🌤️ Ashar   : ${timings.Asr}\n` +
                              `🌇 Maghrib : ${timings.Maghrib}\n` +
                              `🌙 Isya    : ${timings.Isha}`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal ambil jadwal sholat: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // SHORTLINK
            // ────────────────────────────────────────────────
            if (cmd === '.shortlink' || cmd === '.short') {
                const url = args[1];
                if (!url) {
                    await conn.sendMessage(from, { text: '⚠️ *LINK MASIH KOSONG!* Format: *.shortlink [url]*' }, { quoted: msg });
                    continue;
                }
                try {
                    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, { timeout: 10000 });
                    await conn.sendMessage(from, {
                        text: `🔗 *Short Link*\n\n📎 Asli: ${url}\n✅ Pendek: ${res.data}`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal shorten link: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // KALKULATOR
            // ────────────────────────────────────────────────
            if (cmd === '.calc' || cmd === '.hitung') {
                const ekspresi = args.slice(1).join(' ');
                if (!ekspresi) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.calc [ekspresi]*\nContoh: *.calc 10 * 5 + 2*' }, { quoted: msg });
                    continue;
                }
                try {
                    const sanitized = ekspresi.replace(/[^0-9+\-*/.() %]/g, '');
                    // eslint-disable-next-line no-eval
                    const hasil = Function(`"use strict"; return (${sanitized})`)();
                    await conn.sendMessage(from, {
                        text: `🧮 *Kalkulator*\n\n📝 Ekspresi: ${ekspresi}\n✅ Hasil: *${hasil}*`
                    }, { quoted: msg });
                } catch {
                    await conn.sendMessage(from, { text: '❌ Ekspresi tidak valid. Gunakan angka dan operator (+, -, *, /)' }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // MEME RANDOM
            // ────────────────────────────────────────────────
            if (cmd === '.meme') {
                await conn.sendMessage(from, { text: '😂 Mengambil meme...' }, { quoted: msg });
                try {
                    const res = await axios.get('https://api.siputzx.my.id/api/r/meme', { timeout: 10000 });
                    const url = res.data?.data?.url || res.data?.data?.image || res.data?.url;
                    if (!url) throw new Error('Meme tidak tersedia');
                    const imgBuf = (await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 })).data;
                    await conn.sendMessage(from, { image: Buffer.from(imgBuf), caption: '😂 *Meme Random* | BOT XSRMUL' }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal ambil meme: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // FAKTA UNIK
            // ────────────────────────────────────────────────
            if (cmd === '.fakta') {
                try {
                    const res = await axios.get('https://api.siputzx.my.id/api/r/fakta-unik', { timeout: 10000 });
                    const fakta = res.data?.data?.fakta || res.data?.data || res.data?.result || 'Fakta tidak tersedia.';
                    await conn.sendMessage(from, {
                        text: `🤯 *FAKTA UNIK*\n\n💡 ${fakta}\n\n_— BOT XSRMUL_`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal ambil fakta: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TRUTH
            // ────────────────────────────────────────────────
            if (cmd === '.truth') {
                try {
                    const res = await axios.get('https://api.siputzx.my.id/api/r/truth', { timeout: 10000 });
                    const pertanyaan = res.data?.data?.truth || res.data?.data || res.data?.result || 'Tidak ada pertanyaan.';
                    await conn.sendMessage(from, {
                        text: `💬 *TRUTH*\n\n❓ ${pertanyaan}`
                    }, { quoted: msg });
                } catch (e) {
                    const fallback = [
                        'Apa hal yang paling memalukan pernah kamu lakukan?',
                        'Siapa yang paling kamu suka di grup ini?',
                        'Pernahkah kamu bohong ke orang tua?',
                        'Apa rahasia terbesar kamu?',
                        'Kapan terakhir kali kamu nangis dan kenapa?'
                    ];
                    const q = fallback[Math.floor(Math.random() * fallback.length)];
                    await conn.sendMessage(from, { text: `💬 *TRUTH*\n\n❓ ${q}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // DARE
            // ────────────────────────────────────────────────
            if (cmd === '.dare') {
                try {
                    const res = await axios.get('https://api.siputzx.my.id/api/r/dare', { timeout: 10000 });
                    const tantangan = res.data?.data?.dare || res.data?.data || res.data?.result || 'Tidak ada tantangan.';
                    await conn.sendMessage(from, {
                        text: `🔥 *DARE*\n\n🎯 ${tantangan}`
                    }, { quoted: msg });
                } catch (e) {
                    const fallback = [
                        'Kirim foto selfie sekarang juga!',
                        'Ceritakan mimpi paling aneh kamu!',
                        'Nyanyikan lagu favorit kamu minimal 10 detik!',
                        'Kirim chat ke crush kamu sekarang!',
                        'Ganti nama display kamu selama 1 jam!'
                    ];
                    const d = fallback[Math.floor(Math.random() * fallback.length)];
                    await conn.sendMessage(from, { text: `🔥 *DARE*\n\n🎯 ${d}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // TEBAK KATA
            // ────────────────────────────────────────────────
            if (cmd === '.tebakkata') {
                try {
                    const res = await axios.get('https://api.siputzx.my.id/api/g/tebak-kata', { timeout: 10000 });
                    const data = res.data?.data;
                    const soal    = data?.soal || data?.pertanyaan || data?.question;
                    const jawaban = data?.jawaban || data?.answer;
                    if (!soal) throw new Error('Soal tidak tersedia');
                    await conn.sendMessage(from, {
                        text: `🔤 *TEBAK KATA*\n\n❓ ${soal}\n\n_Jawab dengan mengetik *.jawab [jawaban]*_\n\n||Kunci: ${jawaban}||`
                    }, { quoted: msg });
                } catch (e) {
                    await conn.sendMessage(from, { text: `❌ Gagal ambil soal: ${e.message}` }, { quoted: msg });
                }
                continue;
            }

            // ────────────────────────────────────────────────
            // AUTO-REPLY MANAGEMENT — owner only
            // ────────────────────────────────────────────────

            // .setreply [keyword] | [balasan]
            if (cmd === '.setreply') {
                if (!isOw) {
                    await conn.sendMessage(from, { text: '🚫 Hanya untuk *Owner*.' }, { quoted: msg });
                    continue;
                }
                const full  = args.slice(1).join(' ');
                const parts = full.split('|');
                if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) {
                    await conn.sendMessage(from, {
                        text: '⚠️ Format: *.setreply [keyword] | [balasan]*\nContoh: *.setreply halo | Halo juga! Ketik .menu ya*'
                    }, { quoted: msg });
                    continue;
                }
                const keyword = parts[0].trim();
                const balasan = parts.slice(1).join('|').trim();
                addAutoReply(keyword, balasan);
                await conn.sendMessage(from, {
                    text: `✅ *Auto-reply disimpan!*\n\n🔑 Keyword: *${keyword}*\n💬 Balasan: ${balasan}`
                }, { quoted: msg });
                continue;
            }

            // .delreply [keyword]
            if (cmd === '.delreply') {
                if (!isOw) {
                    await conn.sendMessage(from, { text: '🚫 Hanya untuk *Owner*.' }, { quoted: msg });
                    continue;
                }
                const keyword = args.slice(1).join(' ').trim();
                if (!keyword) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.delreply [keyword]*' }, { quoted: msg });
                    continue;
                }
                const ok = delAutoReply(keyword);
                await conn.sendMessage(from, {
                    text: ok ? `🗑️ Auto-reply *${keyword}* berhasil dihapus.` : `⚠️ Keyword *${keyword}* tidak ditemukan.`
                }, { quoted: msg });
                continue;
            }

            // .listreply
            if (cmd === '.listreply') {
                if (!isOw) {
                    await conn.sendMessage(from, { text: '🚫 Hanya untuk *Owner*.' }, { quoted: msg });
                    continue;
                }
                const data = loadReplies();
                if (!data.replies.length) {
                    await conn.sendMessage(from, { text: '📋 Belum ada auto-reply yang tersimpan.' }, { quoted: msg });
                    continue;
                }
                let text = `📋 *DAFTAR AUTO-REPLY (${data.replies.length})*\n\n`;
                data.replies.forEach((r, i) => {
                    text += `*${i + 1}.* 🔑 ${r.keyword}\n   💬 ${r.balasan.substring(0, 60)}${r.balasan.length > 60 ? '...' : ''}\n\n`;
                });
                await conn.sendMessage(from, { text }, { quoted: msg });
                continue;
            }

            // ────────────────────────────────────────────────
            // SETLIMIT — owner only
            // ────────────────────────────────────────────────
            if (cmd === '.setlimit') {
                if (!isOw) {
                    await conn.sendMessage(from, { text: '🚫 Perintah ini hanya untuk *Owner*.' }, { quoted: msg });
                    continue;
                }
                const angka = parseInt(args[1]);
                if (!angka || angka < 1) {
                    await conn.sendMessage(from, { text: '⚠️ Format: *.setlimit [angka]*\nContoh: *.setlimit 20*' }, { quoted: msg });
                    continue;
                }
                config.rateLimit.maxCommands = angka;
                config.rateLimit.warnAt      = Math.max(1, angka - 2);
                rateLimitMap.clear();
                await conn.sendMessage(from, {
                    text: `✅ *Limit berhasil diubah!*\n\n📊 Limit baru: *${angka} perintah/hari*\n⚠️ Peringatan mulai di: *${config.rateLimit.warnAt} perintah*\n🔄 Semua cooldown user direset.`
                }, { quoted: msg });
                continue;
            }

        }
    });

    return conn;
}

// ============================================================
// ENTRY POINT
// ============================================================
(async () => {
    console.log('\n\x1b[1m\x1b[35m╔══════════════════════════════╗\x1b[0m');
    console.log('\x1b[1m\x1b[35m║    BOT PREMIUM XSRMUL        ║\x1b[0m');
    console.log('\x1b[1m\x1b[35m║  Starting... Please wait...  ║\x1b[0m');
    console.log('\x1b[1m\x1b[35m╚══════════════════════════════╝\x1b[0m\n');
    await connectToWhatsApp();
})();
