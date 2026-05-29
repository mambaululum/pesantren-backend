const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/db');

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

const kirimWA = async (nomor, pesan, meta = {}) => {
  if (!nomor || nomor.trim() === '') return;
  if (!process.env.FONNTE_TOKEN) {
    console.log('WA: FONNTE_TOKEN belum diisi di .env');
    return;
  }
  const nomorFormatted = formatNomor(nomor);
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
    const { data: users, error } = await supabase.from('users').select('*').order('nama_siswa');
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
    const { data, error } = await supabase.from('users').insert([{ username, password: hash, nama, nama_siswa, kelas, no_hp: no_hp || '' }]).select('id').single();
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
    const { nama, nama_siswa, kelas, password, no_hp } = req.body;
    const updateData = { nama, nama_siswa, kelas, no_hp: no_hp || '' };
    if (password) updateData.password = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('users').update(updateData).eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Data santri berhasil diupdate' });
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
    res.json({ message: 'Tagihan berhasil ditambahkan', id: data.id });

    if ((status || 'belum') === 'belum' && kirim_notif !== false) {
      try {
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', user_id).single();
        if (u && u.no_hp) {
          await kirimWA(u.no_hp,
            `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
            `📋 *Informasi Tagihan Baru*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Santri  : *${u.nama_siswa}*\n` +
            `Tagihan : *${jenis}*\n` +
            `Jumlah  : *Rp ${formatRp(jumlah)}*\n` +
            `Status  : ⏳ Belum Dibayar\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Mohon segera lakukan pembayaran.\n\n` +
            `_PP. Muhammadiyah Mambaul Ulum_\n` +
            `_Mojo - Andong - Boyolali_`
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
            `Terima kasih atas pembayarannya 🙏\n\n` +
            `_PP. Muhammadiyah Mambaul Ulum_\n` +
            `_Mojo - Andong - Boyolali_`
          );
        }
      } catch (e) { console.log('WA notif error:', e.message); }
    }

    const { error } = await supabase.from('tagihan').update({
      jenis, jumlah, tanggal_bayar: tanggal_bayar || null, status, semester: semester || null
    }).eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });

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
// INPUT PEMBAYARAN / CICILAN + NOTIFIKASI WA
// ============================================================
router.post('/pembayaran', verifyAdmin, async (req, res) => {
  try {
    const { tagihan_id, jumlah_bayar, tanggal_bayar, keterangan } = req.body;

    await supabase.from('pembayaran').insert([{ tagihan_id, jumlah_bayar, tanggal_bayar, keterangan: keterangan || '' }]);

    const { data: t } = await supabase.from('tagihan').select('jumlah, jenis, user_id').eq('id', tagihan_id).single();
    const { data: bayarList } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', tagihan_id);
    const total_bayar = bayarList ? bayarList.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
    const sisa = Math.round(Number(t.jumlah) - total_bayar);

    if (total_bayar >= Number(t.jumlah)) {
      await supabase.from('tagihan').update({ status: 'lunas', tanggal_bayar }).eq('id', tagihan_id);
      res.json({ message: 'Pembayaran berhasil, tagihan LUNAS!', lunas: true });

      try {
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', t.user_id).single();
        if (u && u.no_hp) {
          const totalKekurangan = await getTotalKekurangan(t.user_id);
          await kirimWA(u.no_hp,
            `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
            `✅ *Pembayaran Berhasil - LUNAS*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Santri  : *${u.nama_siswa}*\n` +
            `Tagihan : *${t.jenis}*\n` +
            `Dibayar : *Rp ${formatRp(jumlah_bayar)}*\n` +
            `Total   : *Rp ${formatRp(t.jumlah)}*\n` +
            `Tanggal : ${tanggal_bayar}\n` +
            `Status  : ✅ *LUNAS*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            (totalKekurangan > 0
              ? `⚠️ Masih ada kekurangan tagihan lain: *Rp ${formatRp(totalKekurangan)}*\n━━━━━━━━━━━━━━━━━━\n`
              : `🎉 Semua tagihan sudah lunas!\n━━━━━━━━━━━━━━━━━━\n`) +
            `Terima kasih atas pembayarannya 🙏\n\n` +
            `_PP. Muhammadiyah Mambaul Ulum_\n` +
            `_Mojo - Andong - Boyolali_`
          );
        }
      } catch (e) { console.log('WA error:', e.message); }

    } else {
      res.json({ message: `Pembayaran dicatat. Sisa: Rp ${sisa.toLocaleString('id-ID')}`, lunas: false, sisa });

      try {
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', t.user_id).single();
        if (u && u.no_hp) {
          const totalKekurangan = await getTotalKekurangan(t.user_id);
          await kirimWA(u.no_hp,
            `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
            `💰 *Pembayaran Diterima (Cicilan)*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Santri  : *${u.nama_siswa}*\n` +
            `Tagihan : *${t.jenis}*\n` +
            `Dibayar : *Rp ${formatRp(jumlah_bayar)}*\n` +
            `Sisa tagihan ini : ⚠️ *Rp ${formatRp(sisa)}*\n` +
            `Tanggal : ${tanggal_bayar}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💳 Total kekurangan semua tagihan: *Rp ${formatRp(totalKekurangan)}*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Mohon segera lunasi sisa pembayaran 🙏\n\n` +
            `_PP. Muhammadiyah Mambaul Ulum_\n` +
            `_Mojo - Andong - Boyolali_`
          );
        }
      } catch (e) { console.log('WA error:', e.message); }
    }
  } catch (err) {
    console.error('Pembayaran error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET RIWAYAT CICILAN PER TAGIHAN
// ============================================================
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
// HAPUS CICILAN
// ============================================================
router.delete('/pembayaran/:id', verifyAdmin, async (req, res) => {
  try {
    const { data: p } = await supabase.from('pembayaran').select('tagihan_id').eq('id', req.params.id).single();
    if (!p) return res.status(404).json({ message: 'Tidak ditemukan' });

    await supabase.from('pembayaran').delete().eq('id', req.params.id);

    const { data: t } = await supabase.from('tagihan').select('jumlah').eq('id', p.tagihan_id).single();
    const { data: bayarList } = await supabase.from('pembayaran').select('jumlah_bayar, tanggal_bayar').eq('tagihan_id', p.tagihan_id);
    const total_bayar = bayarList ? bayarList.reduce((a, b) => a + Number(b.jumlah_bayar), 0) : 0;
    const status = total_bayar >= Number(t.jumlah) ? 'lunas' : 'belum';
    const last_tgl = bayarList && bayarList.length ? bayarList[bayarList.length - 1].tanggal_bayar : null;
    await supabase.from('tagihan').update({ status, tanggal_bayar: status === 'lunas' ? last_tgl : null }).eq('id', p.tagihan_id);

    res.json({ message: 'Cicilan berhasil dihapus' });
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
// TAMBAH SEMESTER BARU + NOTIFIKASI WA
// ============================================================
router.post('/semester', verifyAdmin, async (req, res) => {
  try {
    const { nama_semester, tagihan_baru } = req.body;
    if (!tagihan_baru || tagihan_baru.length === 0) return res.status(400).json({ message: 'Data tagihan baru kosong' });

    const insertData = tagihan_baru.map(t => ({
      user_id: t.user_id, jenis: t.jenis, jumlah: Math.round(Number(t.jumlah)),
      tanggal_bayar: null, status: 'belum', semester: nama_semester
    }));
    await supabase.from('tagihan').insert(insertData);
    res.json({ message: `${tagihan_baru.length} tagihan semester baru berhasil ditambahkan!` });

    const userIds = [...new Set(tagihan_baru.map(t => t.user_id))];
    for (const uid of userIds) {
      try {
        const tagihanUser = tagihan_baru.filter(t => t.user_id === uid);
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', uid).single();
        if (!u || !u.no_hp) continue;

        const { data: tunggakan } = await supabase.from('tagihan').select('jenis, jumlah, semester, pembayaran(jumlah_bayar)').eq('user_id', uid).eq('status', 'belum').neq('semester', nama_semester);

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
          `_Mojo - Andong - Boyolali_`
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
        `Mohon segera lakukan pembayaran 🙏\n\n` +
        `_PP. Muhammadiyah Mambaul Ulum_\n` +
        `_Mojo - Andong - Boyolali_`
      );
      terkirim++;
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
      `Mohon segera lakukan pembayaran 🙏\n\n` +
      `_PP. Muhammadiyah Mambaul Ulum_\n` +
      `_Mojo - Andong - Boyolali_`
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
  const { no_hp, nama_wali, nama_siswa, jumlah_bayar, jumlah_tagihan, kelebihan, keterangan } = req.body;
  if (!no_hp) return res.status(400).json({ message: 'Nomor HP tidak ada' });

  const pesan =
    `Assalamu'alaikum Bapak/Ibu *${nama_wali}*,\n\n` +
    `✅ *Konfirmasi Pembayaran*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Santri       : *${nama_siswa}*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💰 Total Bayar   : *Rp ${formatRp(jumlah_bayar)}*\n` +
    `✅ Untuk Tagihan : *Rp ${formatRp(jumlah_tagihan)}* (Lunas)\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🎉 Sisa Uang     : *Rp ${formatRp(kelebihan)}*\n` +
    `📝 Ket           : ${keterangan}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Jazakumullahu khairan 🙏\n\n` +
    `_PP. Muhammadiyah Mambaul Ulum_\n` +
    `_Mojo - Andong - Boyolali_`;

  try {
    await kirimWA(no_hp, pesan);
    res.json({ message: 'Notifikasi WA berhasil dikirim' });
  } catch (e) {
    res.status(500).json({ message: 'Gagal kirim WA: ' + e.message });
  }
});
// ============================================================
// GET RIWAYAT NOTIFIKASI WA
// ============================================================
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

router.delete('/riwayat-wa', verifyAdmin, async (req, res) => {
  try {
    await supabase.from('riwayat_wa').delete().neq('id', 0);
    res.json({ message: 'Riwayat WA berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
module.exports = router;
