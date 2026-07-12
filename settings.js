module.exports = {
    ownerNumber: '085245530044', // Nomor Owner Xsrmulz
    botNumber: '082151707351',   // Nomor Bot
    botName: 'BOT PREMIUM XSRMUL',
    menuImage: 'https://images.unsplash.com/photo-1599740487739-a51f8a85aedb?q=80&w=600', // Gambar ksatria temporary

    // ── Rate Limiter (hanya berlaku untuk user non-owner) ──────
    rateLimit: {
        maxCommands: 10,           // Maks perintah dalam 1 jendela waktu
        windowMs: 24 * 60 * 60 * 1000, // Jendela waktu: 24 jam (reset setiap hari)
        cooldownMs: 30 * 1000,     // Cooldown setelah kena limit: 30 detik
        warnAt: 8                  // Kirim peringatan mulai perintah ke-N
    }
};
