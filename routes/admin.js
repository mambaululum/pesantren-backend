const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

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
  try {
    const { username, password } = req.body;
    const result = await db.query('SELECT * FROM admins WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ message: 'Username tidak ditemukan' });
    const admin = result.rows[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(401).json({ message: 'Password salah' });
    const token = jwt.sign({ id: admin.id, isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, admin: { id: admin.id, nama: admin.nama } });
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
    const result = await db.query(`
      SELECT u.*,
        COALESCE((SELECT SUM(jumlah) FROM tagihan WHERE user_id=u.id), 0) as total_tagihan,
        COALESCE(
          (SELECT SUM(p.jumlah_bayar) FROM pembayaran p JOIN tagihan t ON p.tagihan_id=t.id WHERE t.user_id=u.id), 0
        ) +
        COALESCE(
          (SELECT SUM(t2.jumlah) FROM tagihan t2 WHERE t2.user_id=u.id AND t2.status='lunas'
           AND t2.id NOT IN (SELECT DISTINCT tagihan_id FROM pembayaran)), 0
        ) as sudah_bayar
      FROM users u ORDER BY u.nama_siswa
    `);
    res.json(result.rows);
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
    const result = await db.query(
      'INSERT INTO users (username, password, nama, nama_siswa, kelas, no_hp) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [username, hash, nama, nama_siswa, kelas, no_hp || '']
    );
    res.json({ message: 'Santri berhasil ditambahkan', id: result.rows[0].id });
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
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query(
        'UPDATE users SET nama=$1, nama_siswa=$2, kelas=$3, password=$4, no_hp=$5 WHERE id=$6',
        [nama, nama_siswa, kelas, hash, no_hp || '', req.params.id]
      );
    } else {
      await db.query(
        'UPDATE users SET nama=$1, nama_siswa=$2, kelas=$3, no_hp=$4 WHERE id=$5',
        [nama, nama_siswa, kelas, no_hp || '', req.params.id]
      );
    }
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
    await db.query('DELETE FROM pembayaran WHERE tagihan_id IN (SELECT id FROM tagihan WHERE user_id=$1)', [req.params.id]);
    await db.query('DELETE FROM tagihan WHERE user_id=$1', [req.params.id]);
    await db.query('DELETE FROM users WHERE id=$1', [req.params.id]);
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
    const result = await db.query(`
      SELECT t.*,
        COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
      FROM tagihan t WHERE t.user_id=$1 ORDER BY t.id
    `, [req.params.userId]);
    res.json(result.rows);
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
    const result = await db.query(
      'INSERT INTO tagihan (user_id, jenis, jumlah, tanggal_bayar, status, semester) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [user_id, jenis, Math.round(Number(jumlah)), tanggal_bayar || null, status || 'belum', semester || null]
    );
    res.json({ message: 'Tagihan berhasil ditambahkan', id: result.rows[0].id });

    // Notifikasi WA
    if ((status || 'belum') === 'belum' && kirim_notif !== false) {
      try {
        const uResult = await db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=$1', [user_id]);
        if (uResult.rows.length && uResult.rows[0].no_hp) {
          const u = uResult.rows[0];
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

    const oldResult = await db.query('SELECT status, user_id FROM tagihan WHERE id=$1', [req.params.id]);
    if (!oldResult.rows.length) return res.status(404).json({ message: 'Tagihan tidak ditemukan' });
    const { status: statusLama, user_id } = oldResult.rows[0];

    await db.query(
      'UPDATE tagihan SET jenis=$1, jumlah=$2, tanggal_bayar=$3, status=$4, semester=$5 WHERE id=$6',
      [jenis, jumlah, tanggal_bayar || null, status, semester || null, req.params.id]
    );
    res.json({ message: 'Tagihan berhasil diupdate' });

    // Kirim notifikasi WA jika baru ditandai lunas
    if (statusLama === 'belum' && status === 'lunas' && user_id && kirim_notif !== false) {
      try {
        const uResult = await db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=$1', [user_id]);
        if (uResult.rows.length && uResult.rows[0].no_hp) {
          const u = uResult.rows[0];
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
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// HAPUS TAGIHAN
// ============================================================
router.delete('/tagihan/:id', verifyAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM pembayaran WHERE tagihan_id=$1', [req.params.id]);
    await db.query('DELETE FROM tagihan WHERE id=$1', [req.params.id]);
    res.json({ message: 'Tagihan berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// INPUT PEMBAYARAN / CICILAN + NOTIFIKASI WA
// ============================================================

// Helper: hitung total kekurangan semua tagihan santri
const getTotalKekurangan = async (uid) => {
  const result = await db.query(`
    SELECT COALESCE(SUM(
      CASE
        WHEN t.status = 'lunas' THEN 0
        ELSE GREATEST(0, t.jumlah - COALESCE(
          (SELECT SUM(p2.jumlah_bayar) FROM pembayaran p2 WHERE p2.tagihan_id = t.id), 0
        ))
      END
    ), 0) as total_kekurangan
    FROM tagihan t WHERE t.user_id = $1
  `, [uid]);
  return Math.max(0, Math.round(Number(result.rows[0].total_kekurangan)));
};

router.post('/pembayaran', verifyAdmin, async (req, res) => {
  try {
    const { tagihan_id, jumlah_bayar, tanggal_bayar, keterangan } = req.body;

    await db.query(
      'INSERT INTO pembayaran (tagihan_id, jumlah_bayar, tanggal_bayar, keterangan) VALUES ($1,$2,$3,$4)',
      [tagihan_id, jumlah_bayar, tanggal_bayar, keterangan || '']
    );

    const tResult = await db.query(`
      SELECT t.jumlah, t.jenis, t.user_id,
        COALESCE(SUM(p.jumlah_bayar),0) as total_bayar
      FROM tagihan t LEFT JOIN pembayaran p ON p.tagihan_id=t.id
      WHERE t.id=$1 GROUP BY t.id, t.jumlah, t.jenis, t.user_id
    `, [tagihan_id]);

    const { jumlah, jenis, user_id, total_bayar } = tResult.rows[0];
    const sisa = Math.round(jumlah - total_bayar);

    if (Number(total_bayar) >= Number(jumlah)) {
      // LUNAS
      await db.query("UPDATE tagihan SET status='lunas', tanggal_bayar=$1 WHERE id=$2", [tanggal_bayar, tagihan_id]);
      res.json({ message: 'Pembayaran berhasil, tagihan LUNAS!', lunas: true });

      // Notifikasi WA lunas
      try {
        const uResult = await db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=$1', [user_id]);
        if (uResult.rows.length && uResult.rows[0].no_hp) {
          const u = uResult.rows[0];
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
      } catch (e) { console.log('WA error:', e.message); }

    } else {
      // CICILAN
      res.json({ message: `Pembayaran dicatat. Sisa: Rp ${sisa.toLocaleString('id-ID')}`, lunas: false, sisa });

      // Notifikasi WA cicilan
      setTimeout(async () => {
        try {
          const uResult = await db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=$1', [user_id]);
          if (uResult.rows.length && uResult.rows[0].no_hp) {
            const u = uResult.rows[0];
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
        } catch (e) { console.log('WA error:', e.message); }
      }, 500);
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
    const result = await db.query(
      'SELECT * FROM pembayaran WHERE tagihan_id=$1 ORDER BY tanggal_bayar',
      [req.params.tagihanId]
    );
    res.json(result.rows);
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
    await db.query(
      'UPDATE pembayaran SET jumlah_bayar=$1, tanggal_bayar=$2, keterangan=$3 WHERE id=$4',
      [jumlah_bayar, tanggal_bayar, keterangan || '', req.params.id]
    );

    const pResult = await db.query('SELECT tagihan_id FROM pembayaran WHERE id=$1', [req.params.id]);
    if (!pResult.rows.length) return res.json({ message: 'Cicilan berhasil diupdate' });

    const tagihan_id = pResult.rows[0].tagihan_id;
    const tResult = await db.query(`
      SELECT t.jumlah, COALESCE(SUM(p.jumlah_bayar),0) as total_bayar
      FROM tagihan t LEFT JOIN pembayaran p ON p.tagihan_id=t.id
      WHERE t.id=$1 GROUP BY t.id, t.jumlah
    `, [tagihan_id]);

    if (tResult.rows.length) {
      const { jumlah, total_bayar } = tResult.rows[0];
      const status = Number(total_bayar) >= Number(jumlah) ? 'lunas' : 'belum';
      const tgl = status === 'lunas' ? tanggal_bayar : null;
      await db.query('UPDATE tagihan SET status=$1, tanggal_bayar=$2 WHERE id=$3', [status, tgl, tagihan_id]);
      res.json({ message: 'Cicilan berhasil diupdate', lunas: status === 'lunas' });
    } else {
      res.json({ message: 'Cicilan berhasil diupdate' });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// HAPUS CICILAN
// ============================================================
router.delete('/pembayaran/:id', verifyAdmin, async (req, res) => {
  try {
    const pResult = await db.query('SELECT tagihan_id FROM pembayaran WHERE id=$1', [req.params.id]);
    if (!pResult.rows.length) return res.status(404).json({ message: 'Tidak ditemukan' });

    const tagihan_id = pResult.rows[0].tagihan_id;
    await db.query('DELETE FROM pembayaran WHERE id=$1', [req.params.id]);

    const tResult = await db.query(`
      SELECT t.jumlah, COALESCE(SUM(p.jumlah_bayar),0) AS total_bayar, MAX(p.tanggal_bayar) AS last_tgl
      FROM tagihan t LEFT JOIN pembayaran p ON p.tagihan_id=t.id
      WHERE t.id=$1 GROUP BY t.id, t.jumlah
    `, [tagihan_id]);

    if (tResult.rows.length) {
      const { jumlah, total_bayar, last_tgl } = tResult.rows[0];
      const status = Number(total_bayar) >= Number(jumlah) ? 'lunas' : 'belum';
      const tgl = status === 'lunas' ? last_tgl : null;
      await db.query('UPDATE tagihan SET status=$1, tanggal_bayar=$2 WHERE id=$3', [status, tgl, tagihan_id]);
    }
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

    // Pastikan tabel ada (PostgreSQL syntax)
    await db.query(`CREATE TABLE IF NOT EXISTS arsip_semester (
      id SERIAL PRIMARY KEY,
      nama_arsip VARCHAR(255) NOT NULL,
      keterangan TEXT,
      tanggal_arsip DATE,
      total_tagihan BIGINT DEFAULT 0,
      total_dibayar BIGINT DEFAULT 0,
      jumlah_santri INT DEFAULT 0,
      data_snapshot TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    const rows = await db.query(`
      SELECT u.id as user_id, u.nama_siswa, u.kelas,
        t.id as tagihan_id, t.jenis, t.jumlah, t.semester, t.status,
        COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dibayar
      FROM tagihan t JOIN users u ON t.user_id = u.id
      ORDER BY u.nama_siswa, t.semester, t.id
    `);

    const payments = await db.query(`
      SELECT p.id, p.tagihan_id, p.jumlah_bayar, p.tanggal_bayar, p.keterangan
      FROM pembayaran p ORDER BY p.tagihan_id, p.tanggal_bayar
    `);

    const payMap = {};
    for (const p of payments.rows) {
      if (!payMap[p.tagihan_id]) payMap[p.tagihan_id] = [];
      payMap[p.tagihan_id].push({
        id: p.id, jumlah_bayar: Number(p.jumlah_bayar),
        tanggal_bayar: p.tanggal_bayar, keterangan: p.keterangan
      });
    }

    const map = {};
    for (const r of rows.rows) {
      if (!map[r.user_id]) map[r.user_id] = {
        user_id: r.user_id, nama_siswa: r.nama_siswa, kelas: r.kelas,
        tagihan: [], total_tagihan: 0, total_dibayar: 0
      };
      const sudah = Number(r.sudah_dibayar);
      const sisa = r.status === 'lunas' ? 0 : Math.round(Number(r.jumlah) - sudah);
      map[r.user_id].tagihan.push({
        tagihan_id: r.tagihan_id, jenis: r.jenis, jumlah: Number(r.jumlah),
        semester: r.semester || '-', status: r.status,
        sudah_dibayar: r.status === 'lunas' ? Number(r.jumlah) : sudah,
        sisa, riwayat_bayar: payMap[r.tagihan_id] || []
      });
      map[r.user_id].total_tagihan += Number(r.jumlah);
      map[r.user_id].total_dibayar += r.status === 'lunas' ? Number(r.jumlah) : sudah;
    }

    const snapshot = Object.values(map);
    const totalTagihan = snapshot.reduce((a, s) => a + s.total_tagihan, 0);
    const totalDibayar = snapshot.reduce((a, s) => a + s.total_dibayar, 0);
    const tanggal = new Date().toISOString().split('T')[0];

    const insertResult = await db.query(
      'INSERT INTO arsip_semester (nama_arsip, keterangan, tanggal_arsip, total_tagihan, total_dibayar, jumlah_santri, data_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [nama_arsip, keterangan || '', tanggal, totalTagihan, totalDibayar, snapshot.length, JSON.stringify(snapshot)]
    );
    res.json({ message: `Arsip "${nama_arsip}" berhasil disimpan!`, id: insertResult.rows[0].id, jumlah_santri: snapshot.length });
  } catch (err) {
    res.status(500).json({ message: 'Gagal simpan arsip: ' + err.message });
  }
});

// ============================================================
// GET DAFTAR ARSIP SEMESTER
// ============================================================
router.get('/semester/arsip', verifyAdmin, async (req, res) => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS arsip_semester (
      id SERIAL PRIMARY KEY,
      nama_arsip VARCHAR(255) NOT NULL,
      keterangan TEXT,
      tanggal_arsip DATE,
      total_tagihan BIGINT DEFAULT 0,
      total_dibayar BIGINT DEFAULT 0,
      jumlah_santri INT DEFAULT 0,
      data_snapshot TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    const result = await db.query(
      'SELECT id, nama_arsip, keterangan, tanggal_arsip, total_tagihan, total_dibayar, jumlah_santri, created_at FROM arsip_semester ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// GET DETAIL ARSIP
// ============================================================
router.get('/semester/arsip/:id', verifyAdmin, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM arsip_semester WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Arsip tidak ditemukan' });
    const arsip = result.rows[0];
    try { arsip.data_snapshot = JSON.parse(arsip.data_snapshot); } catch (e) { arsip.data_snapshot = []; }
    res.json(arsip);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// HAPUS ARSIP
// ============================================================
router.delete('/semester/arsip/:id', verifyAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM arsip_semester WHERE id=$1', [req.params.id]);
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

    const result = await db.query(
      'UPDATE tagihan SET semester = $1 WHERE semester = $2',
      [nama_baru.trim(), nama_lama.trim()]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: `Semester "${nama_lama}" tidak ditemukan` });
    res.json({ message: `Semester "${nama_lama}" berhasil diubah ke "${nama_baru}"`, jumlah_tagihan: result.rowCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// RESET TAGIHAN INDIVIDUAL
// ============================================================
router.post('/tagihan/:id/reset', verifyAdmin, async (req, res) => {
  try {
    const tagihanId = req.params.id;
    const check = await db.query('SELECT * FROM tagihan WHERE id=$1', [tagihanId]);
    if (!check.rows.length) return res.status(404).json({ message: 'Tagihan tidak ditemukan' });

    await db.query('DELETE FROM pembayaran WHERE tagihan_id=$1', [tagihanId]);
    await db.query("UPDATE tagihan SET status='belum', tanggal_bayar=NULL WHERE id=$1", [tagihanId]);
    res.json({ message: 'Tagihan berhasil direset ke belum bayar. Riwayat cicilan dihapus.' });
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
    let tagRows;
    if (semester) {
      tagRows = await db.query('SELECT id FROM tagihan WHERE semester = $1', [semester]);
    } else {
      tagRows = await db.query('SELECT id FROM tagihan');
    }

    if (!tagRows.rows.length) return res.status(400).json({ message: 'Tidak ada tagihan yang bisa direset' });

    const tagIds = tagRows.rows.map(r => r.id);
    await db.query(`DELETE FROM pembayaran WHERE tagihan_id = ANY($1::int[])`, [tagIds]);

    if (semester) {
      await db.query("UPDATE tagihan SET status='belum', tanggal_bayar=NULL WHERE semester = $1", [semester]);
    } else {
      await db.query("UPDATE tagihan SET status='belum', tanggal_bayar=NULL");
    }

    res.json({
      message: `Reset berhasil! ${tagIds.length} tagihan ${semester ? `semester "${semester}"` : 'semua semester'} direset ke status belum bayar.`,
      jumlah_tagihan: tagIds.length
    });
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

    // Insert satu per satu (PostgreSQL tidak support bulk VALUES ? seperti MySQL)
    for (const t of tagihan_baru) {
      await db.query(
        'INSERT INTO tagihan (user_id, jenis, jumlah, tanggal_bayar, status, semester) VALUES ($1,$2,$3,$4,$5,$6)',
        [t.user_id, t.jenis, Math.round(Number(t.jumlah)), null, 'belum', nama_semester]
      );
    }
    res.json({ message: `${tagihan_baru.length} tagihan semester baru berhasil ditambahkan!` });

    // Notifikasi WA per santri
    const userIds = [...new Set(tagihan_baru.map(t => t.user_id))];
    for (const uid of userIds) {
      try {
        const tagihanUser = tagihan_baru.filter(t => t.user_id === uid);
        const uResult = await db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=$1', [uid]);
        if (!uResult.rows.length || !uResult.rows[0].no_hp) continue;
        const u = uResult.rows[0];

        const tunggakan = await db.query(`
          SELECT t.jenis, t.jumlah, t.semester,
            COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
          FROM tagihan t
          WHERE t.user_id=$1 AND t.status='belum' AND t.semester != $2
          ORDER BY t.semester, t.id
        `, [uid, nama_semester]);

        const daftarBaru = tagihanUser.map(t => `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`).join('\n');
        const totalBaru = tagihanUser.reduce((a, b) => a + Math.round(Number(b.jumlah)), 0);

        let pesanTunggakan = '';
        let totalLama = 0;
        if (tunggakan.rows.length > 0) {
          const rincianLama = tunggakan.rows.map(t => {
            const sisa = Math.round(Number(t.jumlah) - Number(t.sudah_dicicil));
            totalLama += sisa;
            return Number(t.sudah_dicicil) > 0
              ? `• [${t.semester || '-'}] ${t.jenis}: Rp ${formatRp(t.jumlah)} (cicilan: Rp ${formatRp(t.sudah_dicicil)}, *sisa: Rp ${formatRp(sisa)}*)`
              : `• [${t.semester || '-'}] ${t.jenis}: *Rp ${formatRp(sisa)}*`;
          }).join('\n');
          pesanTunggakan =
            `\n⚠️ *Tunggakan Sebelumnya (Belum Lunas):*\n${rincianLama}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Total Tunggakan Lama: *Rp ${formatRp(totalLama)}*\n`;
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
          (totalLama > 0
            ? `💰 *Total Keseluruhan: Rp ${formatRp(grandTotal)}*\n`
            : `💰 *Total: Rp ${formatRp(totalBaru)}*\n`) +
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
    const result = await db.query(`
      SELECT u.id as user_id, u.nama_siswa, u.kelas, u.no_hp,
        t.id as tagihan_id, t.jenis, t.jumlah, t.status,
        COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
      FROM tagihan t JOIN users u ON t.user_id = u.id
      WHERE t.semester = $1 ORDER BY u.nama_siswa, t.id
    `, [req.params.nama]);

    const map = {};
    for (const r of result.rows) {
      if (!map[r.user_id]) map[r.user_id] = {
        user_id: r.user_id, nama_siswa: r.nama_siswa, kelas: r.kelas, no_hp: r.no_hp,
        tagihan: [], total_tagihan: 0, total_sudah_bayar: 0
      };
      const sudah = r.status === 'lunas' ? Number(r.jumlah) : Number(r.sudah_dicicil);
      const sisa = r.status === 'lunas' ? 0 : Math.round(Number(r.jumlah) - Number(r.sudah_dicicil));
      map[r.user_id].tagihan.push({ id: r.tagihan_id, jenis: r.jenis, jumlah: Number(r.jumlah), status: r.status, sudah_dicicil: sudah, sisa });
      map[r.user_id].total_tagihan += Number(r.jumlah);
      map[r.user_id].total_sudah_bayar += sudah;
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
    const result = await db.query(`
      SELECT u.id as user_id, u.nama_siswa, u.kelas,
        t.id as tagihan_id, t.jenis, t.jumlah, t.semester,
        COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
      FROM tagihan t JOIN users u ON t.user_id = u.id
      WHERE t.status = 'belum'
      ORDER BY u.nama_siswa, t.semester, t.id
    `);

    const map = {};
    for (const r of result.rows) {
      if (!map[r.user_id]) map[r.user_id] = { user_id: r.user_id, nama_siswa: r.nama_siswa, kelas: r.kelas, tagihan: [], total_tunggakan: 0 };
      const sisa = Math.round(Number(r.jumlah) - Number(r.sudah_dicicil));
      if (sisa > 0) {
        map[r.user_id].tagihan.push({ id: r.tagihan_id, jenis: r.jenis, jumlah: Number(r.jumlah), sudah_dicicil: Number(r.sudah_dicicil), sisa, semester: r.semester || '-' });
        map[r.user_id].total_tunggakan += sisa;
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
    const result = await db.query(`
      SELECT t.semester,
        COUNT(*) as jumlah_tagihan,
        COUNT(DISTINCT t.user_id) as jumlah_santri,
        SUM(t.jumlah) as total_tagihan,
        SUM(CASE WHEN t.status='lunas' THEN t.jumlah
                 ELSE COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id),0)
            END) as total_terbayar
      FROM tagihan t
      WHERE t.semester IS NOT NULL AND t.semester != ''
      GROUP BY t.semester ORDER BY t.semester DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// ============================================================
// JADWAL PENGINGAT OTOMATIS (in-memory)
// ============================================================
let jadwalPengingat = { aktif: false, tanggal: 1, jam: '08:00', intervalId: null };

const kirimPengingatSemua = async () => {
  const santriList = await db.query(`
    SELECT u.id, u.nama, u.nama_siswa, u.no_hp,
      COALESCE((
        SELECT SUM(CASE WHEN t.status='lunas' THEN 0
          ELSE GREATEST(0, t.jumlah - COALESCE(
            (SELECT SUM(p2.jumlah_bayar) FROM pembayaran p2 WHERE p2.tagihan_id=t.id), 0))
          END) FROM tagihan t WHERE t.user_id=u.id
      ), 0) as total_kekurangan
    FROM users u
    WHERE no_hp IS NOT NULL AND no_hp != ''
    HAVING COALESCE((
      SELECT SUM(CASE WHEN t.status='lunas' THEN 0
        ELSE GREATEST(0, t.jumlah - COALESCE(
          (SELECT SUM(p2.jumlah_bayar) FROM pembayaran p2 WHERE p2.tagihan_id=t.id), 0))
        END) FROM tagihan t WHERE t.user_id=u.id
    ), 0) > 0
    ORDER BY u.nama_siswa
  `);

  let terkirim = 0;
  for (const u of santriList.rows) {
    const sisa = Math.round(Number(u.total_kekurangan));
    if (sisa <= 0) continue;

    try {
      const tagihan = await db.query(`
        SELECT t.jenis, t.jumlah,
          COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
        FROM tagihan t WHERE t.user_id=$1 AND t.status='belum' ORDER BY t.id
      `, [u.id]);

      const rincian = tagihan.rows.map(t => {
        const sisaTagihan = Math.round(Number(t.jumlah) - Number(t.sudah_dicicil));
        const sudahCicil = Math.round(Number(t.sudah_dicicil));
        return sudahCicil > 0
          ? `• ${t.jenis}\n  Total: Rp ${formatRp(t.jumlah)} | Cicilan: Rp ${formatRp(sudahCicil)} | Sisa: *Rp ${formatRp(sisaTagihan)}*`
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

const aturJadwalOtomatis = () => {
  if (jadwalPengingat.intervalId) { clearInterval(jadwalPengingat.intervalId); jadwalPengingat.intervalId = null; }
  if (!jadwalPengingat.aktif) return;
  jadwalPengingat.intervalId = setInterval(() => {
    const now = new Date();
    const [jamSet, menitSet] = jadwalPengingat.jam.split(':').map(Number);
    if (now.getDate() === jadwalPengingat.tanggal && now.getHours() === jamSet && now.getMinutes() === menitSet) {
      console.log(`[JADWAL] Mengirim pengingat - ${now.toLocaleString('id-ID')}`);
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
  res.json({
    message: aktif ? `Jadwal aktif: setiap tanggal ${jadwalPengingat.tanggal} jam ${jadwalPengingat.jam}` : 'Jadwal otomatis dinonaktifkan',
    jadwal: { aktif: jadwalPengingat.aktif, tanggal: jadwalPengingat.tanggal, jam: jadwalPengingat.jam }
  });
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
    const uResult = await db.query(`
      SELECT u.id, u.nama, u.nama_siswa, u.no_hp,
        COALESCE((SELECT SUM(CASE WHEN t.status='lunas' THEN 0
          ELSE GREATEST(0, t.jumlah - COALESCE(
            (SELECT SUM(p2.jumlah_bayar) FROM pembayaran p2 WHERE p2.tagihan_id=t.id), 0))
          END) FROM tagihan t WHERE t.user_id=u.id), 0) as total_kekurangan
      FROM users u WHERE u.id=$1
    `, [req.params.userId]);

    if (!uResult.rows.length) return res.status(404).json({ message: 'Santri tidak ditemukan' });
    const u = uResult.rows[0];
    if (!u.no_hp) return res.status(400).json({ message: 'Santri belum punya nomor WA' });
    const sisa = Math.round(Number(u.total_kekurangan));
    if (sisa <= 0 || isNaN(sisa)) return res.status(400).json({ message: 'Santri tidak punya tunggakan' });

    const tagihan = await db.query(`
      SELECT t.jenis, t.jumlah,
        COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
      FROM tagihan t WHERE t.user_id=$1 AND t.status='belum' ORDER BY t.id
    `, [u.id]);

    const rincian = tagihan.rows.map(t => {
      const sisaTagihan = Math.round(Number(t.jumlah) - Number(t.sudah_dicicil));
      const sudahCicil = Math.round(Number(t.sudah_dicicil));
      return sudahCicil > 0
        ? `• ${t.jenis}\n  Total: Rp ${formatRp(t.jumlah)} | Cicilan: Rp ${formatRp(sudahCicil)} | Sisa: *Rp ${formatRp(sisaTagihan)}*`
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
router.get('/test-wa', async (req, res) => {
  const token = process.env.FONNTE_TOKEN;
  if (!token) return res.json({ status: 'error', message: 'FONNTE_TOKEN tidak ada di env' });
  
  try {
    const response = await fetch('https://api.fonnte.com/device', {
      method: 'GET',
      headers: { 'Authorization': token }
    });
    const text = await response.text();
    res.json({ status: 'ok', token_ada: true, token_preview: token.substring(0,10)+'...', fonnte_response: text });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});
module.exports = router;
