# BOT PREMIUM XSRMUL 🤖⚔️

Bot WhatsApp berbasis @whiskeysockets/baileys dengan koneksi Pairing Code otomatis.

---

## 📱 CARA INSTALL DI TERMUX ANDROID

### 1. Install dependensi Termux
```bash
pkg update && pkg upgrade -y
pkg install nodejs git ffmpeg -y
npm install -g pnpm
```

### 2. Clone / Extract folder bot
```bash
# Jika dari zip, extract dulu ke folder tertentu
cd ~
unzip bot-xsrmul.zip -d bot-xsrmul
cd bot-xsrmul
```

### 3. Install package Node.js
```bash
npm install
```

### 4. Jalankan bot
```bash
node index.js
```

---

## 🔑 CARA PAIRING

1. Jalankan `node index.js`
2. Tunggu **6 detik**, kode 8 digit berformat `XXXX-XXXX` akan muncul di terminal
3. Buka WhatsApp di HP **nomor bot** (`082151707351`)
4. Masuk ke **Perangkat Tertaut → Tautkan Perangkat → Tautkan dengan Nomor Telepon**
5. Masukkan kode pairing yang tampil
6. Bot akan online otomatis!

---

## ⚙️ KONFIGURASI

Edit file `settings.js`:
```js
module.exports = {
    ownerNumber: '085245530044',  // Ganti nomor Owner
    botNumber: '082151707351',    // Ganti nomor Bot
    botName: 'BOT PREMIUM XSRMUL',
    menuImage: 'https://...'      // URL gambar menu
};
```

---

## 🔐 SISTEM WHITELIST

- Owner (`085245530044`) — bypass semua batasan
- User baru harus ketik `.request` untuk minta akses
- Owner approve dengan `.acc [nomor]` atau tolak `.tolak [nomor]`
- Data tersimpan di `user.json`

---

## 📦 DEPENDENCIES

| Package | Fungsi |
|---------|--------|
| @whiskeysockets/baileys 6.7.14 | Core WhatsApp (versi stabil) |
| axios | HTTP requests ke API |
| fluent-ffmpeg | Konversi media (stiker, mp3, dll) |
| jimp 0.22.12 | Manipulasi gambar (versi dikunci agar kompatibel) |
| form-data | Upload file ke API |
| pino | Logger |
| node-cache | Cache pesan retry |
| mime-types | Deteksi tipe file |
| fs-extra | File system helpers |

> ⚠️ **Catatan:** `sharp` dihapus dari dependencies karena sulit di-compile di Termux Android (butuh native build tools). Semua pemrosesan gambar sudah ditangani `jimp` + `ffmpeg`.

---

## ❓ TROUBLESHOOTING

**ffmpeg not found di Termux:**
```bash
pkg install ffmpeg -y
```

**Error EACCES / permission:**
```bash
chmod -R 755 ~/bot-xsrmul
```

**Session corrupt:**
```bash
rm -rf auth_session
node index.js
```

**Bot disconnect terus:**
- Pastikan nomor bot tidak sedang login di HP lain
- Gunakan nomor WhatsApp yang bersih (bukan nomor utama)

---

## 📞 KONTAK

Owner: **085245530044**
