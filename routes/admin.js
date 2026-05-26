const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/db');

// ============================================================
// HELPER FORMAT RUPIAH (fix floating point)
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

const kirimWA = async (nomor, pesan) => {
  if (!nomor || nomor.trim() === '') return;
  if (!process.env.FONNTE_TOKEN) {
    console.log('WA: FONNTE_TOKEN belum diisi di .env');
    return;
  }
  const nomorFormatted = formatNomor(nomor);
  try {
    const response = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { 'Authorization': process.env.FONNTE_TOKEN },
      body: new URLSearchParams({ target: nomorFormatted, message: pesan })
    });
    const hasil = await response.json();
    console.log('WA kirim ke', nomorFormatted, ':', JSON.stringify(hasil));
    if (!hasil.status) console.log('WA gagal:', hasil.reason || hasil.message || '-');
  } catch (e) {
    console.log('WA error:', e.message);
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
// LOGIN ADMIN
// ============================================================
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { data: results, error } = await supabase
      .from('admins')
      .select('*')
      .eq('username', username)
      .limit(1);

    if (error) return res.status(500).json({ message: 'Server error' });
    if (!results || results.length === 0) return res.status(401).json({ message: 'Username tidak ditemukan' });

    const admin = results[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(401).json({ message: 'Password salah' });

    const token = jwt.sign({ id: admin.id, isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, admin: { id: admin.id, nama: admin.nama } });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// GET SEMUA SANTRI
// ============================================================
router.get('/santri', verifyAdmin, async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .order('nama_siswa');

    if (error) return res.status(500).json({ message: 'Server error' });

    // Hitung total_tagihan dan sudah_bayar per user
    const result = await Promise.all(users.map(async (u) => {
      const { data: tagihan } = await supabase
        .from('tagihan')
        .select('id, jumlah, status')
        .eq('user_id', u.id);

      const total_tagihan = tagihan ? tagihan.reduce((a, t) => a + Number(t.jumlah), 0) : 0;

      let sudah_bayar = 0;
      if (tagihan && tagihan.length > 0) {
        for (const t of tagihan) {
          if (t.status === 'lunas') {
            // Cek apakah ada cicilan, jika tidak pakai jumlah penuh
            const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
            const totalCicilan = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
            sudah_bayar += totalCicilan > 0 ? totalCicilan : Number(t.jumlah);
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
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// TAMBAH SANTRI
// ============================================================
router.post('/santri', verifyAdmin, async (req, res) => {
  const { username, password, nama, nama_siswa, kelas, no_hp } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('users')
      .insert({ username, password: hash, nama, nama_siswa, kelas, no_hp: no_hp || '' })
      .select()
      .single();

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
  const { nama, nama_siswa, kelas, password, no_hp } = req.body;
  try {
    let updateData = { nama, nama_siswa, kelas, no_hp: no_hp || '' };
    if (password) {
      updateData.password = await bcrypt.hash(password, 10);
    }
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
      const tagihanIds = tagihan.map(t => t.id);
      await supabase.from('pembayaran').delete().in('tagihan_id', tagihanIds);
      await supabase.from('tagihan').delete().eq('user_id', req.params.id);
    }
    const { error } = await supabase.from('users').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
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
    const { data: tagihan, error } = await supabase
      .from('tagihan')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('id');

    if (error) return res.status(500).json({ message: 'Server error' });

    const result = await Promise.all(tagihan.map(async (t) => {
      const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
      const sudah_dicicil = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
      return { ...t, sudah_dicicil };
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// TAMBAH TAGIHAN + NOTIFIKASI WA
// ============================================================
router.post('/tagihan', verifyAdmin, async (req, res) => {
  const { user_id, jenis, jumlah, tanggal_bayar, status, semester, kirim_notif } = req.body;
  try {
    const { data, error } = await supabase
      .from('tagihan')
      .insert({
        user_id, jenis,
        jumlah: Math.round(Number(jumlah)),
        tanggal_bayar: tanggal_bayar || null,
        status: status || 'belum',
        semester: semester || null
      })
      .select()
      .single();

    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Tagihan berhasil ditambahkan', id: data.id });

    if ((status || 'belum') === 'belum' && kirim_notif !== false) {
      const { data: rows } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', user_id).single();
      if (rows && rows.no_hp) {
        await kirimWA(rows.no_hp,
          `Assalamu'alaikum Bapak/Ibu *${rows.nama}*,\n\n` +
          `📋 *Informasi Tagihan Baru*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Santri  : *${rows.nama_siswa}*\n` +
          `Tagihan : *${jenis}*\n` +
          `Jumlah  : *Rp ${formatRp(jumlah)}*\n` +
          `Status  : ⏳ Belum Dibayar\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Mohon segera lakukan pembayaran.\n\n` +
          `_PP. Muhammadiyah Mambaul Ulum_\n` +
          `_Mojo - Andong - Boyolali_`
        );
      }
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// EDIT TAGIHAN + NOTIFIKASI WA jika ditandai lunas
// ============================================================
router.put('/tagihan/:id', verifyAdmin, async (req, res) => {
  const { jenis, jumlah, tanggal_bayar, status, semester, kirim_notif } = req.body;
  try {
    const { data: old } = await supabase.from('tagihan').select('status, user_id').eq('id', req.params.id).single();
    const statusLama = old?.status;
    const user_id = old?.user_id;

    const { error } = await supabase.from('tagihan')
      .update({ jenis, jumlah, tanggal_bayar: tanggal_bayar || null, status, semester: semester || null })
      .eq('id', req.params.id);

    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Tagihan berhasil diupdate' });

    if (statusLama === 'belum' && status === 'lunas' && user_id && kirim_notif !== false) {
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
    }
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
    const { error } = await supabase.from('tagihan').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Tagihan berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// INPUT PEMBAYARAN / CICILAN + NOTIFIKASI WA
// ============================================================
router.post('/pembayaran', verifyAdmin, async (req, res) => {
  const { tagihan_id, jumlah_bayar, tanggal_bayar, keterangan } = req.body;
  try {
    const { error } = await supabase.from('pembayaran')
      .insert({ tagihan_id, jumlah_bayar, tanggal_bayar, keterangan: keterangan || '' });
    if (error) return res.status(500).json({ message: error.message });

    const { data: tagihanData } = await supabase.from('tagihan').select('jumlah, jenis, user_id').eq('id', tagihan_id).single();
    const { data: semuaBayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', tagihan_id);

    const { jumlah, jenis, user_id } = tagihanData;
    const total_bayar = semuaBayar ? semuaBayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
    const sisa = Math.round(jumlah - total_bayar);

    const getTotalKekurangan = async (uid) => {
      const { data: semuaTagihan } = await supabase.from('tagihan').select('id, jumlah, status').eq('user_id', uid);
      let total = 0;
      for (const t of semuaTagihan || []) {
        if (t.status === 'lunas') continue;
        const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
        const dibayar = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
        total += Math.max(0, Number(t.jumlah) - dibayar);
      }
      return Math.round(total);
    };

    if (total_bayar >= jumlah) {
      await supabase.from('tagihan').update({ status: 'lunas', tanggal_bayar }).eq('id', tagihan_id);
      res.json({ message: 'Pembayaran berhasil, tagihan LUNAS!', lunas: true });

      const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', user_id).single();
      if (u && u.no_hp) {
        const totalKekurangan = await getTotalKekurangan(user_id);
        await kirimWA(u.no_hp,
          `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
          `✅ *Pembayaran Berhasil - LUNAS*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Santri  : *${u.nama_siswa}*\n` +
          `Tagihan : *${jenis}*\n` +
          `Dibayar : *Rp ${formatRp(jumlah_bayar)}*\n` +
          `Total   : *Rp ${formatRp(jumlah)}*\n` +
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
    } else {
      res.json({ message: `Pembayaran dicatat. Sisa: Rp ${sisa.toLocaleString('id-ID')}`, lunas: false, sisa });

      setTimeout(async () => {
        const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', user_id).single();
        if (u && u.no_hp) {
          const totalKekurangan = await getTotalKekurangan(user_id);
          await kirimWA(u.no_hp,
            `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
            `💰 *Pembayaran Diterima (Cicilan)*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Santri  : *${u.nama_siswa}*\n` +
            `Tagihan : *${jenis}*\n` +
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
      }, 500);
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET RIWAYAT CICILAN PER TAGIHAN
// ============================================================
router.get('/pembayaran/:tagihanId', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pembayaran')
      .select('*')
      .eq('tagihan_id', req.params.tagihanId)
      .order('tanggal_bayar');
    if (error) return res.status(500).json({ message: 'Server error' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EDIT CICILAN
// ============================================================
router.put('/pembayaran/:id', verifyAdmin, async (req, res) => {
  const { jumlah_bayar, tanggal_bayar, keterangan } = req.body;
  try {
    const { error } = await supabase.from('pembayaran')
      .update({ jumlah_bayar, tanggal_bayar, keterangan: keterangan || '' })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });

    const { data: pData } = await supabase.from('pembayaran').select('tagihan_id').eq('id', req.params.id).single();
    if (!pData) return res.json({ message: 'Cicilan berhasil diupdate' });

    const tagihan_id = pData.tagihan_id;
    const { data: t } = await supabase.from('tagihan').select('jumlah').eq('id', tagihan_id).single();
    const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', tagihan_id);
    const total_bayar = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
    const status = total_bayar >= Number(t.jumlah) ? 'lunas' : 'belum';
    const tgl = status === 'lunas' ? tanggal_bayar : null;

    await supabase.from('tagihan').update({ status, tanggal_bayar: tgl }).eq('id', tagihan_id);
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
    const { data: pData } = await supabase.from('pembayaran').select('tagihan_id').eq('id', req.params.id).single();
    if (!pData) return res.status(404).json({ message: 'Tidak ditemukan' });

    const tagihan_id = pData.tagihan_id;
    await supabase.from('pembayaran').delete().eq('id', req.params.id);

    const { data: t } = await supabase.from('tagihan').select('jumlah').eq('id', tagihan_id).single();
    const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar, tanggal_bayar').eq('tagihan_id', tagihan_id);
    const total_bayar = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
    const status = total_bayar >= Number(t.jumlah) ? 'lunas' : 'belum';
    const last_tgl = bayar && bayar.length > 0 ? bayar[bayar.length - 1].tanggal_bayar : null;
    const tgl = status === 'lunas' ? last_tgl : null;

    await supabase.from('tagihan').update({ status, tanggal_bayar: tgl }).eq('id', tagihan_id);
    res.json({ message: 'Cicilan berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// ARSIP SNAPSHOT SEMESTER
// ============================================================
router.post('/semester/arsip', verifyAdmin, async (req, res) => {
  const { nama_arsip, keterangan } = req.body;
  if (!nama_arsip) return res.status(400).json({ message: 'Nama arsip wajib diisi' });

  try {
    const { data: rows } = await supabase
      .from('tagihan')
      .select('id, jenis, jumlah, semester, status, user_id, users(nama_siswa, kelas)')
      .order('user_id');

    const { data: payments } = await supabase.from('pembayaran').select('*').order('tagihan_id');

    const payMap = {};
    for (const p of payments || []) {
      if (!payMap[p.tagihan_id]) payMap[p.tagihan_id] = [];
      payMap[p.tagihan_id].push({ id: p.id, jumlah_bayar: Number(p.jumlah_bayar), tanggal_bayar: p.tanggal_bayar, keterangan: p.keterangan });
    }

    const map = {};
    for (const r of rows || []) {
      const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', r.id);
      const sudah = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
      const sisa = r.status === 'lunas' ? 0 : Math.round(Number(r.jumlah) - sudah);

      if (!map[r.user_id]) map[r.user_id] = {
        user_id: r.user_id,
        nama_siswa: r.users?.nama_siswa,
        kelas: r.users?.kelas,
        tagihan: [], total_tagihan: 0, total_dibayar: 0
      };

      map[r.user_id].tagihan.push({
        tagihan_id: r.id, jenis: r.jenis, jumlah: Number(r.jumlah),
        semester: r.semester || '-', status: r.status,
        sudah_dibayar: r.status === 'lunas' ? Number(r.jumlah) : sudah,
        sisa, riwayat_bayar: payMap[r.id] || []
      });
      map[r.user_id].total_tagihan += Number(r.jumlah);
      map[r.user_id].total_dibayar += r.status === 'lunas' ? Number(r.jumlah) : sudah;
    }

    const snapshot = Object.values(map);
    const totalTagihan = snapshot.reduce((a, s) => a + s.total_tagihan, 0);
    const totalDibayar = snapshot.reduce((a, s) => a + s.total_dibayar, 0);
    const tanggal = new Date().toISOString().split('T')[0];

    const { data: arsip, error } = await supabase.from('arsip_semester')
      .insert({ nama_arsip, keterangan: keterangan || '', tanggal_arsip: tanggal, total_tagihan: totalTagihan, total_dibayar: totalDibayar, jumlah_santri: snapshot.length, data_snapshot: JSON.stringify(snapshot) })
      .select().single();

    if (error) return res.status(500).json({ message: 'Gagal simpan arsip: ' + error.message });
    res.json({ message: `Arsip "${nama_arsip}" berhasil disimpan!`, id: arsip.id, jumlah_santri: snapshot.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET DAFTAR ARSIP SEMESTER
// ============================================================
router.get('/semester/arsip', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('arsip_semester')
      .select('id, nama_arsip, keterangan, tanggal_arsip, total_tagihan, total_dibayar, jumlah_santri, created_at')
      .order('created_at', { ascending: false });
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
    const { error } = await supabase.from('arsip_semester').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Arsip berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// RENAME SEMESTER
// ============================================================
router.put('/semester/rename', verifyAdmin, async (req, res) => {
  const { nama_lama, nama_baru } = req.body;
  if (!nama_lama || !nama_baru) return res.status(400).json({ message: 'nama_lama dan nama_baru wajib diisi' });
  if (nama_lama.trim() === nama_baru.trim()) return res.status(400).json({ message: 'Nama baru sama dengan nama lama' });

  try {
    const { data, error } = await supabase.from('tagihan')
      .update({ semester: nama_baru.trim() })
      .eq('semester', nama_lama.trim())
      .select();
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
    const { data, error } = await supabase.from('tagihan').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ message: 'Tagihan tidak ditemukan' });
    await supabase.from('pembayaran').delete().eq('tagihan_id', req.params.id);
    await supabase.from('tagihan').update({ status: 'belum', tanggal_bayar: null }).eq('id', req.params.id);
    res.json({ message: 'Tagihan berhasil direset ke belum bayar. Riwayat cicilan dihapus.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// RESET SEMESTER
// ============================================================
router.post('/semester/reset', verifyAdmin, async (req, res) => {
  const { semester } = req.body;
  try {
    let query = supabase.from('tagihan').select('id');
    if (semester) query = query.eq('semester', semester);
    const { data: tagRows, error } = await query;
    if (error) return res.status(500).json({ message: error.message });
    if (!tagRows || tagRows.length === 0) return res.status(400).json({ message: 'Tidak ada tagihan yang bisa direset' });

    const tagIds = tagRows.map(r => r.id);
    await supabase.from('pembayaran').delete().in('tagihan_id', tagIds);

    let updateQuery = supabase.from('tagihan').update({ status: 'belum', tanggal_bayar: null });
    if (semester) updateQuery = updateQuery.eq('semester', semester);
    await updateQuery;

    res.json({ message: `Reset berhasil! ${tagIds.length} tagihan direset.`, jumlah_tagihan: tagIds.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// TAMBAH SEMESTER BARU + NOTIFIKASI WA
// ============================================================
router.post('/semester', verifyAdmin, async (req, res) => {
  const { nama_semester, tagihan_baru } = req.body;
  if (!tagihan_baru || tagihan_baru.length === 0) return res.status(400).json({ message: 'Data tagihan baru kosong' });

  try {
    const values = tagihan_baru.map(t => ({
      user_id: t.user_id, jenis: t.jenis,
      jumlah: Math.round(Number(t.jumlah)),
      tanggal_bayar: null, status: 'belum', semester: nama_semester
    }));

    const { data, error } = await supabase.from('tagihan').insert(values).select();
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: `${data.length} tagihan semester baru berhasil ditambahkan!` });

    const userIds = [...new Set(tagihan_baru.map(t => t.user_id))];
    for (const uid of userIds) {
      const tagihanUser = tagihan_baru.filter(t => t.user_id === uid);
      const { data: u } = await supabase.from('users').select('nama, nama_siswa, no_hp').eq('id', uid).single();
      if (!u || !u.no_hp) continue;

      const { data: tunggakanLama } = await supabase.from('tagihan')
        .select('jenis, jumlah, semester')
        .eq('user_id', uid)
        .eq('status', 'belum')
        .neq('semester', nama_semester);

      const daftarBaru = tagihanUser.map(t => `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`).join('\n');
      const totalBaru = tagihanUser.reduce((a, b) => a + Math.round(Number(b.jumlah)), 0);

      let pesanTunggakan = '';
      let totalLama = 0;
      if (tunggakanLama && tunggakanLama.length > 0) {
        const rincianLama = await Promise.all(tunggakanLama.map(async t => {
          const { data: bayar } = await supabase.from('pembayaran')
            .select('jumlah_bayar')
            .eq('tagihan_id', (await supabase.from('tagihan').select('id').eq('user_id', uid).eq('jenis', t.jenis).eq('semester', t.semester).single()).data?.id);
          const sudahCicil = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
          const sisa = Math.round(Number(t.jumlah) - sudahCicil);
          totalLama += sisa;
          return sudahCicil > 0
            ? `• [${t.semester || '-'}] ${t.jenis}: Rp ${formatRp(t.jumlah)} (cicilan: Rp ${formatRp(sudahCicil)}, *sisa: Rp ${formatRp(sisa)}*)`
            : `• [${t.semester || '-'}] ${t.jenis}: *Rp ${formatRp(sisa)}*`;
        }));
        pesanTunggakan = `\n⚠️ *Tunggakan Sebelumnya (Belum Lunas):*\n${rincianLama.join('\n')}\n` +
          `━━━━━━━━━━━━━━━━━━\nTotal Tunggakan Lama: *Rp ${formatRp(totalLama)}*\n`;
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
    const { data: rows } = await supabase
      .from('tagihan')
      .select('id, jenis, jumlah, status, user_id, users(nama_siswa, kelas, no_hp)')
      .eq('semester', req.params.nama)
      .order('user_id');

    const map = {};
    for (const r of rows || []) {
      const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', r.id);
      const sudah_dicicil = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
      const sudah = r.status === 'lunas' ? Number(r.jumlah) : sudah_dicicil;
      const sisa = r.status === 'lunas' ? 0 : Math.round(Number(r.jumlah) - sudah_dicicil);

      if (!map[r.user_id]) map[r.user_id] = {
        user_id: r.user_id, nama_siswa: r.users?.nama_siswa,
        kelas: r.users?.kelas, no_hp: r.users?.no_hp,
        tagihan: [], total_tagihan: 0, total_sudah_bayar: 0
      };
      map[r.user_id].tagihan.push({ id: r.id, jenis: r.jenis, jumlah: Number(r.jumlah), status: r.status, sudah_dicicil: sudah, sisa });
      map[r.user_id].total_tagihan += Number(r.jumlah);
      map[r.user_id].total_sudah_bayar += sudah;
    }
    res.json(Object.values(map));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// GET TUNGGAKAN LAMA PER SANTRI
// ============================================================
router.get('/tunggakan-per-santri', verifyAdmin, async (req, res) => {
  try {
    const { data: rows } = await supabase
      .from('tagihan')
      .select('id, jenis, jumlah, semester, user_id, users(nama_siswa, kelas)')
      .eq('status', 'belum')
      .order('user_id');

    const map = {};
    for (const r of rows || []) {
      const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', r.id);
      const sudah_dicicil = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
      const sisa = Math.round(Number(r.jumlah) - sudah_dicicil);
      if (sisa <= 0) continue;
      if (!map[r.user_id]) map[r.user_id] = { user_id: r.user_id, nama_siswa: r.users?.nama_siswa, kelas: r.users?.kelas, tagihan: [], total_tunggakan: 0 };
      map[r.user_id].tagihan.push({ id: r.id, jenis: r.jenis, jumlah: Number(r.jumlah), sudah_dicicil, sisa, semester: r.semester || '-' });
      map[r.user_id].total_tunggakan += sisa;
    }
    res.json(Object.values(map));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// GET DAFTAR SEMESTER (dengan statistik)
// ============================================================
router.get('/semester', verifyAdmin, async (req, res) => {
  try {
    const { data: tagihan } = await supabase
      .from('tagihan')
      .select('id, semester, jumlah, status, user_id')
      .not('semester', 'is', null)
      .neq('semester', '');

    const map = {};
    for (const t of tagihan || []) {
      if (!map[t.semester]) map[t.semester] = { semester: t.semester, jumlah_tagihan: 0, santri: new Set(), total_tagihan: 0, total_terbayar: 0 };
      map[t.semester].jumlah_tagihan++;
      map[t.semester].santri.add(t.user_id);
      map[t.semester].total_tagihan += Number(t.jumlah);

      if (t.status === 'lunas') {
        map[t.semester].total_terbayar += Number(t.jumlah);
      } else {
        const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
        map[t.semester].total_terbayar += bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
      }
    }

    const result = Object.values(map).map(s => ({ ...s, jumlah_santri: s.santri.size, santri: undefined }));
    result.sort((a, b) => b.semester.localeCompare(a.semester));
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// JADWAL OTOMATIS (simpan di memory)
// ============================================================
let jadwalPengingat = { aktif: false, tanggal: 1, jam: "08:00", intervalId: null };

const kirimPengingatSemua = async () => {
  const { data: users } = await supabase.from('users').select('id, nama, nama_siswa, no_hp');
  let terkirim = 0;
  for (const u of users || []) {
    if (!u.no_hp) continue;
    const { data: tagihan } = await supabase.from('tagihan').select('id, jumlah, jenis').eq('user_id', u.id).eq('status', 'belum');
    if (!tagihan || tagihan.length === 0) continue;

    let total_kekurangan = 0;
    const rincianArr = [];
    for (const t of tagihan) {
      const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
      const sudah = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
      const sisa = Math.round(Number(t.jumlah) - sudah);
      if (sisa <= 0) continue;
      total_kekurangan += sisa;
      rincianArr.push(sudah > 0
        ? `• ${t.jenis}\n  Total: Rp ${formatRp(t.jumlah)} | Cicilan: Rp ${formatRp(sudah)} | Sisa: *Rp ${formatRp(sisa)}*`
        : `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`);
    }
    if (total_kekurangan <= 0) continue;

    await kirimWA(u.no_hp,
      `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
      `🔔 *Pengingat Tagihan - PP. Mambaul Ulum*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Santri : *${u.nama_siswa}*\n\n` +
      `📋 Tagihan yang belum lunas:\n${rincianArr.join('\n')}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💰 Total Kekurangan: *Rp ${total_kekurangan.toLocaleString('id-ID')}*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Mohon segera lakukan pembayaran 🙏\n\n` +
      `_PP. Muhammadiyah Mambaul Ulum_\n` +
      `_Mojo - Andong - Boyolali_`
    );
    terkirim++;
  }
  return terkirim;
};

const aturJadwalOtomatis = () => {
  if (jadwalPengingat.intervalId) { clearInterval(jadwalPengingat.intervalId); jadwalPengingat.intervalId = null; }
  if (!jadwalPengingat.aktif) return;
  jadwalPengingat.intervalId = setInterval(() => {
    const now = new Date();
    const [jamSet, menitSet] = jadwalPengingat.jam.split(':').map(Number);
    if (now.getDate() === jadwalPengingat.tanggal && now.getHours() === jamSet && now.getMinutes() === menitSet) {
      kirimPengingatSemua().then(n => console.log(`[JADWAL] Terkirim ke ${n} wali`));
    }
  }, 60000);
};

router.get('/pengingat/jadwal', verifyAdmin, (req, res) => {
  res.json({ aktif: jadwalPengingat.aktif, tanggal: jadwalPengingat.tanggal, jam: jadwalPengingat.jam });
});

router.post('/pengingat/jadwal', verifyAdmin, (req, res) => {
  const { aktif, tanggal, jam } = req.body;
  jadwalPengingat.aktif = aktif;
  jadwalPengingat.tanggal = Number(tanggal) || 1;
  jadwalPengingat.jam = jam || '08:00';
  aturJadwalOtomatis();
  res.json({ message: aktif ? `Jadwal aktif: setiap tanggal ${jadwalPengingat.tanggal} jam ${jadwalPengingat.jam}` : 'Jadwal otomatis dinonaktifkan', jadwal: { aktif: jadwalPengingat.aktif, tanggal: jadwalPengingat.tanggal, jam: jadwalPengingat.jam } });
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

    const { data: tagihan } = await supabase.from('tagihan').select('id, jumlah, jenis').eq('user_id', u.id).eq('status', 'belum');
    let total_kekurangan = 0;
    const rincianArr = [];
    for (const t of tagihan || []) {
      const { data: bayar } = await supabase.from('pembayaran').select('jumlah_bayar').eq('tagihan_id', t.id);
      const sudah = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
      const sisa = Math.round(Number(t.jumlah) - sudah);
      if (sisa <= 0) continue;
      total_kekurangan += sisa;
      rincianArr.push(sudah > 0
        ? `• ${t.jenis}\n  Total: Rp ${formatRp(t.jumlah)} | Cicilan: Rp ${formatRp(sudah)} | Sisa: *Rp ${formatRp(sisa)}*`
        : `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`);
    }
    if (total_kekurangan <= 0) return res.status(400).json({ message: 'Santri tidak punya tunggakan' });

    await kirimWA(u.no_hp,
      `Assalamu'alaikum Bapak/Ibu *${u.nama}*,\n\n` +
      `🔔 *Pengingat Tagihan - PP. Mambaul Ulum*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Santri : *${u.nama_siswa}*\n\n` +
      `📋 Tagihan yang belum lunas:\n${rincianArr.join('\n')}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `💰 Total Kekurangan: *Rp ${total_kekurangan.toLocaleString('id-ID')}*\n` +
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

module.exports = router;
