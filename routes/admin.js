const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Resvg } = require('@resvg/resvg-js');
const { supabase } = require('../config/db');
const webpush = require('web-push');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
const supabaseAdmin = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Helper kirim push ke HP
const kirimPushNotif = async (user_id, judul, pesan) => {
  try {
    const { data } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', user_id)
      .single();
    if (!data) {
      console.log('Push notif skip: subscription tidak ditemukan untuk user_id', user_id);
      return;
    }
    await webpush.sendNotification(
      data.subscription,
      JSON.stringify({ title: judul, body: pesan })
    );
  } catch (e) {
    console.log('Push notif error:', e.message);
    console.log('Push notif statusCode:', e.statusCode);
    console.log('Push notif body:', e.body);
    console.log('Push notif endpoint:', e.endpoint);
  }
};
// ============================================================
// HELPER FORMAT RUPIAH
// ============================================================
const formatRp = (n) => Math.round(Number(n)).toLocaleString('id-ID');

// ============================================================
// FUNGSI KIRIM WHATSAPP via FONNTE
// ============================================================
const formatNomor = (nomor) => {
  let n = nomor.trim().replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  return n;
};

// ============================================================
// MODE TES WA — kalau aktif, semua WA diarahkan ke nomor tes
// ============================================================
let modeTesAktif = false;
let nomorTes = '';
 const simpanNotifikasi = async (user_id, judul, pesan, jenis = 'info', data_json = {}) => {
  try {
    await supabase.from('notifikasi').insert([{
      user_id, judul, pesan, jenis,
      sudah_dibaca: false,
      data_json
    }]);
    // ✅ Kirim push ke HP
    await kirimPushNotif(user_id, judul, pesan);
  } catch (e) {
    console.log('Simpan notifikasi error:', e.message);
  }
};
const kirimWA = async (nomor, pesan, meta = {}) => {
  if (!nomor || nomor.trim() === '') return;
  if (!process.env.FONNTE_TOKEN) {
    console.log('WA: FONNTE_TOKEN belum diisi di .env');
    return;
  }
 
  // Kalau mode tes aktif, alihkan ke nomor tes
  const nomorTujuan = (modeTesAktif && nomorTes) ? nomorTes : nomor;
  const nomorFormatted = formatNomor(nomorTujuan);
  let status = 'terkirim';
  try {
    const response = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { 'Authorization': process.env.FONNTE_TOKEN },
      body: new URLSearchParams({ target: nomorFormatted, message: pesan })
    });
    const hasil = await response.json();
    console.log('WA kirim ke', nomorFormatted, ':', JSON.stringify(hasil));
    if (!hasil.status) {
      status = 'gagal';
      console.log('WA gagal:', hasil.reason || hasil.message || '-');
    }
  } catch (e) {
    status = 'gagal';
    console.log('WA error:', e.message);
  }

  // Simpan riwayat
  try {
    await supabase.from('riwayat_wa').insert([{
      no_hp: nomorFormatted,
      nama_wali: meta.nama_wali || '',
      nama_siswa: meta.nama_siswa || '',
      pesan,
      status,
      jenis: meta.jenis || 'notifikasi'
    }]);
  } catch (e) {
    console.log('Riwayat WA error:', e.message);
  }
};

// Helper: terapkan mode tes dan format nomor (digunakan di semua pengiriman langsung)
const getNomorTujuan = (nomor) => {
  const tujuan = (modeTesAktif && nomorTes) ? nomorTes : nomor;
  return formatNomor(tujuan);
};

// ============================================================
// GENERATE KWITANSI JPG (render SVG -> JPEG pakai sharp)
// ============================================================
const escapeXml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Nomor kontak pondok — TODO: ganti dengan nomor WA/telepon aktual admin
const KONTAK_PONDOK = '081393695901';

// Logo & stempel resmi pondok — dibundel sekali saat server start (bukan dibaca ulang tiap request)
// Taruh file aslinya di backend/assets/logo.jpg dan backend/assets/stempel.png
const LOGO_FILE = path.join(__dirname, '..', 'assets', 'logo.jpg');
const STEMPEL_FILE = path.join(__dirname, '..', 'assets', 'stempel.png');
const LOGO_BASE64 = fs.existsSync(LOGO_FILE) ? fs.readFileSync(LOGO_FILE).toString('base64') : null;
const STEMPEL_BASE64 = fs.existsSync(STEMPEL_FILE) ? fs.readFileSync(STEMPEL_FILE).toString('base64') : null;

// ============================================================
// ANTI-PEMALSUAN KWITANSI: signed URL (HMAC), bukan cuma cap visual
// Cap/stempel di gambar bisa saja ditiru orang, tapi sig ini dihitung dari
// SECRET yang cuma ada di server -> kalau nominal/nama diubah di gambar hasil
// edit, hasil hitung ulang sig pas verifikasi pasti tidak akan cocok.
// ============================================================
const KWITANSI_SECRET = process.env.KWITANSI_SECRET || process.env.JWT_SECRET || 'ganti-secret-kwitansi-di-env';
const BASE_URL_VERIFIKASI = process.env.APP_URL || 'https://pesantren-backend.vercel.app';

const buatSignatureKwitansi = (noKwitansi, total, tanggal, namaSantri) => {
  return crypto.createHmac('sha256', KWITANSI_SECRET)
    .update(`${noKwitansi}|${Math.round(Number(total))}|${tanggal}|${namaSantri}`)
    .digest('hex')
    .slice(0, 10)
    .toUpperCase();
};

const buatUrlVerifikasiKwitansi = (noKwitansi, total, tanggal, namaSantri) => {
  const sig = buatSignatureKwitansi(noKwitansi, total, tanggal, namaSantri);
  const qs = new URLSearchParams({
    no: noKwitansi,
    t: String(Math.round(Number(total))),
    d: tanggal,
    s: namaSantri,
    sig
  });
  return { url: `${BASE_URL_VERIFIKASI}/api/admin/verify?${qs.toString()}`, sig };
};

// Format nomor kwitansi yang lebih rapi & mudah dibaca wali santri
// Contoh hasil: KWT/20260701/45-8231
const buatNoKwitansi = (prefix, refId) => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const acak = Math.floor(1000 + Math.random() * 9000); // 4 digit acak biar tetap unik
  return `${prefix}/${yyyy}${mm}${dd}/${refId}-${acak}`;
};

// PENTING: di server Vercel (serverless) tidak ada font sistem sama sekali,
// jadi Arial/Helvetica tidak akan pernah ketemu -> teks jadi kotak-kotak.
// Solusinya: pakai font yang kita bundel sendiri di folder /fonts, dan render
// pakai resvg-js (bisa load font dari file langsung, tidak butuh fontconfig OS).
const FONT_KWITANSI = "'Noto Sans', sans-serif";
const FONT_FILE_KWITANSI = path.join(__dirname, '..', 'fonts', 'NotoSans-Variable.ttf');

const buatKwitansiJPG = async ({ noKwitansi, namaWali, namaSantri, tanggal, items, total, metode, statusLabel, catatan }) => {
  const lebar = 800;
  const tinggiBaris = Math.max(items.length, 1) * 38;
  const yMulaiBaris = 330;
  const yGarisBawah = yMulaiBaris + tinggiBaris + 10;
  const yTotal = yGarisBawah + 40;
  const yMetode = yTotal + 32;
  const yCatatan = catatan ? yMetode + 28 : yMetode;
  // Blok tanda tangan + stempel asli
  const yTTDLabel = yCatatan + 55;
  const yGarisTTD = yTTDLabel + 95;
  const yTTDNama = yGarisTTD + 18;
  // Footer disclaimer + kontak
  const yFooterDisclaimer = yTTDNama + 40;
  const yFooterKontak = yFooterDisclaimer + 20;
  // Blok QR + kode verifikasi paling bawah
  const yQRTop = yFooterKontak + 24;
  const qrSize = 92;
  const tinggi = yQRTop + qrSize + 30;

  // Baris item dengan zebra-stripe (baris genap dikasih background halus) + garis tipis pemisah
  const barisSvg = items.map((it, i) => {
    const y = yMulaiBaris + (i * 38);
    const rectY = y - 25;
    const zebra = i % 2 === 1
      ? `<rect x="50" y="${rectY}" width="700" height="38" fill="#f4f7f6"/>`
      : '';
    const pemisah = i < items.length - 1
      ? `<line x1="60" y1="${y + 13}" x2="740" y2="${y + 13}" stroke="#eee" stroke-width="1"/>`
      : '';
    return `
      ${zebra}
      <text x="60" y="${y}" font-size="19" fill="#222">${escapeXml(it.label)}</text>
      <text x="740" y="${y}" font-size="19" fill="#222" text-anchor="end">Rp ${formatRp(it.jumlah)}</text>
      ${pemisah}`;
  }).join('');

  // Logo pondok di kop surat (kalau file belum ada di /assets, otomatis dilewati, tidak error)
  const logoSvg = LOGO_BASE64
    ? `<image x="42" y="16" width="76" height="76" href="data:image/jpeg;base64,${LOGO_BASE64}"/>`
    : '';

  // Stempel asli pondok, diletakkan menindih garis tanda tangan biar kesan resmi (bukan lagi lingkaran teks buatan)
  const stempelSvg = STEMPEL_BASE64
    ? `<image x="600" y="${yTTDLabel - 14}" width="118" height="126" href="data:image/png;base64,${STEMPEL_BASE64}" opacity="0.92" transform="rotate(-6 659 ${yTTDLabel + 49})"/>`
    : '';

  // Signature URL + QR code untuk verifikasi keaslian (lihat buatUrlVerifikasiKwitansi)
  const { url: urlVerifikasi, sig: kodeVerifikasi } = buatUrlVerifikasiKwitansi(noKwitansi, total, tanggal, namaSantri);
  let qrSvg = '';
  try {
    const qrDataUrl = await QRCode.toDataURL(urlVerifikasi, { margin: 1, width: 300, color: { dark: '#0b6e4f', light: '#ffffffff' } });
    const qrBase64 = qrDataUrl.split(',')[1];
    qrSvg = `<image x="50" y="${yQRTop}" width="${qrSize}" height="${qrSize}" href="data:image/png;base64,${qrBase64}"/>`;
  } catch (e) { console.log('Gagal generate QR kwitansi:', e.message); }

  const svg = `
  <svg width="${lebar}" height="${tinggi}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT_KWITANSI}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="0" y="0" width="100%" height="10" fill="#0b6e4f"/>
    ${logoSvg}
    <text x="400" y="58" font-size="25" font-weight="bold" text-anchor="middle" fill="#0b6e4f">PONDOK PESANTREN MUHAMMADIYAH</text>
    <text x="400" y="88" font-size="22" font-weight="bold" text-anchor="middle" fill="#0b6e4f">MAMBAUL ULUM</text>
    <text x="400" y="111" font-size="14" text-anchor="middle" fill="#666">Mojo - Andong - Boyolali</text>
    <line x1="50" y1="130" x2="750" y2="130" stroke="#0b6e4f" stroke-width="2"/>

    <text x="400" y="170" font-size="24" font-weight="bold" text-anchor="middle" fill="#111">KWITANSI PEMBAYARAN</text>
    <text x="400" y="195" font-size="13" text-anchor="middle" fill="#888">No: ${escapeXml(noKwitansi)}</text>

    <text x="60" y="240" font-size="18" fill="#333">Nama Wali</text>
    <text x="220" y="240" font-size="18" fill="#111" font-weight="bold">: ${escapeXml(namaWali)}</text>
    <text x="60" y="270" font-size="18" fill="#333">Nama Santri</text>
    <text x="220" y="270" font-size="18" fill="#111" font-weight="bold">: ${escapeXml(namaSantri)}</text>
    <text x="60" y="300" font-size="18" fill="#333">Tanggal Bayar</text>
    <text x="220" y="300" font-size="18" fill="#111" font-weight="bold">: ${escapeXml(tanggal)}</text>

    <line x1="50" y1="315" x2="750" y2="315" stroke="#ccc" stroke-width="1"/>
    ${barisSvg}
    <line x1="50" y1="${yGarisBawah}" x2="750" y2="${yGarisBawah}" stroke="#0b6e4f" stroke-width="2"/>

    <text x="60" y="${yTotal}" font-size="20" font-weight="bold" fill="#111">TOTAL DIBAYAR</text>
    <text x="740" y="${yTotal}" font-size="20" font-weight="bold" text-anchor="end" fill="#0b6e4f">Rp ${formatRp(total)}</text>
    <text x="60" y="${yMetode}" font-size="15" fill="#555">Metode: ${escapeXml(metode || '-')}&#160;&#160;&#160;Status: ${escapeXml(statusLabel || '-')}</text>
    ${catatan ? `<text x="60" y="${yCatatan}" font-size="14" fill="#777">Ket: ${escapeXml(catatan)}</text>` : ''}

    <text x="740" y="${yTTDLabel}" font-size="14" text-anchor="end" fill="#555">Mengetahui,</text>
    <text x="740" y="${yTTDLabel + 16}" font-size="14" text-anchor="end" fill="#555">Bendahara Pondok</text>
    ${stempelSvg}
    <line x1="600" y1="${yGarisTTD}" x2="740" y2="${yGarisTTD}" stroke="#333" stroke-width="1"/>
    <text x="740" y="${yTTDNama}" font-size="12" text-anchor="end" fill="#555">( Bendahara )</text>

    <text x="400" y="${yFooterDisclaimer}" font-size="13" text-anchor="middle" fill="#999">Kwitansi ini dibuat otomatis oleh sistem, sah tanpa tanda tangan basah</text>
    <text x="400" y="${yFooterKontak}" font-size="12" text-anchor="middle" fill="#999">Konfirmasi &amp; informasi: ${escapeXml(KONTAK_PONDOK)}</text>

    ${qrSvg}
    <text x="155" y="${yQRTop + 30}" font-size="12" font-weight="bold" fill="#0b6e4f">Scan untuk verifikasi keaslian</text>
    <text x="155" y="${yQRTop + 50}" font-size="11" fill="#777">Kwitansi ini asli hanya jika hasil scan</text>
    <text x="155" y="${yQRTop + 66}" font-size="11" fill="#777">cocok dengan data di sistem.</text>
    <text x="155" y="${yQRTop + 88}" font-size="12" fill="#333">Kode Verifikasi: <tspan font-weight="bold" fill="#0b6e4f">${escapeXml(kodeVerifikasi)}</tspan></text>
  </svg>`;

  // Render SVG -> PNG pakai resvg-js dengan font yang kita bundel sendiri
  // (bukan pakai font sistem, karena di Vercel tidak ada font sistem).
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FONT_FILE_KWITANSI],
      loadSystemFonts: false,
      defaultFontFamily: 'Noto Sans'
    }
  });
  const pngBuffer = resvg.render().asPng();

  // Konversi PNG -> JPG pakai sharp (tahap ini tidak butuh font sama sekali)
  return await sharp(pngBuffer).jpeg({ quality: 92 }).toBuffer();
};

// Upload buffer JPG kwitansi ke Supabase Storage (bucket: kwitansi), return public URL
const uploadKwitansiJPG = async (buffer, namaFile) => {
  try {
    const filePath = `jpg/${Date.now()}_${namaFile.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`;
    const { error } = await supabase.storage.from('kwitansi').upload(filePath, buffer, {
      contentType: 'image/jpeg',
      upsert: true
    });
    if (error) { console.log('Upload kwitansi JPG error:', error.message); return null; }
    const { data } = supabase.storage.from('kwitansi').getPublicUrl(filePath);
    return data.publicUrl;
  } catch (e) {
    console.log('Upload kwitansi JPG exception:', e.message);
    return null;
  }
};

// Kirim WA + lampiran gambar kwitansi (link JPG ikut disisipkan di teks juga)
const kirimWAKwitansi = async (nomor, pesan, imageUrl, meta = {}) => {
  if (!nomor || nomor.trim() === '') return;
  if (!process.env.FONNTE_TOKEN) { console.log('WA: FONNTE_TOKEN belum diisi di .env'); return; }

  const nomorFormatted = getNomorTujuan(nomor);
  const pesanFinal = pesan + (imageUrl ? `\n\n🧾 Kwitansi (gambar):\n${imageUrl}` : '');
  let status = 'terkirim';
  try {
    const formData = new FormData();
    formData.append('target', nomorFormatted);
    formData.append('message', pesanFinal);
    if (imageUrl) {
      formData.append('url', imageUrl);   // lampiran gambar dikirim langsung sebagai media WA
      formData.append('filename', 'kwitansi.jpg');
    }
    const response = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { 'Authorization': process.env.FONNTE_TOKEN },
      body: formData
    });
    const hasil = await response.json();
    console.log('WA kwitansi kirim ke', nomorFormatted, ':', JSON.stringify(hasil));
    if (!hasil.status) { status = 'gagal'; console.log('WA gagal:', hasil.reason || hasil.message || '-'); }
  } catch (e) {
    status = 'gagal';
    console.log('WA kwitansi error:', e.message);
  }

  try {
    await supabase.from('riwayat_wa').insert([{
      no_hp: nomorFormatted,
      nama_wali: meta.nama_wali || '',
      nama_siswa: meta.nama_siswa || '',
      pesan: pesanFinal,
      status,
      jenis: meta.jenis || 'kwitansi'
    }]);
  } catch (e) { console.log('Riwayat WA error:', e.message); }
};

// ============================================================
// MIDDLEWARE CEK TOKEN ADMIN
// ============================================================
const verifyAdmin = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token diperlukan' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ message: 'Token tidak valid' });
    if (!decoded.isAdmin) return res.status(403).json({ message: 'Bukan admin' });
    req.adminId = decoded.id;
    next();
  });
};

// ============================================================
// TEST FONNTE TOKEN
// ============================================================
router.get('/test-wa', async (req, res) => {
  const token = process.env.FONNTE_TOKEN;
  if (!token) return res.json({ status: 'error', message: 'FONNTE_TOKEN tidak ada di env' });
  try {
    const response = await fetch('https://api.fonnte.com/device', {
      method: 'POST',
      headers: { 'Authorization': token }
    });
    const text = await response.text();
    res.json({ status: 'ok', token_preview: token.substring(0, 10) + '...', fonnte_response: text });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// ============================================================
// MODE TES WA
// ============================================================
router.get('/mode-tes', verifyAdmin, (req, res) => {
  res.json({ aktif: modeTesAktif, nomor_tes: nomorTes });
});

router.post('/mode-tes', verifyAdmin, (req, res) => {
  const { aktif, nomor_tes } = req.body;
  modeTesAktif = !!aktif;
  if (nomor_tes !== undefined) nomorTes = nomor_tes;
  console.log(`Mode tes WA: ${modeTesAktif ? 'AKTIF ke ' + nomorTes : 'NONAKTIF'}`);
  res.json({ aktif: modeTesAktif, nomor_tes: nomorTes });
});

// ============================================================
// LOGIN ADMIN
// ============================================================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { data, error } = await supabase.from('admins').select('*').eq('username', username).single();
    if (error || !data) return res.status(401).json({ message: 'Username tidak ditemukan' });
    const valid = await bcrypt.compare(password, data.password);
    if (!valid) return res.status(401).json({ message: 'Password salah' });
    const token = jwt.sign({ id: data.id, isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, admin: { id: data.id, nama: data.nama } });
  } catch (err) {
    console.error('Admin login error:', err.message);
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ============================================================
// GET SEMUA SANTRI
// ============================================================
router.get('/santri', verifyAdmin, async (req, res) => {
  try {
    const { data: users, error } = await supabase.from('users').select('*').order('kelas').order('nama_siswa');
    if (error) return res.status(500).json({ message: error.message });

    const result = await Promise.all(users.map(async (u) => {
      const { data: tagihan } = await supabase.from('tagihan').select('id, jumlah, status').eq('user_id', u.id);
      const total_tagihan = tagihan ? tagihan.reduce((a, t) => a + Number(t.jumlah), 0) : 0;

      let sudah_bayar = 0;
      if (tagihan) {
        for (const t of tagihan) {
          if (t.status === 'lunas') {
            sudah_bayar += Number(t.jumlah);
          } else {
            const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
            sudah_bayar += bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
          }
        }
      }
      return { ...u, total_tagihan, sudah_bayar };
    }));

    res.json(result);
  } catch (err) {
    console.error('Get santri error:', err.message);
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ============================================================
// TAMBAH SANTRI
// ============================================================
router.post('/santri', verifyAdmin, async (req, res) => {
  try {
    const { username, password, nama, nama_siswa, kelas, no_hp } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from('users').insert([{ username, password: hash, password_plain: password, nama, nama_siswa, kelas, no_hp: no_hp || '' }]).select('id').single();
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Santri berhasil ditambahkan', id: data.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// EDIT SANTRI
// ============================================================
router.put('/santri/:id', verifyAdmin, async (req, res) => {
  try {
    const { nama, nama_siswa, kelas, password, no_hp, username } = req.body;
    const updateData = { nama, nama_siswa, kelas, no_hp: no_hp || '', username };
    if (password) {
      updateData.password = await bcrypt.hash(password, 10);
      updateData.password_plain = password;
    }
    const { error } = await supabase.from('users').update(updateData).eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Data santri berhasil diupdate' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// ============================================================
// KIRIM INFO AKUN KE WALI VIA WA
// ============================================================
router.post('/santri/kirim-akun', verifyAdmin, async (req, res) => {
  try {
    const { user_id } = req.body;
    const { data: u } = await supabase.from('users').select('*').eq('id', user_id).single();
    if (!u) return res.status(404).json({ message: 'Santri tidak ditemukan' });
    if (!u.no_hp) return res.status(400).json({ message: 'Nomor WA wali belum diisi' });

    const pesan =
      `🔐 *Info Akun Aplikasi Keuangan Santri*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
      `Semoga Bapak/Ibu dalam keadaan sehat dan baik. 🤲\n\n` +
      `Kami informasikan bahwa kini tersedia *Aplikasi Keuangan Santri* yang dapat digunakan untuk memantau tagihan dan riwayat pembayaran putra/putri Bapak/Ibu kapan saja dan di mana saja.\n\n` +
      `📱 *Cara Menggunakan:*\n` +
      `1️⃣ Buka link berikut di browser HP:\n` +
      `👉 https://pesantren-frontend.vercel.app\n` +
      `2️⃣ Login menggunakan akun di bawah ini\n` +
      `3️⃣ Klik tombol *"Install Aplikasi"* yang tersedia\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🔑 *Data Akun:*\n` +
      `👤 Nama Santri : *${u.nama_siswa}*\n` +
      `📋 Username    : *${u.username}*\n` +
      `🔒 Password    : *${u.password_plain || '-'}*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `✨ *Fitur Aplikasi:*\n` +
      `✅ Lihat tagihan & status pembayaran\n` +
      `✅ Riwayat pembayaran lengkap\n` +
      `✅ Notifikasi langsung via WhatsApp\n\n` +
      `Jazakumullah Khoiron atas kepercayaan Bapak/Ibu 🙏\n\n` +
      `_PP. Muhammadiyah Mambaul Ulum_\n` +
      `_Mojo - Andong - Boyolali_`;

    await kirimWA(u.no_hp, pesan, { jenis: 'info_akun', nama_wali: u.nama, nama_siswa: u.nama_siswa });
    res.json({ message: 'Info akun berhasil dikirim ke WA wali' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// ============================================================
// HAPUS SANTRI
// ============================================================
router.delete('/santri/:id', verifyAdmin, async (req, res) => {
  try {
    const { data: tagihan } = await supabase.from('tagihan').select('id').eq('user_id', req.params.id);
    if (tagihan && tagihan.length > 0) {
      const ids = tagihan.map(t => t.id);
      await supabase.from('pembayaran').delete().in('tagihan_id', ids);
      await supabase.from('tagihan').delete().eq('user_id', req.params.id);
    }
    await supabase.from('users').delete().eq('id', req.params.id);
    res.json({ message: 'Santri berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET TAGIHAN PER SANTRI
// ============================================================
router.get('/tagihan/:userId', verifyAdmin, async (req, res) => {
  try {
    const { data: tagihan, error } = await supabase.from('tagihan').select('*').eq('user_id', req.params.userId).order('id');
    if (error) return res.status(500).json({ message: error.message });

    const result = await Promise.all(tagihan.map(async (t) => {
      const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
      const sudah_dicicil = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
      return { ...t, sudah_dicicil };
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ============================================================
// TAMBAH TAGIHAN + NOTIFIKASI WA
// ============================================================
router.post('/tagihan', verifyAdmin, async (req, res) => {
  try {
    const { user_id, jenis, jumlah, tanggal_bayar, status, semester, kirim_notif } = req.body;
    const { data, error } = await supabase.from('tagihan').insert([{
      user_id, jenis, jumlah: Math.round(Number(jumlah)),
      tanggal_bayar: tanggal_bayar || null, status: status || 'belum', semester: semester || null
    }]).select('id').single();
    if (error) return res.status(500).json({ message: error.message });
    
// Simpan notifikasi in-app
    await simpanNotifikasi(
      user_id,
      '📋 Tagihan Baru',
      `Tagihan ${jenis} sebesar Rp ${formatRp(jumlah)} telah ditambahkan.`,
      'tagihan',
      { jenis, jumlah, tanggal_bayar }
    );
    res.json({ message: 'Tagihan berhasil ditambahkan', id: data.id });
    if ((status || 'belum') === 'belum' && kirim_notif !== false) {
      try {
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', user_id).single();
        if (u && u.no_hp) {
          await kirimWA(u.no_hp,
            `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
            `📋 *Informasi Tagihan Baru*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 Santri           : *${u.nama_siswa}*\n` +
             `📚 Tagihan         : *${jenis}*\n` +
            `💰 Jumlah           : *Rp ${formatRp(jumlah)}*\n` +
            `⏳ Status           : Belum Dibayar\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Mohon segera lakukan pembayaran ke bagian administrasi pondok atau transfer:\n\n` +
            `🏦 *Bank BRI*\n` +
            `📋 No. Rek : *6665 0101 4641 533*\n` +
            `👤 A.N     : *ALFIAN AJI WIBOWO*\n\n` +
            `📱 Konfirmasi Pembayarasn:\n` +
            `☎️ Hubungi : *081393695901*\n\n` +
            `Terima kasih 🙏\n\n` +
            `_PP. Muhammadiyah Mambaul Ulum_\n` +
            `_Mojo - Andong - Boyolali_`,
            { jenis: 'tagihan', nama_wali: u.nama, nama_siswa: u.nama_siswa }
          );
        }
      } catch (e) { console.log('WA notif error:', e.message); }
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// EDIT TAGIHAN + NOTIFIKASI WA jika ditandai lunas
// ============================================================
router.put('/tagihan/:id', verifyAdmin, async (req, res) => {
  try {
    const { jenis, jumlah, tanggal_bayar, status, semester, kirim_notif } = req.body;

    const { data: old } = await supabase.from('tagihan').select('status, user_id').eq('id', req.params.id).single();
    if (!old) return res.status(404).json({ message: 'Tagihan tidak ditemukan' });
    const { status: statusLama, user_id } = old;

    // Kirim WA sebelum res.json
    if (statusLama === 'belum' && status === 'lunas' && user_id && kirim_notif !== false) {
      try {
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', user_id).single();
        if (u && u.no_hp) {
          const totalKekurangan = await getTotalKekurangan(u.id);
          await kirimWA(u.no_hp,
            `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
            `✅ *Konfirmasi Pembayaran Lunas*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Santri  : *${u.nama_siswa}*\n` +
            `Tagihan : *${jenis}*\n` +
            `Jumlah  : *Rp ${formatRp(jumlah)}*\n` +
            `Tanggal : ${tanggal_bayar || '-'}\n` +
            `Status  : ✅ *LUNAS*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            (totalKekurangan > 0
              ? `⚠️ *Masih ada kekurangan tagihan lain:*\n` +
                `💰 Total Kekurangan : *Rp ${formatRp(totalKekurangan)}*\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `Mohon segera lunasi ke bagian administrasi atau transfer:\n\n` +
                `🏦 *Bank BRI*\n` +
                `📋 No. Rek : *6665 0101 4641 533*\n` +
                `👤 A.N     : *ALFIAN AJI WIBOWO*\n\n` +
                `📱 Konfirmasi Pembayaran:\n` +
                `☎️ Hubungi : *081393695901*\n\n`
              : `🎉 *Alhamdulillah, semua tagihan sudah lunas!*\n\n`) +
            `Terima kasih atas pembayarannya 🙏\n` +
            `_Jazakumullah Khoiron, Semoga Allah memudahkan dan melapangkan rizqi Bapak/Ibu_ Aamiin🤲\n\n` +
            `_PP. Muhammadiyah Mambaul Ulum_\n` +
            `_Mojo - Andong - Boyolali_`,
            { jenis: 'bayaran', nama_wali: u.nama, nama_siswa: u.nama_siswa }
          );
        }
      } catch (e) { console.log('WA notif error:', e.message); }
    }

    const { error } = await supabase.from('tagihan').update({
      jenis, jumlah, tanggal_bayar: tanggal_bayar || null, status, semester: semester || null
    }).eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
// Simpan notifikasi in-app
    await simpanNotifikasi(
      user_id,
      '✏️ Data Tagihan Dikoreksi',
      `Data tagihan ${jenis} telah diperbarui oleh admin. Jumlah: Rp ${formatRp(jumlah)}.`,
      'koreksi',
      { jenis, jumlah, tanggal_bayar, status }
    );
    res.json({ message: 'Tagihan berhasil diupdate' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// HAPUS TAGIHAN
// ============================================================
router.delete('/tagihan/:id', verifyAdmin, async (req, res) => {
  try {
    await supabase.from('pembayaran').delete().eq('tagihan_id', req.params.id);
    await supabase.from('tagihan').delete().eq('id', req.params.id);
    res.json({ message: 'Tagihan berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// HELPER: hitung total kekurangan semua tagihan santri
// ============================================================
const getTotalKekurangan = async (uid) => {
  const { data: tagihan } = await supabase.from('tagihan').select('id, jumlah, status').eq('user_id', uid);
  if (!tagihan) return 0;
  let total = 0;
  for (const t of tagihan) {
    if (t.status === 'lunas') continue;
    const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
    const sudah = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
    total += Math.max(0, Math.round(Number(t.jumlah) - sudah));
  }
  return total;
};

// ============================================================
// HELPER: urutan bulan tahun ajaran pondok (mulai Juli s/d Juni).
// Ganti urutan array ini kalau tahun ajaran pondok mulai bulan lain.
// ============================================================
const URUTAN_BULAN = [
  'juli', 'agustus', 'september', 'oktober', 'november', 'desember',
  'januari', 'februari', 'maret', 'april', 'mei', 'juni'
];

// Cari nama bulan di dalam teks jenis tagihan (mis. "Syahriyah September" -> 2)
// Balikin null kalau jenis tagihan tidak mengandung nama bulan (mis. tagihan semester/barang).
const getIndeksBulan = (jenisText) => {
  const teks = String(jenisText || '').toLowerCase();
  const idx = URUTAN_BULAN.findIndex((bulan) => teks.includes(bulan));
  return idx === -1 ? null : idx;
};

// ============================================================
// HELPER: rekap lengkap tagihan santri — total tagihan keseluruhan,
// total kekurangan, dan daftar tagihan yang masih belum lunas
// (diurutkan berdasarkan urutan bulan tahun ajaran; tagihan non-bulanan
// seperti Kesantrian/Buku Pondok ditaruh di akhir, urut nominal terbesar)
// untuk dipakai di kwitansi WA.
// ============================================================
const getRekapTagihanSantri = async (uid) => {
  const { data: tagihanList } = await supabase.from('tagihan').select('id, jenis, jumlah, status').eq('user_id', uid);
  if (!tagihanList) return { totalTagihan: 0, totalKekurangan: 0, belumLunas: [] };
  let totalTagihan = 0;
  let totalKekurangan = 0;
  const belumLunas = [];
  for (const t of tagihanList) {
    totalTagihan += Number(t.jumlah);
    if (t.status === 'lunas') continue;
    const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
    const sudah = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
    const sisa = Math.max(0, Math.round(Number(t.jumlah) - sudah));
    if (sisa > 0) {
      totalKekurangan += sisa;
      belumLunas.push({ jenis: t.jenis, sisa });
    }
  }
  // Urut berdasarkan bulan tahun ajaran (Syahriyah Juli, Agustus, ...).
  // Tagihan yang tidak punya nama bulan (Kesantrian, Buku Pondok, dll)
  // ditaruh di akhir daftar, sesama non-bulanan diurutkan dari nominal terbesar.
  belumLunas.sort((a, b) => {
    const bulanA = getIndeksBulan(a.jenis);
    const bulanB = getIndeksBulan(b.jenis);
    if (bulanA !== null && bulanB !== null) return bulanA - bulanB;
    if (bulanA !== null) return -1; // a bulanan, b bukan -> a duluan
    if (bulanB !== null) return 1;  // b bulanan, a bukan -> b duluan
    return b.sisa - a.sisa; // sama-sama non-bulanan -> urut nominal terbesar
  });
  return { totalTagihan, totalKekurangan, belumLunas };
};

// Info rekening pondok untuk arahan transfer — satu tempat saja biar gampang diganti
const REKENING_PONDOK = {
  bank: 'Bank BRI',
  no_rek: '6665 0101 4641 533',
  atas_nama: 'ALFIAN AJI WIBOWO',
  kontak: '081393695901'
};

// ============================================================
// HELPER: susun SATU pesan kwitansi WA yang lengkap — dipakai di semua
// jalur pembayaran (tunggal, bulk, campuran, fleksibel) supaya wali
// selalu terima 1 pesan saja per transaksi, isinya lengkap:
// rincian pembayaran kali ini, total tagihan keseluruhan, daftar
// tagihan yang belum lunas (urut nominal terbesar), ucapan terima
// kasih + doa, dan arahan transfer kalau masih ada kekurangan.
// ============================================================
const buatPesanKwitansiLengkap = ({ u, tanggal_bayar, metode_bayar, rincianItems, jumlahTotal, rekap, keterangan, kelebihan }) => {
  const daftarBelumLunasText = rekap.belumLunas
    .map((t, i) => `${i + 1}. ${t.jenis} : Rp ${formatRp(t.sisa)}`)
    .join('\n');

  return (
    `🧾 *KWITANSI PEMBAYARAN*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
    `Berikut kwitansi pembayaran santri:\n\n` +
    `👤 Nama Santri    : *${u.nama_siswa}*\n` +
    `📅 Tanggal Bayar  : ${tanggal_bayar}\n` +
    `💳 Metode         : *${metode_bayar === 'transfer' ? 'Transfer Bank' : 'Tunai'}*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📋 *Rincian Pembayaran Hari Ini:*\n${rincianItems.join('\n')}\n` +
    `💵 *Total Dibayar : Rp ${formatRp(jumlahTotal)}*\n` +
    (kelebihan > 0 ? `🎉 Kelebihan/Uang Jajan : *Rp ${formatRp(kelebihan)}*\n` : '') +
    (keterangan ? `📝 Ket: ${keterangan}\n` : '') +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📊 *Total Tagihan Keseluruhan* : Rp ${formatRp(rekap.totalTagihan)}\n` +
    (rekap.totalKekurangan > 0
      ? `⚠️ *Sisa Tagihan Belum Dibayar* : Rp ${formatRp(rekap.totalKekurangan)}\n\n` +
        `📌 *Rincian tagihan yang belum lunas* (urut dari bulan terlama):\n${daftarBelumLunasText}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Mohon kesediaan Bapak/Ibu untuk melunasi sisa tagihan di atas, bisa langsung ke bagian administrasi pondok atau transfer ke:\n\n` +
        `🏦 *${REKENING_PONDOK.bank}*\n` +
        `📋 No. Rek : *${REKENING_PONDOK.no_rek}*\n` +
        `👤 A.N     : *${REKENING_PONDOK.atas_nama}*\n\n` +
        `📱 Setelah transfer, mohon konfirmasi ke:\n` +
        `☎️ *${REKENING_PONDOK.kontak}*\n\n`
      : `🎉 *Alhamdulillah, seluruh tagihan ${u.nama_siswa} sudah LUNAS!*\n\n`) +
    `Terima kasih atas pembayarannya 🙏\n` +
    `_Jazakumullah Khoiron, semoga Allah mudahkan segala urusan_\n` +
    `_dan melapangkan rizqi Bapak/Ibu sekeluarga_ Aamiin 🤲\n\n` +
    `_PP. Muhammadiyah Mambaul Ulum_\n` +
    `_Mojo - Andong - Boyolali_`
  );
};

// ============================================================
// INPUT PEMBAYARAN / CICILAN + NOTIFIKASI WA
// ============================================================
router.post('/pembayaran', verifyAdmin, async (req, res) => {
  try {
    const { tagihan_id, jumlah_bayar, tanggal_bayar, keterangan, kirim_notif } = req.body;

    await supabase.from('pembayaran').insert([{ tagihan_id, jumlah_bayar, tanggal_bayar, keterangan: keterangan || '' }]);

    const { data: t } = await supabase.from('tagihan').select('jumlah, jenis, user_id').eq('id', tagihan_id).single();
    const { data: bayarList } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', tagihan_id);
    const total_bayar = bayarList ? bayarList.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
    const sisa = Math.round(Number(t.jumlah) - total_bayar);

    if (total_bayar >= Number(t.jumlah)) {
      await supabase.from('tagihan').update({ status: 'lunas', tanggal_bayar }).eq('id', tagihan_id);
      try {
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', t.user_id).single();
        if (u && u.no_hp && kirim_notif !== false) {
          let imageUrl = null;
          try {
            const jpgBuffer = await buatKwitansiJPG({
              noKwitansi: buatNoKwitansi('KWT', tagihan_id),
              namaWali: u.nama,
              namaSantri: u.nama_siswa,
              tanggal: tanggal_bayar,
              items: [{ label: t.jenis, jumlah: jumlah_bayar }],
              total: jumlah_bayar,
              metode: '-',
              statusLabel: 'LUNAS'
            });
            imageUrl = await uploadKwitansiJPG(jpgBuffer, `kwitansi_${u.nama_siswa}`);
          } catch (e) { console.log('Gagal generate JPG kwitansi:', e.message); }

          const rekap = await getRekapTagihanSantri(t.user_id);
          const pesan = buatPesanKwitansiLengkap({
            u, tanggal_bayar, metode_bayar: 'tunai',
            rincianItems: [`• ${t.jenis} : *Rp ${formatRp(jumlah_bayar)}* ✅ Lunas`],
            jumlahTotal: jumlah_bayar, rekap, keterangan
          });
          await kirimWAKwitansi(u.no_hp, pesan, imageUrl, { jenis: 'kwitansi', nama_wali: u.nama, nama_siswa: u.nama_siswa });
        }
      } catch (e) { console.log('WA error:', e.message); }
// Simpan notifikasi in-app
    await simpanNotifikasi(
      t.user_id,
      '✅ Pembayaran Berhasil',
      `Pembayaran ${t.jenis} sebesar Rp ${formatRp(jumlah_bayar)} telah diterima. Status: Lunas 🎉`,
      'bayar',
      { jenis: t.jenis, jumlah: t.jumlah, jumlah_bayar, sisa: 0, tanggal_bayar }
    );
      res.json({ message: 'Pembayaran berhasil, tagihan LUNAS!', lunas: true });

    } else {
      try {
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', t.user_id).single();
        if (u && u.no_hp && kirim_notif !== false) {
          const rekap = await getRekapTagihanSantri(t.user_id);
          const pesan = buatPesanKwitansiLengkap({
            u, tanggal_bayar, metode_bayar: 'tunai',
            rincianItems: [`• ${t.jenis.trim()} : *Rp ${formatRp(jumlah_bayar)}* (Cicilan, sisa tagihan ini Rp ${formatRp(sisa)})`],
            jumlahTotal: jumlah_bayar, rekap, keterangan
          });
          await kirimWAKwitansi(u.no_hp, pesan, null, { jenis: 'cicilan', nama_wali: u.nama, nama_siswa: u.nama_siswa });
        }
      } catch (e) { console.log('WA error:', e.message); }
// Simpan notifikasi in-app
    await simpanNotifikasi(
      t.user_id,
      '✅ Pembayaran Berhasil',
      `Pembayaran ${t.jenis} sebesar Rp ${formatRp(jumlah_bayar)} telah diterima. Sisa: Rp ${formatRp(sisa)}`,
      'bayar',
      { jenis: t.jenis, jumlah: t.jumlah, jumlah_bayar, sisa, tanggal_bayar }
    );
      res.json({ message: `Pembayaran dicatat. Sisa: Rp ${sisa.toLocaleString('id-ID')}`, lunas: false, sisa });
    }
  } catch (err) {
    console.error('Pembayaran error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// PEMBAYARAN BULK (beberapa tagihan sekaligus)
// ============================================================
router.post('/pembayaran-bulk', verifyAdmin, async (req, res) => {
  try {
    const { user_id, tagihan_ids, jumlah_total, tanggal_bayar, keterangan, metode_bayar, kirim_notif } = req.body;
    if (!tagihan_ids || tagihan_ids.length === 0) return res.status(400).json({ message: 'Pilih minimal 1 tagihan' });

    const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', user_id).single();
    if (!u) return res.status(404).json({ message: 'Santri tidak ditemukan' });

    // Ambil semua tagihan yang dipilih
    const { data: tagihanList } = await supabase.from('tagihan').select('*, pembayaran(jumlah_bayar)').in('id', tagihan_ids);

    // Hitung sisa masing-masing tagihan
    let tagihan = tagihanList.map(t => {
      const sudah = (t.pembayaran || []).reduce((a, p) => a + Number(p.jumlah_bayar), 0);
      const sisa = Math.round(Number(t.jumlah) - sudah);
      return { ...t, sudah, sisa };
    });

    // Bagi pembayaran ke tagihan satu per satu
    let sisaUang = Math.round(Number(jumlah_total));
    let lunasList = [];
    let cicilanItem = null;

    for (const t of tagihan) {
      if (sisaUang <= 0) break;
      if (sisaUang >= t.sisa) {
        // Lunas
        sisaUang -= t.sisa;
        await supabase.from('pembayaran').insert([{ tagihan_id: t.id, jumlah_bayar: t.sisa, tanggal_bayar, keterangan: keterangan || '' }]);
        await supabase.from('tagihan').update({ status: 'lunas', tanggal_bayar }).eq('id', t.id);
        lunasList.push({ jenis: t.jenis, jumlah: t.jumlah, dibayar: t.sisa, sudah: t.sudah });
      } else {
        // Cicilan
        await supabase.from('pembayaran').insert([{ tagihan_id: t.id, jumlah_bayar: sisaUang, tanggal_bayar, keterangan: keterangan || '' }]);
        cicilanItem = { jenis: t.jenis, jumlah: t.jumlah, dibayar: sisaUang, sisa: t.sisa - sisaUang, sudah: t.sudah + sisaUang };
        sisaUang = 0;
      }
    }

    const kelebihan = sisaUang; // sisa uang setelah semua tagihan terbayar
    const totalKekurangan = await getTotalKekurangan(user_id);
// Simpan notifikasi in-app
const rincianNotif = lunasList.map(t => `${t.jenis}: Rp ${formatRp(t.dibayar)}`).join(', ');
if (lunasList.length > 0 && cicilanItem) {
  // Ada yang lunas + ada cicilan
  await simpanNotifikasi(
    user_id,
    '✅ Pembayaran Berhasil',
    `Pembayaran Rp ${formatRp(jumlah_total)} diterima. Lunas: ${rincianNotif}. Cicilan ${cicilanItem.jenis}: Rp ${formatRp(cicilanItem.dibayar)}, sisa Rp ${formatRp(cicilanItem.sisa)}.`,
    'bayar',
    { lunasList, cicilanItem, jumlah_total, tanggal_bayar }
  );
} else if (lunasList.length > 0) {
  // Semua lunas
  await simpanNotifikasi(
    user_id,
    '✅ Pembayaran Berhasil',
    `Pembayaran Rp ${formatRp(jumlah_total)} diterima. ${rincianNotif} — Lunas 🎉`,
    'bayar',
    { lunasList, jumlah_total, tanggal_bayar }
  );
} else if (cicilanItem) {
  // Hanya cicilan
  await simpanNotifikasi(
    user_id,
    '✅ Pembayaran Berhasil',
    `Cicilan ${cicilanItem.jenis} sebesar Rp ${formatRp(cicilanItem.dibayar)} diterima. Sisa: Rp ${formatRp(cicilanItem.sisa)}.`,
    'bayar',
    { cicilanItem, jumlah_total, tanggal_bayar }
  );
}
    // Kirim response dulu sebelum kirim WA
    res.json({ message: 'Pembayaran bulk berhasil', lunas: lunasList.length, cicilan: cicilanItem, kelebihan });

    // Kirim WA secara async (tidak blocking)
    if (kirim_notif !== false && u.no_hp && lunasList.length > 0) {
      const rincianLunas = lunasList.map(t => `• ${t.jenis}: *Rp ${formatRp(t.dibayar)}* ✅`).join('\n');

      let imageUrl = null;
      try {
        const itemsJPG = lunasList.map(t => ({ label: t.jenis, jumlah: t.dibayar }));
        if (cicilanItem) itemsJPG.push({ label: `${cicilanItem.jenis} (cicilan)`, jumlah: cicilanItem.dibayar });
        const jpgBuffer = await buatKwitansiJPG({
          noKwitansi: buatNoKwitansi('BLK', user_id),
          namaWali: u.nama,
          namaSantri: u.nama_siswa,
          tanggal: tanggal_bayar,
          items: itemsJPG,
          total: jumlah_total,
          metode: metode_bayar === 'transfer' ? 'Transfer Bank' : 'Tunai',
          statusLabel: cicilanItem ? 'SEBAGIAN LUNAS' : 'LUNAS',
          catatan: kelebihan > 0 ? `Sisa uang: Rp ${formatRp(kelebihan)}` : (keterangan || '')
        });
        imageUrl = await uploadKwitansiJPG(jpgBuffer, `kwitansi_${u.nama_siswa}`);
      } catch (e) { console.log('Gagal generate JPG kwitansi bulk:', e.message); }

      await kirimWAKwitansi(u.no_hp,
        `🧾 *KWITANSI PEMBAYARAN*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
        `Berikut kwitansi pembayaran santri:\n\n` +
        `👤 Nama Santri    : *${u.nama_siswa}*\n` +
        `📅 Tanggal Bayar  : ${tanggal_bayar}\n` +
        `💵 Total Dibayar  : *Rp ${formatRp(jumlah_total)}*\n` +
        `💳 Metode         : *${metode_bayar === 'transfer' ? 'Transfer Bank' : 'Tunai'}*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 *Rincian Pembayaran:*\n${rincianLunas}\n` +
        (cicilanItem ? `• ${cicilanItem.jenis}: *Rp ${formatRp(cicilanItem.dibayar)}* (cicilan)\n` : '') +
        (kelebihan > 0 ? `\n🎉 Sisa Uang : *Rp ${formatRp(kelebihan)}*\n📝 Ket       : ${keterangan || '-'}\n` : '') +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Terima kasih atas pembayarannya 🙏\n` +
        `_Jazakumullah Khoiron, Semoga Allah memudahkan_\n` +
        `_dan melapangkan rizqi Bapak/Ibu_ Aamiin🤲\n\n` +
        `_PP. Muhammadiyah Mambaul Ulum_\n` +
        `_Mojo - Andong - Boyolali_`,
        imageUrl,
        { jenis: 'kwitansi', nama_wali: u.nama, nama_siswa: u.nama_siswa }
      );
    }

    // Kirim WA Konfirmasi
    if (kirim_notif !== false && u.no_hp) {
      const rincianKonfirmasi = lunasList.map(t => `• ${t.jenis}: *Rp ${formatRp(t.dibayar)}* ✅`).join('\n') +
        (cicilanItem ? `\n• ${cicilanItem.jenis}: *Rp ${formatRp(cicilanItem.dibayar)}* (cicilan)` : '');
      await kirimWA(u.no_hp,
        `✅ *Konfirmasi Pembayaran*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
        `Santri       : *${u.nama_siswa}*\n` +
        `Total Bayar  : *Rp ${formatRp(jumlah_total)}*\n` +
        `Tanggal      : ${tanggal_bayar}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 *Rincian Pembayaran:*\n${rincianKonfirmasi}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        (cicilanItem
          ? `⚠️ *${cicilanItem.jenis}* masih sisa: *Rp ${formatRp(cicilanItem.sisa)}*\n━━━━━━━━━━━━━━━━━━\n`
          : '') +
        (totalKekurangan > 0
          ? `⚠️ *Total kekurangan semua tagihan:*\n💰 *Rp ${formatRp(totalKekurangan)}*\n━━━━━━━━━━━━━━━━━━\n` +
            `Mohon segera lunasi ke bagian administrasi atau transfer:\n\n` +
            `🏦 *Bank BRI*\n` +
            `📋 No. Rek : *6665 0101 4641 533*\n` +
            `👤 A.N     : *ALFIAN AJI WIBOWO*\n\n` +
            `📱 Konfirmasi Pembayaran:\n` +
            `☎️ Hubungi : *081393695901*\n\n`
          : `🎉 *Alhamdulillah, semua tagihan sudah lunas!*\n\n`) +
        `Terima kasih atas pembayarannya 🙏\n` +
        `_Jazakumullah Khoiron, Semoga Allah memudahkan_\n` +
        `_dan melapangkan rizqi Bapak/Ibu_ Aamiin🤲\n\n` +
        `_PP. Muhammadiyah Mambaul Ulum_\n` +
        `_Mojo - Andong - Boyolali_`,
        { jenis: 'bayaran', nama_wali: u.nama, nama_siswa: u.nama_siswa }
      );
    }

    } catch (err) {
    console.error('Pembayaran bulk error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// PEMBAYARAN CAMPURAN (beberapa tagihan sekaligus + item non-tagihan
// dalam satu setoran, satu WA kwitansi gabungan)
// ============================================================
router.post('/pembayaran-campuran', verifyAdmin, async (req, res) => {
  try {
    const {
      user_id, tagihan_ids = [], item_lain, jumlah_total,
      tanggal_bayar, keterangan, metode_bayar, kirim_notif
    } = req.body;

    if (!user_id) return res.status(400).json({ message: 'Santri wajib dipilih' });
    if (!jumlah_total || Number(jumlah_total) <= 0) return res.status(400).json({ message: 'Jumlah total wajib diisi' });

    const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', user_id).single();
    if (!u) return res.status(404).json({ message: 'Santri tidak ditemukan' });

    const jumlahTotal = Math.round(Number(jumlah_total));
    const jumlahLain = (item_lain && item_lain.jumlah) ? Math.round(Number(item_lain.jumlah)) : 0;
    if (jumlahLain > jumlahTotal) {
      return res.status(400).json({ message: 'Jumlah item non-tagihan tidak boleh melebihi total bayar' });
    }
    const jumlahUntukTagihan = jumlahTotal - jumlahLain;

    // Ambil & hitung sisa tiap tagihan yang dipilih (logika sama seperti pembayaran-bulk)
    let tagihan = [];
    if (tagihan_ids.length > 0) {
      const { data: tagihanList } = await supabase.from('tagihan').select('*, pembayaran(jumlah_bayar)').in('id', tagihan_ids);
      tagihan = (tagihanList || []).map(t => {
        const sudah = (t.pembayaran || []).reduce((a, p) => a + Number(p.jumlah_bayar), 0);
        const sisa = Math.round(Number(t.jumlah) - sudah);
        return { ...t, sudah, sisa };
      });
    }

    let sisaUang = jumlahUntukTagihan;
    let lunasList = [];
    let cicilanItem = null;

    for (const t of tagihan) {
      if (sisaUang <= 0) break;
      if (sisaUang >= t.sisa) {
        sisaUang -= t.sisa;
        await supabase.from('pembayaran').insert([{ tagihan_id: t.id, jumlah_bayar: t.sisa, tanggal_bayar, keterangan: keterangan || '' }]);
        await supabase.from('tagihan').update({ status: 'lunas', tanggal_bayar }).eq('id', t.id);
        lunasList.push({ jenis: t.jenis, jumlah: t.jumlah, dibayar: t.sisa, sudah: t.sudah });
      } else {
        await supabase.from('pembayaran').insert([{ tagihan_id: t.id, jumlah_bayar: sisaUang, tanggal_bayar, keterangan: keterangan || '' }]);
        cicilanItem = { jenis: t.jenis, jumlah: t.jumlah, dibayar: sisaUang, sisa: t.sisa - sisaUang, sudah: t.sudah + sisaUang };
        sisaUang = 0;
      }
    }

    // Simpan item non-tagihan (kalau ada)
    let itemLainSimpan = null;
    if (jumlahLain > 0) {
      itemLainSimpan = { keperluan: (item_lain && item_lain.keperluan) || 'Pembayaran lain', jumlah: jumlahLain };
      await supabase.from('pembayaran_umum').insert([{
        nama_pembayar: u.nama || u.nama_siswa,
        keperluan: itemLainSimpan.keperluan,
        jumlah: jumlahLain,
        tanggal: tanggal_bayar,
        keterangan: keterangan || '',
        kategori: 'umum',
        no_hp: u.no_hp || ''
      }]);
    }

    const kelebihan = sisaUang; // uang tersisa setelah semua tagihan + item lain terbayar
    const totalKekurangan = await getTotalKekurangan(user_id);

    // Notifikasi in-app gabungan
    const rincianList = [
      ...lunasList.map(t => `${t.jenis}: Rp ${formatRp(t.dibayar)} (lunas)`),
      ...(cicilanItem ? [`${cicilanItem.jenis}: Rp ${formatRp(cicilanItem.dibayar)} (cicilan, sisa Rp ${formatRp(cicilanItem.sisa)})`] : []),
      ...(itemLainSimpan ? [`${itemLainSimpan.keperluan}: Rp ${formatRp(itemLainSimpan.jumlah)}`] : [])
    ];
    await simpanNotifikasi(
      user_id,
      '✅ Pembayaran Berhasil',
      `Setoran Rp ${formatRp(jumlahTotal)} diterima. ${rincianList.join(', ')}${kelebihan > 0 ? `. Kelebihan Rp ${formatRp(kelebihan)}` : ''}`,
      'bayar',
      { lunasList, cicilanItem, itemLainSimpan, jumlah_total: jumlahTotal, kelebihan, tanggal_bayar }
    );

    res.json({
      message: 'Pembayaran campuran berhasil',
      lunas: lunasList.length,
      cicilan: cicilanItem,
      item_lain: itemLainSimpan,
      kelebihan
    });

    // Kirim WA Kwitansi (sama format seperti pembayaran-bulk) — hanya kalau ada yang lunas atau item non-tagihan
    if (kirim_notif !== false && u.no_hp && (lunasList.length > 0 || itemLainSimpan)) {
      const rincianLunas = lunasList.map(t => `• ${t.jenis}: *Rp ${formatRp(t.dibayar)}* ✅`).join('\n');

      let imageUrl = null;
      try {
        const itemsJPG = lunasList.map(t => ({ label: t.jenis, jumlah: t.dibayar }));
        if (cicilanItem) itemsJPG.push({ label: `${cicilanItem.jenis} (cicilan)`, jumlah: cicilanItem.dibayar });
        if (itemLainSimpan) itemsJPG.push({ label: `${itemLainSimpan.keperluan} (non-tagihan)`, jumlah: itemLainSimpan.jumlah });
        const jpgBuffer = await buatKwitansiJPG({
          noKwitansi: buatNoKwitansi('CMP', user_id),
          namaWali: u.nama,
          namaSantri: u.nama_siswa,
          tanggal: tanggal_bayar,
          items: itemsJPG,
          total: jumlahTotal,
          metode: metode_bayar === 'transfer' ? 'Transfer Bank' : 'Tunai',
          statusLabel: cicilanItem ? 'SEBAGIAN LUNAS' : 'LUNAS',
          catatan: kelebihan > 0 ? `Sisa uang: Rp ${formatRp(kelebihan)}` : (keterangan || '')
        });
        imageUrl = await uploadKwitansiJPG(jpgBuffer, `kwitansi_${u.nama_siswa}`);
      } catch (e) { console.log('Gagal generate JPG kwitansi campuran:', e.message); }

      await kirimWAKwitansi(u.no_hp,
        `🧾 *KWITANSI PEMBAYARAN*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
        `Berikut kwitansi pembayaran santri:\n\n` +
        `👤 Nama Santri    : *${u.nama_siswa}*\n` +
        `📅 Tanggal Bayar  : ${tanggal_bayar}\n` +
        `💵 Total Dibayar  : *Rp ${formatRp(jumlahTotal)}*\n` +
        `💳 Metode         : *${metode_bayar === 'transfer' ? 'Transfer Bank' : 'Tunai'}*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 *Rincian Pembayaran:*\n${rincianLunas}\n` +
        (cicilanItem ? `• ${cicilanItem.jenis}: *Rp ${formatRp(cicilanItem.dibayar)}* (cicilan)\n` : '') +
        (itemLainSimpan ? `• ${itemLainSimpan.keperluan}: *Rp ${formatRp(itemLainSimpan.jumlah)}* (non-tagihan)\n` : '') +
        (kelebihan > 0 ? `\n🎉 Sisa Uang : *Rp ${formatRp(kelebihan)}*\n📝 Ket       : ${keterangan || '-'}\n` : '') +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Terima kasih atas pembayarannya 🙏\n` +
        `_Jazakumullah Khoiron, Semoga Allah memudahkan_\n` +
        `_dan melapangkan rizqi Bapak/Ibu_ Aamiin🤲\n\n` +
        `_PP. Muhammadiyah Mambaul Ulum_\n` +
        `_Mojo - Andong - Boyolali_`,
        imageUrl,
        { jenis: 'kwitansi', nama_wali: u.nama, nama_siswa: u.nama_siswa }
      );
    }

    // Kirim WA Konfirmasi (sama format seperti pembayaran-bulk) — info kekurangan/sisa tagihan
    if (kirim_notif !== false && u.no_hp) {
      const rincianKonfirmasi = lunasList.map(t => `• ${t.jenis}: *Rp ${formatRp(t.dibayar)}* ✅`).join('\n') +
        (cicilanItem ? `\n• ${cicilanItem.jenis}: *Rp ${formatRp(cicilanItem.dibayar)}* (cicilan)` : '') +
        (itemLainSimpan ? `\n• ${itemLainSimpan.keperluan}: *Rp ${formatRp(itemLainSimpan.jumlah)}* (non-tagihan)` : '');
      await kirimWA(u.no_hp,
        `✅ *Konfirmasi Pembayaran*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
        `Santri       : *${u.nama_siswa}*\n` +
        `Total Bayar  : *Rp ${formatRp(jumlahTotal)}*\n` +
        `Tanggal      : ${tanggal_bayar}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 *Rincian Pembayaran:*\n${rincianKonfirmasi}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        (cicilanItem
          ? `⚠️ *${cicilanItem.jenis}* masih sisa: *Rp ${formatRp(cicilanItem.sisa)}*\n━━━━━━━━━━━━━━━━━━\n`
          : '') +
        (totalKekurangan > 0
          ? `⚠️ *Total kekurangan semua tagihan:*\n💰 *Rp ${formatRp(totalKekurangan)}*\n━━━━━━━━━━━━━━━━━━\n` +
            `Mohon segera lunasi ke bagian administrasi atau transfer:\n\n` +
            `🏦 *Bank BRI*\n` +
            `📋 No. Rek : *6665 0101 4641 533*\n` +
            `👤 A.N     : *ALFIAN AJI WIBOWO*\n\n` +
            `📱 Konfirmasi Pembayaran:\n` +
            `☎️ Hubungi : *081393695901*\n\n`
          : `🎉 *Alhamdulillah, semua tagihan sudah lunas!*\n\n`) +
        `Terima kasih atas pembayarannya 🙏\n` +
        `_Jazakumullah Khoiron, Semoga Allah memudahkan_\n` +
        `_dan melapangkan rizqi Bapak/Ibu_ Aamiin🤲\n\n` +
        `_PP. Muhammadiyah Mambaul Ulum_\n` +
        `_Mojo - Andong - Boyolali_`,
        { jenis: 'bayaran', nama_wali: u.nama, nama_siswa: u.nama_siswa }
      );
    }
  } catch (err) {
    console.error('Pembayaran campuran error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// PEMBAYARAN FLEKSIBEL — admin pilih sendiri, per tagihan, mana yang
// mau dilunasi penuh dan mana yang mau dicicil sebagian, sekaligus
// dalam satu transaksi setoran. Beda dengan /pembayaran-campuran yang
// membagi uang secara otomatis (greedy) ke tagihan_ids, di sini nominal
// tiap tagihan ditentukan eksplisit oleh admin lewat `items`.
// Body: { user_id, items: [{tagihan_id, jumlah_bayar}], item_lain, tanggal_bayar, keterangan, metode_bayar, kirim_notif }
// Hanya mengirim SATU pesan WA kwitansi (lengkap: rincian, total tagihan,
// daftar belum lunas terurut, arahan transfer, ucapan terima kasih & doa).
// ============================================================
router.post('/pembayaran-fleksibel', verifyAdmin, async (req, res) => {
  try {
    const {
      user_id, items = [], item_lain,
      tanggal_bayar, keterangan, metode_bayar, kirim_notif
    } = req.body;

    if (!user_id) return res.status(400).json({ message: 'Santri wajib dipilih' });
    const itemsValid = (items || []).filter(it => it && it.tagihan_id && Number(it.jumlah_bayar) > 0);
    const adaItemLain = item_lain && Number(item_lain.jumlah) > 0;
    if (itemsValid.length === 0 && !adaItemLain) {
      return res.status(400).json({ message: 'Pilih minimal 1 tagihan atau isi item non-tagihan dengan nominal > 0' });
    }

    const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', user_id).single();
    if (!u) return res.status(404).json({ message: 'Santri tidak ditemukan' });

    // Ambil sisa aktual tiap tagihan dari DB (jangan percaya nilai dari frontend begitu saja)
    const tagihanIds = itemsValid.map(it => it.tagihan_id);
    let tagihanMap = {};
    if (tagihanIds.length > 0) {
      const { data: tagihanList } = await supabase.from('tagihan').select('*, pembayaran(jumlah_bayar)').in('id', tagihanIds);
      (tagihanList || []).forEach(t => {
        const sudah = (t.pembayaran || []).reduce((a, p) => a + Number(p.jumlah_bayar), 0);
        const sisa = Math.max(0, Math.round(Number(t.jumlah) - sudah));
        tagihanMap[t.id] = { ...t, sudah, sisa };
      });
    }

    const lunasList = [];
    const cicilanList = [];
    let jumlahTagihanTerbayar = 0;

    for (const it of itemsValid) {
      const t = tagihanMap[it.tagihan_id];
      if (!t) continue;
      const bayarInput = Math.round(Number(it.jumlah_bayar));
      if (bayarInput > t.sisa) {
        return res.status(400).json({ message: `Jumlah bayar untuk "${t.jenis}" (Rp ${formatRp(bayarInput)}) melebihi sisa tagihan (Rp ${formatRp(t.sisa)})` });
      }
      await supabase.from('pembayaran').insert([{ tagihan_id: t.id, jumlah_bayar: bayarInput, tanggal_bayar, keterangan: keterangan || '' }]);
      jumlahTagihanTerbayar += bayarInput;
      if (bayarInput >= t.sisa) {
        await supabase.from('tagihan').update({ status: 'lunas', tanggal_bayar }).eq('id', t.id);
        lunasList.push({ jenis: t.jenis, jumlah: t.jumlah, dibayar: bayarInput, sudah: t.sudah });
      } else {
        cicilanList.push({ jenis: t.jenis, jumlah: t.jumlah, dibayar: bayarInput, sisa: t.sisa - bayarInput, sudah: t.sudah + bayarInput });
      }
    }

    // Item non-tagihan (kalau ada)
    let itemLainSimpan = null;
    if (adaItemLain) {
      itemLainSimpan = { keperluan: item_lain.keperluan || 'Pembayaran lain', jumlah: Math.round(Number(item_lain.jumlah)) };
      await supabase.from('pembayaran_umum').insert([{
        nama_pembayar: u.nama || u.nama_siswa,
        keperluan: itemLainSimpan.keperluan,
        jumlah: itemLainSimpan.jumlah,
        tanggal: tanggal_bayar,
        keterangan: keterangan || '',
        kategori: 'umum',
        no_hp: u.no_hp || ''
      }]);
    }

    const jumlahTotal = jumlahTagihanTerbayar + (itemLainSimpan?.jumlah || 0);
    if (jumlahTotal <= 0) return res.status(400).json({ message: 'Tidak ada nominal pembayaran yang valid' });

    const rekap = await getRekapTagihanSantri(user_id);

    // Notifikasi in-app gabungan
    const rincianList = [
      ...lunasList.map(t => `${t.jenis}: Rp ${formatRp(t.dibayar)} (lunas)`),
      ...cicilanList.map(t => `${t.jenis}: Rp ${formatRp(t.dibayar)} (cicilan, sisa Rp ${formatRp(t.sisa)})`),
      ...(itemLainSimpan ? [`${itemLainSimpan.keperluan}: Rp ${formatRp(itemLainSimpan.jumlah)}`] : [])
    ];
    await simpanNotifikasi(
      user_id,
      '✅ Pembayaran Berhasil',
      `Setoran Rp ${formatRp(jumlahTotal)} diterima. ${rincianList.join(', ')}`,
      'bayar',
      { lunasList, cicilanList, itemLainSimpan, jumlah_total: jumlahTotal, tanggal_bayar }
    );

    res.json({
      message: 'Pembayaran berhasil disimpan',
      lunas: lunasList.length,
      cicilan: cicilanList.length,
      item_lain: itemLainSimpan,
      total_kekurangan: rekap.totalKekurangan
    });

    // Kirim SATU pesan WA kwitansi lengkap (rincian + total tagihan + daftar belum lunas + arahan transfer + doa)
    if (kirim_notif !== false && u.no_hp) {
      const rincianItemsWA = [
        ...lunasList.map(t => `• ${t.jenis} : *Rp ${formatRp(t.dibayar)}* ✅ Lunas`),
        ...cicilanList.map(t => `• ${t.jenis} : *Rp ${formatRp(t.dibayar)}* (Cicilan, sisa tagihan ini Rp ${formatRp(t.sisa)})`),
        ...(itemLainSimpan ? [`• ${itemLainSimpan.keperluan} : *Rp ${formatRp(itemLainSimpan.jumlah)}* (non-tagihan)`] : [])
      ];

      let imageUrl = null;
      try {
        const itemsJPG = [
          ...lunasList.map(t => ({ label: t.jenis, jumlah: t.dibayar })),
          ...cicilanList.map(t => ({ label: `${t.jenis} (cicilan)`, jumlah: t.dibayar })),
          ...(itemLainSimpan ? [{ label: `${itemLainSimpan.keperluan} (non-tagihan)`, jumlah: itemLainSimpan.jumlah }] : [])
        ];
        const jpgBuffer = await buatKwitansiJPG({
          noKwitansi: buatNoKwitansi('FLX', user_id),
          namaWali: u.nama,
          namaSantri: u.nama_siswa,
          tanggal: tanggal_bayar,
          items: itemsJPG,
          total: jumlahTotal,
          metode: metode_bayar === 'transfer' ? 'Transfer Bank' : 'Tunai',
          statusLabel: cicilanList.length > 0 ? 'SEBAGIAN LUNAS' : 'LUNAS',
          catatan: keterangan || ''
        });
        imageUrl = await uploadKwitansiJPG(jpgBuffer, `kwitansi_${u.nama_siswa}`);
      } catch (e) { console.log('Gagal generate JPG kwitansi fleksibel:', e.message); }

      const pesan = buatPesanKwitansiLengkap({
        u, tanggal_bayar, metode_bayar, rincianItems: rincianItemsWA, jumlahTotal, rekap, keterangan
      });

      await kirimWAKwitansi(u.no_hp, pesan, imageUrl, { jenis: 'kwitansi', nama_wali: u.nama, nama_siswa: u.nama_siswa });
    }
  } catch (err) {
    console.error('Pembayaran fleksibel error:', err.message);
    res.status(500).json({ message: err.message });
  }
});


router.get('/pembayaran/:tagihanId', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('pembayaran').select('*').eq('tagihan_id', req.params.tagihanId).order('tanggal_bayar');
    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ============================================================
// EDIT CICILAN
// ============================================================
router.put('/pembayaran/:id', verifyAdmin, async (req, res) => {
  try {
    const { jumlah_bayar, tanggal_bayar, keterangan } = req.body;
    await supabase.from('pembayaran').update({ jumlah_bayar, tanggal_bayar, keterangan: keterangan || '' }).eq('id', req.params.id);

    const { data: p } = await supabase.from('pembayaran').select('tagihan_id').eq('id', req.params.id).single();
    if (!p) return res.json({ message: 'Cicilan berhasil diupdate' });

    const { data: t } = await supabase.from('tagihan').select('jumlah').eq('id', p.tagihan_id).single();
    const { data: bayarList } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', p.tagihan_id);
    const total_bayar = bayarList ? bayarList.reduce((a, b) => a + Number(b.jumlah_bayar), 0) : 0;
    const status = total_bayar >= Number(t.jumlah) ? 'lunas' : 'belum';
    await supabase.from('tagihan').update({ status, tanggal_bayar: status === 'lunas' ? tanggal_bayar : null }).eq('id', p.tagihan_id);

    res.json({ message: 'Cicilan berhasil diupdate', lunas: status === 'lunas' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



// ============================================================
// ARSIP SNAPSHOT SEMESTER
// ============================================================
router.post('/semester/arsip', verifyAdmin, async (req, res) => {
  try {
    const { nama_arsip, keterangan } = req.body;
    if (!nama_arsip) return res.status(400).json({ message: 'Nama arsip wajib diisi' });

    const { data: tagihan } = await supabase.from('tagihan').select('*, users(nama_siswa, kelas)');
    const { data: payments } = await supabase.from('pembayaran').select('*');

    const payMap = {};
    for (const p of (payments || [])) {
      if (!payMap[p.tagihan_id]) payMap[p.tagihan_id] = [];
      payMap[p.tagihan_id].push({ id: p.id, jumlah_bayar: Number(p.jumlah_bayar), tanggal_bayar: p.tanggal_bayar, keterangan: p.keterangan });
    }

    const map = {};
    for (const r of (tagihan || [])) {
      const uid = r.user_id;
      if (!map[uid]) map[uid] = { user_id: uid, nama_siswa: r.users?.nama_siswa, kelas: r.users?.kelas, tagihan: [], total_tagihan: 0, total_dibayar: 0 };
      const sudah = (payMap[r.id] || []).reduce((a, p) => a + p.jumlah_bayar, 0);
      const sisa = r.status === 'lunas' ? 0 : Math.round(Number(r.jumlah) - sudah);
      map[uid].tagihan.push({ tagihan_id: r.id, jenis: r.jenis, jumlah: Number(r.jumlah), semester: r.semester || '-', status: r.status, sudah_dibayar: r.status === 'lunas' ? Number(r.jumlah) : sudah, sisa, riwayat_bayar: payMap[r.id] || [] });
      map[uid].total_tagihan += Number(r.jumlah);
      map[uid].total_dibayar += r.status === 'lunas' ? Number(r.jumlah) : sudah;
    }

    const snapshot = Object.values(map);
    const totalTagihan = snapshot.reduce((a, s) => a + s.total_tagihan, 0);
    const totalDibayar = snapshot.reduce((a, s) => a + s.total_dibayar, 0);
    const tanggal = new Date().toISOString().split('T')[0];

    const { data: inserted, error } = await supabase.from('arsip_semester').insert([{
      nama_arsip, keterangan: keterangan || '', tanggal_arsip: tanggal,
      total_tagihan: totalTagihan, total_dibayar: totalDibayar,
      jumlah_santri: snapshot.length, data_snapshot: JSON.stringify(snapshot)
    }]).select('id').single();
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: `Arsip "${nama_arsip}" berhasil disimpan!`, id: inserted.id, jumlah_santri: snapshot.length });
  } catch (err) {
    res.status(500).json({ message: 'Gagal simpan arsip: ' + err.message });
  }
});

// ============================================================
// GET DAFTAR ARSIP SEMESTER
// ============================================================
router.get('/semester/arsip', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('arsip_semester').select('id, nama_arsip, keterangan, tanggal_arsip, total_tagihan, total_dibayar, jumlah_santri, created_at').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET DETAIL ARSIP
// ============================================================
router.get('/semester/arsip/:id', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('arsip_semester').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ message: 'Arsip tidak ditemukan' });
    try { data.data_snapshot = JSON.parse(data.data_snapshot); } catch (e) { data.data_snapshot = []; }
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// HAPUS ARSIP
// ============================================================
router.delete('/semester/arsip/:id', verifyAdmin, async (req, res) => {
  try {
    await supabase.from('arsip_semester').delete().eq('id', req.params.id);
    res.json({ message: 'Arsip berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// RENAME SEMESTER
// ============================================================
router.put('/semester/rename', verifyAdmin, async (req, res) => {
  try {
    const { nama_lama, nama_baru } = req.body;
    if (!nama_lama || !nama_baru) return res.status(400).json({ message: 'nama_lama dan nama_baru wajib diisi' });
    if (nama_lama.trim() === nama_baru.trim()) return res.status(400).json({ message: 'Nama baru sama dengan nama lama' });
    const { data, error } = await supabase.from('tagihan').update({ semester: nama_baru.trim() }).eq('semester', nama_lama.trim()).select();
    if (error) return res.status(500).json({ message: error.message });
    if (!data || data.length === 0) return res.status(404).json({ message: `Semester "${nama_lama}" tidak ditemukan` });
    res.json({ message: `Semester "${nama_lama}" berhasil diubah ke "${nama_baru}"`, jumlah_tagihan: data.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// RESET TAGIHAN INDIVIDUAL
// ============================================================
router.post('/tagihan/:id/reset', verifyAdmin, async (req, res) => {
  try {
    const { data: check } = await supabase.from('tagihan').select('id').eq('id', req.params.id).single();
    if (!check) return res.status(404).json({ message: 'Tagihan tidak ditemukan' });
    await supabase.from('pembayaran').delete().eq('tagihan_id', req.params.id);
    await supabase.from('tagihan').update({ status: 'belum', tanggal_bayar: null }).eq('id', req.params.id);
    res.json({ message: 'Tagihan berhasil direset ke belum bayar.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// RESET SEMESTER
// ============================================================
router.post('/semester/reset', verifyAdmin, async (req, res) => {
  try {
    const { semester } = req.body;
    let query = supabase.from('tagihan').select('id');
    if (semester) query = query.eq('semester', semester);
    const { data: tagRows } = await query;
    if (!tagRows || tagRows.length === 0) return res.status(400).json({ message: 'Tidak ada tagihan yang bisa direset' });
    const tagIds = tagRows.map(r => r.id);
    await supabase.from('pembayaran').delete().in('tagihan_id', tagIds);
    let updateQ = supabase.from('tagihan').update({ status: 'belum', tanggal_bayar: null });
    if (semester) updateQ = updateQ.eq('semester', semester);
    await updateQ;
    res.json({ message: `Reset berhasil! ${tagIds.length} tagihan direset.`, jumlah_tagihan: tagIds.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// PREVIEW DUPLIKAT SEMESTER (sebelum simpan)
// ============================================================
router.get('/semester/preview-duplikat', verifyAdmin, async (req, res) => {
  try {
    const { semester_asal } = req.query;
    if (!semester_asal) return res.status(400).json({ message: 'semester_asal wajib diisi' });

    const { data: tagihanAsal, error } = await supabase
      .from('tagihan')
      .select('user_id, jenis, jumlah')
      .eq('semester', semester_asal);
    if (error) return res.status(500).json({ message: error.message });
    if (!tagihanAsal || tagihanAsal.length === 0)
      return res.status(404).json({ message: `Tidak ada tagihan di semester "${semester_asal}"` });

    const { data: users } = await supabase.from('users').select('id, nama_siswa, kelas').order('nama_siswa');

    const templateMap = {};
    for (const t of tagihanAsal) {
      if (!templateMap[t.user_id]) templateMap[t.user_id] = [];
      templateMap[t.user_id].push({ jenis: t.jenis, jumlah: Number(t.jumlah) });
    }

    const jenisCount = {};
    for (const t of tagihanAsal) {
      const key = `${t.jenis}||${t.jumlah}`;
      jenisCount[key] = (jenisCount[key] || 0) + 1;
    }
    const templateGlobal = Object.entries(jenisCount)
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => {
        const [jenis, jumlah] = key.split('||');
        return { jenis, jumlah: Number(jumlah) };
      });

    const preview = (users || []).map(u => {
      const tagihanUser = templateMap[u.id] || templateGlobal;
      return {
        user_id: u.id,
        nama_siswa: u.nama_siswa,
        kelas: u.kelas,
        tagihan: tagihanUser,
        total: tagihanUser.reduce((a, t) => a + t.jumlah, 0)
      };
    });

    res.json({ semester_asal, total_santri: preview.length, template_global: templateGlobal, preview });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET DAFTAR SEMESTER YANG ADA
// ============================================================
router.get('/semester/daftar', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tagihan')
      .select('semester')
      .not('semester', 'is', null)
      .neq('semester', '');
    if (error) return res.status(500).json({ message: error.message });
    const unik = [...new Set(data.map(r => r.semester))].sort();
    res.json(unik);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// TAMBAH SEMESTER BARU + AUTO-DUPLIKAT + NOTIFIKASI WA
// ============================================================
router.post('/semester', verifyAdmin, async (req, res) => {
  try {
    const { nama_semester, tagihan_baru, semester_asal, duplikat_otomatis } = req.body;
    if (!nama_semester || !nama_semester.trim())
      return res.status(400).json({ message: 'nama_semester wajib diisi' });

    // Cegah duplikat nama semester
    const { data: cekAda } = await supabase
      .from('tagihan').select('id').eq('semester', nama_semester.trim()).limit(1);
    if (cekAda && cekAda.length > 0)
      return res.status(409).json({ message: `Semester "${nama_semester}" sudah ada` });

    let finalTagihan = tagihan_baru ? [...tagihan_baru] : [];

    // === AUTO-DUPLIKAT jika tagihan_baru tidak dikirim ===
    if (finalTagihan.length === 0 && duplikat_otomatis !== false) {
      let semesterReferensi = semester_asal;

      // Jika semester_asal tidak disebutkan, ambil semester terakhir
      if (!semesterReferensi) {
        const { data: semuaSemester } = await supabase
          .from('tagihan').select('semester').not('semester', 'is', null).neq('semester', '');
        if (semuaSemester && semuaSemester.length > 0) {
          const daftarUnik = [...new Set(semuaSemester.map(r => r.semester))].sort();
          semesterReferensi = daftarUnik[daftarUnik.length - 1];
        }
      }

      if (semesterReferensi) {
        const { data: tagihanReferensi } = await supabase
          .from('tagihan').select('user_id, jenis, jumlah').eq('semester', semesterReferensi);

        if (tagihanReferensi && tagihanReferensi.length > 0) {
          // Map per user dari semester referensi
          const perUser = {};
          for (const t of tagihanReferensi) {
            if (!perUser[t.user_id]) perUser[t.user_id] = [];
            perUser[t.user_id].push({ jenis: t.jenis, jumlah: Number(t.jumlah) });
          }

          // Template global (jenis+jumlah paling umum) sebagai fallback santri baru
          const jenisCount = {};
          for (const t of tagihanReferensi) {
            const key = `${t.jenis}||${t.jumlah}`;
            jenisCount[key] = (jenisCount[key] || 0) + 1;
          }
          const templateGlobal = Object.entries(jenisCount)
            .sort((a, b) => b[1] - a[1])
            .map(([key]) => {
              const [jenis, jumlah] = key.split('||');
              return { jenis, jumlah: Number(jumlah) };
            });

          // Ambil semua santri aktif
          const { data: semuaUser } = await supabase.from('users').select('id');
          for (const u of (semuaUser || [])) {
            const tagihanUser = perUser[u.id] || templateGlobal;
            for (const t of tagihanUser) {
              finalTagihan.push({ user_id: u.id, jenis: t.jenis, jumlah: t.jumlah });
            }
          }
        }
      }
    }

    if (finalTagihan.length === 0)
      return res.status(400).json({ message: 'Tidak ada data tagihan. Isi manual atau pastikan ada semester sebelumnya untuk diduplikat.' });

    const insertData = finalTagihan.map(t => ({
      user_id: t.user_id, jenis: t.jenis, jumlah: Math.round(Number(t.jumlah)),
      tanggal_bayar: null, status: 'belum', semester: nama_semester.trim()
    }));
    const { error: insertError } = await supabase.from('tagihan').insert(insertData);
    if (insertError) return res.status(500).json({ message: insertError.message });

    res.json({
      message: `${finalTagihan.length} tagihan semester "${nama_semester}" berhasil ditambahkan!`,
      jumlah: finalTagihan.length,
      semester: nama_semester.trim(),
      duplikat_dari: semester_asal || '(otomatis dari semester terakhir)'
    });

    // === NOTIFIKASI WA (background) ===
    const userIds = [...new Set(finalTagihan.map(t => t.user_id))];
    for (const uid of userIds) {
      try {
        const tagihanUser = finalTagihan.filter(t => t.user_id === uid);
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', uid).single();
        if (!u || !u.no_hp) continue;

        const { data: tunggakan } = await supabase
          .from('tagihan')
          .select('jenis, jumlah, semester, pembayaran(jumlah_bayar)')
          .eq('user_id', uid).eq('status', 'belum').neq('semester', nama_semester.trim());

        const daftarBaru = tagihanUser.map(t => `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`).join('\n');
        const totalBaru = tagihanUser.reduce((a, b) => a + Math.round(Number(b.jumlah)), 0);

        let pesanTunggakan = '';
        let totalLama = 0;
        if (tunggakan && tunggakan.length > 0) {
          const rincianLama = tunggakan.map(t => {
            const sudah = (t.pembayaran || []).reduce((a, p) => a + Number(p.jumlah_bayar), 0);
            const sisa = Math.round(Number(t.jumlah) - sudah);
            totalLama += sisa;
            return sudah > 0
              ? `• [${t.semester || '-'}] ${t.jenis}: sisa *Rp ${formatRp(sisa)}*`
              : `• [${t.semester || '-'}] ${t.jenis}: *Rp ${formatRp(sisa)}*`;
          }).join('\n');
          pesanTunggakan = `\n⚠️ *Tunggakan Sebelumnya:*\n${rincianLama}\n━━━━━━━━━━━━━━━━━━\nTotal Tunggakan: *Rp ${formatRp(totalLama)}*\n`;
        }

        const grandTotal = totalBaru + totalLama;
        await kirimWA(u.no_hp,
          `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
          `📅 *Tagihan ${nama_semester} Telah Ditetapkan*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Santri : *${u.nama_siswa}*\n\n` +
          `📋 *Tagihan Semester Ini:*\n${daftarBaru}\n` +
          `Total Baru: *Rp ${formatRp(totalBaru)}*\n` +
          pesanTunggakan +
          `━━━━━━━━━━━━━━━━━━\n` +
          (totalLama > 0 ? `💰 *Total Keseluruhan: Rp ${formatRp(grandTotal)}*\n` : `💰 *Total: Rp ${formatRp(totalBaru)}*\n`) +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Mohon segera lakukan pembayaran 🙏\n\n` +
          `_PP. Muhammadiyah Mambaul Ulum_\n` +
          `_Mojo - Andong - Boyolali_`,
          { jenis: 'tagihan', nama_wali: u.nama, nama_siswa: u.nama_siswa }
        );
      } catch (e) { console.log('WA semester error:', e.message); }
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET DETAIL TUNGGAKAN PER SEMESTER
// ============================================================
router.get('/semester/:nama/detail', verifyAdmin, async (req, res) => {
  try {
    const { data: tagihan, error } = await supabase.from('tagihan').select('*, users(nama_siswa, kelas, no_hp)').eq('semester', req.params.nama).order('user_id');
    if (error) return res.status(500).json({ message: error.message });

    const map = {};
    for (const r of tagihan) {
      const uid = r.user_id;
      if (!map[uid]) map[uid] = { user_id: uid, nama_siswa: r.users?.nama_siswa, kelas: r.users?.kelas, no_hp: r.users?.no_hp, tagihan: [], total_tagihan: 0, total_sudah_bayar: 0 };
      const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', r.id);
      const sudah = r.status === 'lunas' ? Number(r.jumlah) : (bayar || []).reduce((a, p) => a + Number(p.jumlah_bayar), 0);
      const sisa = r.status === 'lunas' ? 0 : Math.round(Number(r.jumlah) - sudah);
      map[uid].tagihan.push({ id: r.id, jenis: r.jenis, jumlah: Number(r.jumlah), status: r.status, sudah_dicicil: sudah, sisa });
      map[uid].total_tagihan += Number(r.jumlah);
      map[uid].total_sudah_bayar += sudah;
    }
    res.json(Object.values(map));
  } catch (err) {
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ============================================================
// GET TUNGGAKAN LAMA PER SANTRI
// ============================================================
router.get('/tunggakan-per-santri', verifyAdmin, async (req, res) => {
  try {
    const { data: tagihan, error } = await supabase.from('tagihan').select('*, users(nama_siswa, kelas)').eq('status', 'belum').order('user_id');
    if (error) return res.status(500).json({ message: error.message });

    const map = {};
    for (const r of tagihan) {
      const uid = r.user_id;
      if (!map[uid]) map[uid] = { user_id: uid, nama_siswa: r.users?.nama_siswa, kelas: r.users?.kelas, tagihan: [], total_tunggakan: 0 };
      const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', r.id);
      const sudah = (bayar || []).reduce((a, p) => a + Number(p.jumlah_bayar), 0);
      const sisa = Math.round(Number(r.jumlah) - sudah);
      if (sisa > 0) {
        map[uid].tagihan.push({ id: r.id, jenis: r.jenis, jumlah: Number(r.jumlah), sudah_dicicil: sudah, sisa, semester: r.semester || '-' });
        map[uid].total_tunggakan += sisa;
      }
    }
    res.json(Object.values(map));
  } catch (err) {
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ============================================================
// GET DAFTAR SEMESTER (dengan statistik)
// ============================================================
router.get('/semester', verifyAdmin, async (req, res) => {
  try {
    const { data: tagihan, error } = await supabase.from('tagihan').select('semester, jumlah, status, user_id, id').not('semester', 'is', null).neq('semester', '');
    if (error) return res.status(500).json({ message: error.message });

    const map = {};
    for (const t of tagihan) {
      if (!map[t.semester]) map[t.semester] = { semester: t.semester, jumlah_tagihan: 0, jumlah_santri: new Set(), total_tagihan: 0, total_terbayar: 0 };
      map[t.semester].jumlah_tagihan++;
      map[t.semester].jumlah_santri.add(t.user_id);
      map[t.semester].total_tagihan += Number(t.jumlah);
    }

    for (const sem of Object.values(map)) {
      const ids = tagihan.filter(t => t.semester === sem.semester).map(t => t.id);
      const { data: bayarList } = await supabase.from('pembayaran').select('jumlah_bayar, tagihan_id').in('tagihan_id', ids);
      const lunasList = tagihan.filter(t => t.semester === sem.semester && t.status === 'lunas');
      const lunasTotal = lunasList.reduce((a, t) => a + Number(t.jumlah), 0);
      const cicilanTotal = (bayarList || []).filter(p => !lunasList.find(t => t.id === p.tagihan_id)).reduce((a, p) => a + Number(p.jumlah_bayar), 0);
      sem.total_terbayar = lunasTotal + cicilanTotal;
      sem.jumlah_santri = sem.jumlah_santri.size;
    }

    res.json(Object.values(map).sort((a, b) => b.semester.localeCompare(a.semester)));
  } catch (err) {
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ============================================================
// PENGINGAT OTOMATIS (in-memory — tidak persist di Vercel)
// ============================================================
let jadwalPengingat = { aktif: false, tanggal: 1, jam: '08:00', intervalId: null };

const kirimPengingatSemua = async () => {
  const { data: users } = await supabase.from('users').select('id, nama, nama_siswa, no_hp').not('no_hp', 'is', null).neq('no_hp', '');
  let terkirim = 0;
  for (const u of (users || [])) {
    const sisa = await getTotalKekurangan(u.id);
    if (sisa <= 0) continue;
    try {
      const { data: tagihan } = await supabase.from('tagihan').select('jenis, jumlah, pembayaran(jumlah_bayar)').eq('user_id', u.id).eq('status', 'belum');
      const rincian = (tagihan || []).map(t => {
        const sudah = (t.pembayaran || []).reduce((a, p) => a + Number(p.jumlah_bayar), 0);
        const sisaT = Math.round(Number(t.jumlah) - sudah);
        return sudah > 0
          ? `• ${t.jenis}\n  Sisa: *Rp ${formatRp(sisaT)}*`
          : `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`;
      }).join('\n');

      await kirimWA(u.no_hp,
        `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
        `🔔 *Pengingat Tagihan - PP. Mambaul Ulum*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Santri : *${u.nama_siswa}*\n\n` +
        `📋 Tagihan yang belum lunas:\n${rincian}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💰 Total Kekurangan: *Rp ${sisa.toLocaleString('id-ID')}*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Mohon segera lunasi ke bagian administrasi atau transfer:\n\n` +
        `🏦 *Bank BRI*\n` +
        `📋 No. Rek : *6665 0101 4641 533*\n` +
        `👤 A.N     : *ALFIAN AJI WIBOWO*\n\n` +
        `📱 Konfirmasi Pembayaran:\n` +
        `☎️ Hubungi : *081393695901*\n\n` +
        `Terima kasih 🙏\n` +
        `_Jazakumullah Khoiron, Semoga Allah memudahkan_\n` +
        `_dan melapangkan rizqi Bapak/Ibu_ Aamiin 🤲\n\n` +
        `_PP. Muhammadiyah Mambaul Ulum_\n` +
        `_Mojo - Andong - Boyolali_`,
        { jenis: 'pengingat', nama_wali: u.nama, nama_siswa: u.nama_siswa }
        
      );
      await simpanNotifikasi(
  u.id,
  '🔔 Pengingat Tagihan',
  `Masih ada tunggakan sebesar Rp ${sisa.toLocaleString('id-ID')}. Segera lunasi ke administrasi pondok.`,
  'info',
  { sisa }
);
    } catch (e) { console.log('WA pengingat error:', e.message); }
  }
  return terkirim;
};

router.get('/pengingat/jadwal', verifyAdmin, (req, res) => {
  res.json({ aktif: jadwalPengingat.aktif, tanggal: jadwalPengingat.tanggal, jam: jadwalPengingat.jam });
});

router.post('/pengingat/jadwal', verifyAdmin, (req, res) => {
  const { aktif, tanggal, jam } = req.body;
  jadwalPengingat.aktif = aktif;
  jadwalPengingat.tanggal = Number(tanggal) || 1;
  jadwalPengingat.jam = jam || '08:00';
  res.json({ message: aktif ? `Jadwal aktif: setiap tanggal ${jadwalPengingat.tanggal} jam ${jadwalPengingat.jam}` : 'Jadwal dinonaktifkan', jadwal: jadwalPengingat });
});

router.post('/pengingat/kirim-semua', verifyAdmin, async (req, res) => {
  try {
    const terkirim = await kirimPengingatSemua();
    res.json({ message: `Pengingat berhasil dikirim ke ${terkirim} wali santri`, terkirim });
  } catch (e) {
    res.status(500).json({ message: 'Gagal mengirim pengingat: ' + e.message });
  }
});

router.post('/pengingat/kirim/:userId', verifyAdmin, async (req, res) => {
  try {
    const { data: u } = await supabase.from('users').select('id, nama, nama_siswa, no_hp').eq('id', req.params.userId).single();
    if (!u) return res.status(404).json({ message: 'Santri tidak ditemukan' });
    if (!u.no_hp) return res.status(400).json({ message: 'Santri belum punya nomor WA' });

    const sisa = await getTotalKekurangan(u.id);
    if (sisa <= 0) return res.status(400).json({ message: 'Santri tidak punya tunggakan' });

    const { data: tagihan } = await supabase.from('tagihan').select('jenis, jumlah, pembayaran(jumlah_bayar)').eq('user_id', u.id).eq('status', 'belum');
    const rincian = (tagihan || []).map(t => {
      const sudah = (t.pembayaran || []).reduce((a, p) => a + Number(p.jumlah_bayar), 0);
      const sisaT = Math.round(Number(t.jumlah) - sudah);
      return sudah > 0 ? `• ${t.jenis}\n  Sisa: *Rp ${formatRp(sisaT)}*` : `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`;
    }).join('\n');

    await kirimWA(u.no_hp,
      `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
      `🔔 *Pengingat Tagihan - PP. Mambaul Ulum*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Santri : *${u.nama_siswa}*\n\n` +
      `📋 Tagihan yang belum lunas:\n${rincian}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💰 Total Kekurangan: *Rp ${sisa.toLocaleString('id-ID')}*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Mohon segera lunasi ke bagian administrasi atau transfer:\n\n` +
      `🏦 *Bank BRI*\n` +
      `📋 No. Rek : *6665 0101 4641 533*\n` +
      `👤 A.N     : *ALFIAN AJI WIBOWO*\n\n` +
      `📱 Konfirmasi Pembayaran:\n` +
      `☎️ Hubungi : *081393695901*\n\n` +
      `Terima kasih 🙏\n` +
      `_Jazakumullah Khoiron, Semoga Allah memudahkan_\n` +
      `_dan melapangkan rizqi Bapak/Ibu_ Aamiin 🤲\n\n` +
      `_PP. Muhammadiyah Mambaul Ulum_\n` +
      `_Mojo - Andong - Boyolali_`,
      { jenis: 'pengingat', nama_wali: u.nama, nama_siswa: u.nama_siswa }
    );
    await simpanNotifikasi(
  u.id,
  '🔔 Pengingat Tagihan',
  `Masih ada tunggakan sebesar Rp ${sisa.toLocaleString('id-ID')}. Segera lunasi ke administrasi pondok.`,
  'info',
  { sisa }
);
    res.json({ message: `Pengingat berhasil dikirim ke ${u.nama} (${u.no_hp})` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// KIRIM WA NOTIFIKASI KELEBIHAN BAYAR
// ============================================================
router.post('/kirim-wa-kelebihan', verifyAdmin, async (req, res) => {
  const { no_hp, nama_wali, nama_siswa, jumlah_bayar, jumlah_tagihan, jenis_tagihan, kelebihan, keterangan, user_id } = req.body;
  if (!no_hp) return res.status(400).json({ message: 'Nomor HP tidak ada' });

  // Ambil total kekurangan
  const totalKekurangan = user_id ? await getTotalKekurangan(user_id) : 0;

  const pesan =
    `Assalamu'alaikum Bapak/Ibu *${nama_wali}*,\n\n` +
    `✅ *Konfirmasi Pembayaran*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Santri       : *${nama_siswa}*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💰 Total Bayar   : *Rp ${formatRp(jumlah_bayar)}*\n` +
    `📚 Pembayaran : *${jenis_tagihan}*\n` +
`✅ Untuk Tagihan    : *Rp ${formatRp(jumlah_tagihan)}* (Lunas)\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🎉 Sisa Uang     : *Rp ${formatRp(kelebihan)}*\n` +
    `📝 Ket           : ${keterangan}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    (totalKekurangan > 0
    ? `⚠️ *Info:* Masih ada kekurangan tagihan lain: *Rp ${formatRp(totalKekurangan)}*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Mohon segera lunasi ke bagian administrasi atau transfer:\n\n` +
      `🏦 *Bank BRI*\n` +
      `📋 No. Rek : *6665 0101 4641 533*\n` +
      `👤 A.N     : *ALFIAN AJI WIBOWO*\n\n` +
      `📱 Konfirmasi Pembayaran:\n` +
      `☎️ Hubungi : *081393695901*\n\n`
    : `🎉 *Alhamdulillah, semua tagihan sudah lunas!*\n\n` +
      `Terima kasih atas pembayarannya 🙏\n` +
      `_Jazakumullah Khoiron, Semoga Allah memudahkan_\n` +
      `_dan melapangkan rizqi Bapak/Ibu_ Aamiin 🤲\n\n`) +
    `_PP. Muhammadiyah Mambaul Ulum_\n` +
    `_Mojo - Andong - Boyolali_`;

  try {
    await kirimWA(no_hp, pesan, { jenis: 'bayaran', nama_wali, nama_siswa });
    res.json({ message: 'Notifikasi WA berhasil dikirim' });
  } catch (e) {
    res.status(500).json({ message: 'Gagal kirim WA: ' + e.message });
  }
});
// ============================================================
// GET RIWAYAT NOTIFIKASI WA
// ============================================================
// HAPUS SEMUA RIWAYAT WA
router.delete('/riwayat-wa', verifyAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('riwayat_wa').delete().neq('id', 0);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Semua riwayat notifikasi berhasil dihapus' });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/riwayat-wa', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('riwayat_wa')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ message: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// VERIFIKASI KEASLIAN KWITANSI (PUBLIK, TANPA LOGIN)
// Dibuka lewat scan QR / link yang tertera di kwitansi JPG.
// Sig dihitung ulang dari KWITANSI_SECRET (server-only) dan dibandingkan
// dengan sig yang dibawa di URL -> kalau nominal/nama/tanggal di kwitansi
// diedit (mis. pakai Photoshop), sig baru tidak akan pernah cocok.
// ============================================================
router.get('/verify', (req, res) => {
  const { no, t, d, s, sig } = req.query;
  const halaman = (valid, pesan) => `
    <!DOCTYPE html>
    <html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Verifikasi Kwitansi</title>
    <style>
      body{font-family:system-ui,sans-serif;background:#f0fdf4;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;box-sizing:border-box;}
      .card{background:#fff;max-width:420px;width:100%;border-radius:16px;padding:28px 24px;box-shadow:0 10px 30px rgba(0,0,0,0.08);text-align:center;}
      .icon{font-size:48px;margin-bottom:8px;}
      h1{font-size:18px;margin:0 0 6px;color:${valid ? '#0b6e4f' : '#dc2626'};}
      p.sub{color:#64748b;font-size:13px;margin:0 0 18px;}
      table{width:100%;text-align:left;border-collapse:collapse;font-size:14px;}
      td{padding:8px 0;border-bottom:1px solid #f1f5f9;}
      td.label{color:#64748b;width:40%;}
      td.val{font-weight:600;color:#111;}
    </style></head>
    <body><div class="card">
      <div class="icon">${valid ? '✅' : '⚠️'}</div>
      <h1>${valid ? 'Kwitansi ASLI & Terverifikasi' : 'Kwitansi Tidak Valid'}</h1>
      <p class="sub">${pesan}</p>
      ${valid ? `<table>
        <tr><td class="label">No. Kwitansi</td><td class="val">${escapeXml(no || '-')}</td></tr>
        <tr><td class="label">Nama Santri</td><td class="val">${escapeXml(s || '-')}</td></tr>
        <tr><td class="label">Tanggal Bayar</td><td class="val">${escapeXml(d || '-')}</td></tr>
        <tr><td class="label">Jumlah</td><td class="val">Rp ${formatRp(t || 0)}</td></tr>
      </table>` : ''}
    </div></body></html>`;

  if (!no || !t || !d || !s || !sig) {
    return res.status(400).send(halaman(false, 'Data verifikasi tidak lengkap.'));
  }
  const sigSeharusnya = buatSignatureKwitansi(no, t, d, s);
  if (sig.toUpperCase() !== sigSeharusnya) {
    return res.status(400).send(halaman(false, 'Data pada kwitansi tidak cocok dengan sistem — kemungkinan sudah diubah/dipalsukan.'));
  }
  return res.send(halaman(true, 'Data kwitansi ini cocok dengan catatan resmi sistem keuangan pondok.'));
});

// ============================================================
// KIRIM ULANG WA YANG GAGAL
// ============================================================
router.post('/resend-wa/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: riwayat, error } = await supabase.from('riwayat_wa').select('*').eq('id', id).single();
    if (error || !riwayat) return res.status(404).json({ message: 'Data riwayat tidak ditemukan' });

    // Kirim ulang ke Fonnte — terapkan mode tes jika aktif
    const nomorFormatted = getNomorTujuan(riwayat.no_hp);
    let status = 'terkirim';
    try {
      const response = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { 'Authorization': process.env.FONNTE_TOKEN },
        body: new URLSearchParams({ target: nomorFormatted, message: riwayat.pesan })
      });
      const hasil = await response.json();
      console.log('Resend WA ke', nomorFormatted, ':', JSON.stringify(hasil));
      if (!hasil.status) {
        status = 'gagal';
        console.log('Resend WA gagal:', hasil.reason || hasil.message || '-');
      }
    } catch (e) {
      status = 'gagal';
      console.log('Resend WA error:', e.message);
    }

    // Update status di riwayat_wa
    await supabase.from('riwayat_wa').update({ status }).eq('id', id);

    if (status === 'terkirim') {
      res.json({ message: 'Pesan berhasil dikirim ulang' });
    } else {
      res.status(500).json({ message: 'Gagal kirim ulang pesan' });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET RIWAYAT PEMBAYARAN
// Query param opsional: ?bulan=YYYY-MM  -> filter server-side per bulan (WIB),
// supaya tidak perlu fetch semua data / tidak kena batasan limit(200) di fallback.
// ============================================================
router.get('/riwayat-pembayaran', verifyAdmin, async (req, res) => {
  try {
    const { bulan } = req.query; // format: "2026-07"
    let dariISO = null, sampaiISO = null; // rentang UTC, dikonversi dari batas awal/akhir bulan WIB (UTC+7)
    if (bulan && /^\d{4}-\d{2}$/.test(bulan)) {
      const [y, m] = bulan.split('-').map(Number);
      dariISO = new Date(Date.UTC(y, m - 1, 1, -7, 0, 0)).toISOString();   // tgl 1 jam 00:00 WIB
      sampaiISO = new Date(Date.UTC(y, m, 1, -7, 0, 0)).toISOString();     // tgl 1 bulan berikutnya jam 00:00 WIB (exclusive)
    }

    const { data, error } = await supabase.rpc('get_riwayat_pembayaran');
    if (error) {
      // fallback manual join
      let query = supabase.from('pembayaran').select('*').eq('arsip', false)
        .order('tanggal_bayar', { ascending: false })
        .order('id', { ascending: false }); // tie-break: pembayaran tanggal sama -> yang terakhir diinput muncul duluan
      if (dariISO && sampaiISO) {
        query = query.gte('tanggal_bayar', dariISO).lt('tanggal_bayar', sampaiISO);
      } else {
        query = query.limit(200);
      }
      const { data: pembayaran } = await query;
      const result = await Promise.all((pembayaran || []).map(async (p) => {
        const { data: t } = await supabase.from('tagihan').select('jenis, jumlah, user_id').eq('id', p.tagihan_id).single();
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, kelas').eq('id', t?.user_id).single();
        return { id: p.id, tanggal_bayar: p.tanggal_bayar, jumlah_bayar: p.jumlah_bayar, keterangan: p.keterangan, jenis_tagihan: t?.jenis, total_tagihan: t?.jumlah, nama_siswa: u?.nama_siswa, nama_wali: u?.nama, kelas: u?.kelas };
      }));
      return res.json(result);
    }

    // RPC berhasil -> urutkan berdasarkan waktu bayar (RPC tidak menjamin urutan),
    // tanggal_bayar terlama duluan, tie-break pakai id (mendekati urutan input asli
    // karena kolom tanggal_bayar cuma simpan tanggal, tidak simpan jam).
    let result = (data || []).slice().sort((a, b) => {
      const dt = new Date(a.tanggal_bayar) - new Date(b.tanggal_bayar);
      if (dt !== 0) return dt;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    if (dariISO && sampaiISO) {
      const dariMs = new Date(dariISO).getTime();
      const sampaiMs = new Date(sampaiISO).getTime();
      result = result.filter(r => {
        if (!r.tanggal_bayar) return false;
        const t = new Date(r.tanggal_bayar).getTime();
        return t >= dariMs && t < sampaiMs;
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// PENGUMUMAN & BROADCAST
// ============================================================
router.get('/pengumuman', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pengumuman')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ message: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ message: e.message }); }
});

router.post('/pengumuman/kirim', verifyAdmin, async (req, res) => {
  const { judul, pesan, target_ids, file_base64, file_name, grup_id } = req.body;

if (!pesan) return res.status(400).json({ message: 'Pesan wajib diisi' });
if (!target_ids || target_ids.length === 0) return res.status(400).json({ message: 'Tidak ada penerima' });

// Upload PDF ke Supabase Storage jika ada
let publicUrl = null;
if (file_base64 && file_name) {
  const base64Data = file_base64.includes(',') ? file_base64.split(',')[1] : file_base64;
  const pdfBuffer = Buffer.from(base64Data, 'base64');
  const filePath = `pdf/${Date.now()}_${file_name}`;

  console.log('Mencoba upload PDF:', filePath, 'size:', pdfBuffer.length);

  const { data: uploadData, error: uploadError } = await supabase
    .storage
    .from('pengumuman')
    .upload(filePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  console.log('Upload result:', JSON.stringify(uploadData), JSON.stringify(uploadError));

  if (uploadError) {
    console.error('Upload PDF error:', uploadError);
  } else {
    const { data: urlData } = supabase
      .storage
      .from('pengumuman')
      .getPublicUrl(uploadData.path);
    publicUrl = urlData.publicUrl;
    console.log('PDF public URL:', publicUrl);
  }
}

  try {
    // Ambil data wali sesuai target
    const { data: users } = await supabase
      .from('users')
      .select('id, nama, nama_siswa, no_hp')
      .in('id', target_ids)
      .not('no_hp', 'is', null)
      .neq('no_hp', '');

    let terkirim = 0;
    const pesanLengkap = (judul ? `*${judul}*\n\n` : '') +
      pesan + '\n\n' +
      '_PP. Muhammadiyah Mambaul Ulum_\n' +
      '_Mojo - Andong - Boyolali_';

    for (const u of (users || [])) {
      try {
        if (publicUrl && file_name) {
          // Kirim dengan dokumen PDF — terapkan mode tes seperti kirimWA()
          const nomorFormatted = getNomorTujuan(u.no_hp);
          const formData = new FormData();
          formData.append('target', nomorFormatted);
          formData.append('message', pesanLengkap + (publicUrl ? `\n\n📎 Lampiran PDF:\n${publicUrl}` : ''));
          const responsePDF = await fetch('https://api.fonnte.com/send', {
            method: 'POST',
            headers: { 'Authorization': process.env.FONNTE_TOKEN },
            body: formData
          });
          const hasilPDF = await responsePDF.json();
          console.log('Fonnte PDF response ke', nomorFormatted, ':', JSON.stringify(hasilPDF));
        } else {
          await kirimWA(u.no_hp, pesanLengkap, { jenis: 'pengumuman', nama_wali: u.nama, nama_siswa: u.nama_siswa });
        }
        terkirim++;
      } catch(e) { console.log('Error kirim pengumuman:', e.message); }
    }

    // Kirim ke grup WA jika ada
    if (grup_id && grup_id.trim() !== '') {
      try {
        const formDataGrup = new FormData();
        formDataGrup.append('target', grup_id.trim());
        formDataGrup.append('message', pesanLengkap + (publicUrl ? `\n\n📎 Lampiran PDF:\n${publicUrl}` : ''));
        const resGrup = await fetch('https://api.fonnte.com/send', {
          method: 'POST',
          headers: { 'Authorization': process.env.FONNTE_TOKEN },
          body: formDataGrup
        });
        const hasilGrup = await resGrup.json();
        console.log('Fonnte Grup response:', JSON.stringify(hasilGrup));
      } catch(e) { console.log('Error kirim grup:', e.message); }
    }
    // Simpan ke riwayat pengumuman
    await supabase.from('pengumuman').insert([{
      judul: judul || 'Pengumuman',
      pesan,
      terkirim,
      total_target: target_ids.length,
    }]);

    res.json({ message: `Pengumuman berhasil dikirim ke ${terkirim} wali santri`, terkirim });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// ============================================================
// PEMBAYARAN UMUM (Non-Tagihan)
// ============================================================
router.get('/pembayaran-umum', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pembayaran_umum')
      .select('*')
      .order('tanggal', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ message: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.post('/pembayaran-umum', verifyAdmin, async (req, res) => {
  try {
    const { nama_pembayar, keperluan, jumlah, tanggal, keterangan, kategori, no_hp, kirim_notif } = req.body;
    if (!nama_pembayar || !keperluan || !jumlah) return res.status(400).json({ message: 'Nama, keperluan, jumlah wajib diisi' });
    const { data, error } = await supabase.from('pembayaran_umum').insert([{
      nama_pembayar, keperluan, jumlah: Number(jumlah), tanggal, keterangan, kategori: kategori || 'umum', no_hp: no_hp || ''
    }]).select().single();
    if (error) return res.status(500).json({ message: error.message });

    if (kirim_notif && no_hp) {
      try {
        await kirimWA(no_hp,
          `Assalamu'alaikum,\n\n` +
          `✅ *Konfirmasi Pembayaran*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 Nama       : *${nama_pembayar}*\n` +
          `📋 Keperluan  : *${keperluan}*\n` +
          `💰 Jumlah     : *Rp ${formatRp(jumlah)}*\n` +
          `📅 Tanggal    : ${tanggal}\n` +
          (keterangan ? `📝 Keterangan : ${keterangan}\n` : '') +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Terima kasih 🙏\n` +
          `_Jazakumullah Khoiron, Semoga Allah memudahkan_\n` +
          `_dan melapangkan rizqi Bapak/Ibu_ Aamiin 🤲\n\n` +
          `_PP. Muhammadiyah Mambaul Ulum_\n` +
          `_Mojo - Andong - Boyolali_`,
          { jenis: 'pembayaran_umum', nama_wali: nama_pembayar, nama_siswa: nama_pembayar }
        );
      } catch (e) { console.log('WA pembayaran umum error:', e.message); }
    }

    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.delete('/pembayaran-umum/:id', verifyAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('pembayaran_umum').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Berhasil dihapus' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ============================================================
// HAPUS RIWAYAT PEMBAYARAN (tagihan)
// ============================================================
router.delete('/pembayaran/:id', verifyAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('pembayaran').update({ arsip: true }).eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Berhasil dihapus dari riwayat' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

router.delete('/pembayaran/hapus-semua', verifyAdmin, async (req, res) => {
  try {
    await supabase.from('pembayaran').update({ arsip: true }).neq('id', 0);
    res.json({ message: 'Semua riwayat pembayaran berhasil disembunyikan' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ============================================================
// KEEP ALIVE — mencegah Supabase auto pause
// ============================================================
router.get('/keep-alive', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    const { error } = await supabase.from('admins').select('id').limit(1);
    if (error) throw error;
    res.json({ status: 'ok', time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});
// ============================================================
// NOTIFIKASI IN-APP
// ============================================================

// PATCH baca-semua HARUS di atas /:id/baca agar tidak tertimpa
router.patch('/notifikasi/baca-semua', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token diperlukan' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    await supabase.from('notifikasi').update({ sudah_dibaca: true }).eq('user_id', decoded.id);
    res.json({ message: 'ok' });
  } catch { res.status(401).json({ message: 'Token tidak valid' }); }
});

router.patch('/notifikasi/:id/baca', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token diperlukan' });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    await supabase.from('notifikasi').update({ sudah_dibaca: true }).eq('id', req.params.id);
    res.json({ message: 'ok' });
  } catch { res.status(401).json({ message: 'Token tidak valid' }); }
});

router.get('/notifikasi', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token diperlukan' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data, error } = await supabase
      .from('notifikasi')
      .select('*')
      .eq('user_id', decoded.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ message: error.message });
    res.json(data || []);
  } catch { res.status(401).json({ message: 'Token tidak valid' }); }
});
// Simpan push subscription dari HP user
router.post('/push-subscribe', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token diperlukan' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { subscription } = req.body;
    await supabase.from('push_subscriptions').upsert([{
      user_id: decoded.id,
      subscription
    }], { onConflict: 'user_id' });
    res.json({ message: 'ok' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
// Hapus push subscription (dipanggil pas logout) — biar HP yg udah logout
// nggak terus-terusan kebagian notif punya akun lain di device yg sama
router.post('/push-unsubscribe', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token diperlukan' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { endpoint } = req.body || {};
 
    // Hapus subscription milik user yg logout ini
    await supabase.from('push_subscriptions').delete().eq('user_id', decoded.id);
 
    // Kalau endpoint dikirim dari client, bersihin juga baris user LAIN yang
    // kebetulan nunjuk ke endpoint (device) yang sama — ini yang bikin
    // notif "nyasar" ke akun lain yang pernah login di HP yang sama.
    if (endpoint) {
      await supabase
        .from('push_subscriptions')
        .delete()
        .contains('subscription', { endpoint });
    }
 
    res.json({ message: 'ok' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
// Kirim push notifikasi percobaan ke diri sendiri (untuk testing)
router.post('/test-push', async (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token diperlukan' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', decoded.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ message: 'Belum ada subscription tersimpan. Login ulang dulu di HP dan pastikan izin notifikasi sudah diberikan.' });
    }

    await webpush.sendNotification(
      data.subscription,
      JSON.stringify({
        title: '🔔 Tes Notifikasi',
        body: 'Kalau ini muncul di HP kamu, berarti push notification berhasil!',
        url: '/'
      })
    );

    res.json({ message: 'Notifikasi tes berhasil dikirim. Cek HP kamu.' });
  } catch (e) {
    // Subscription expired/invalid biasanya balikin statusCode 410 dari web-push
    if (e.statusCode === 410 || e.statusCode === 404) {
      return res.status(410).json({ message: 'Subscription sudah tidak valid/expired. Login ulang di HP untuk subscribe lagi.' });
    }
    res.status(500).json({ message: 'Gagal kirim: ' + e.message });
  }
});
// ============================================================
// UPLOAD FOTO SANTRI
// ============================================================
router.post('/santri/:id/foto', verifyAdmin, async (req, res) => {
  try {
    const { foto_base64, mime_type } = req.body;
    if (!foto_base64) return res.status(400).json({ message: 'Foto tidak ada' });

    const ext = mime_type === 'image/png' ? 'png' : 'jpg';
    const fileName = `santri-${req.params.id}.${ext}`;
    const buffer = Buffer.from(foto_base64, 'base64');

    // Upload ke Supabase Storage
    const { error: uploadError } = await supabaseAdmin.storage
      .from('foto-santri')
      .upload(fileName, buffer, {
        contentType: mime_type || 'image/jpeg',
        upsert: true
      });

    if (uploadError) return res.status(500).json({ message: uploadError.message });

    // Ambil public URL
    const { data } = supabaseAdmin.storage
      .from('foto-santri')
      .getPublicUrl(fileName);

    const foto_url = data.publicUrl;

    // Simpan URL ke tabel users
    await supabase.from('users').update({ foto_url }).eq('id', req.params.id);

    res.json({ message: 'Foto berhasil diupload', foto_url });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
// ============================================================
// UPLOAD FOTO SANTRI
// ============================================================
router.post('/santri/:id/foto', verifyAdmin, async (req, res) => {
  try {
    const { foto_base64, mime_type } = req.body;
    if (!foto_base64) return res.status(400).json({ message: 'Foto tidak ada' });

    const ext = mime_type === 'image/png' ? 'png' : 'jpg';
    const fileName = `santri-${req.params.id}.${ext}`;
    const buffer = Buffer.from(foto_base64, 'base64');

    const { error: uploadError } = await supabaseAdmin.storage
      .from('foto-santri')
      .upload(fileName, buffer, {
        contentType: mime_type || 'image/jpeg',
        upsert: true
      });

    if (uploadError) return res.status(500).json({ message: uploadError.message });

    const { data } = supabaseAdmin.storage
      .from('foto-santri')
      .getPublicUrl(fileName);

    const foto_url = data.publicUrl;

    await supabase.from('users').update({ foto_url }).eq('id', req.params.id);

    res.json({ message: 'Foto berhasil diupload', foto_url });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
module.exports = router;
module.exports.kirimPengingatSemua = kirimPengingatSemua;
