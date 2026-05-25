const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

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
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.query('SELECT * FROM admins WHERE username = ?', [username], async (err, results) => {
    if (err) return res.status(500).json({ message: 'Server error' });
    if (results.length === 0) return res.status(401).json({ message: 'Username tidak ditemukan' });
    const admin = results[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(401).json({ message: 'Password salah' });
    const token = jwt.sign({ id: admin.id, isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, admin: { id: admin.id, nama: admin.nama } });
  });
});

// ============================================================
// GET SEMUA SANTRI
// ============================================================
router.get('/santri', verifyAdmin, (req, res) => {
  db.query(`
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
  `, (err, results) => {
    if (err) return res.status(500).json({ message: 'Server error' });
    res.json(results);
  });
});

// ============================================================
// TAMBAH SANTRI
// ============================================================
router.post('/santri', verifyAdmin, async (req, res) => {
  const { username, password, nama, nama_siswa, kelas, no_hp } = req.body;
  const hash = await bcrypt.hash(password, 10);
  db.query('INSERT INTO users (username, password, nama, nama_siswa, kelas, no_hp) VALUES (?,?,?,?,?,?)',
    [username, hash, nama, nama_siswa, kelas, no_hp || ''], (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      res.json({ message: 'Santri berhasil ditambahkan', id: result.insertId });
    });
});

// ============================================================
// EDIT SANTRI
// ============================================================
router.put('/santri/:id', verifyAdmin, async (req, res) => {
  const { nama, nama_siswa, kelas, password, no_hp } = req.body;
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.query('UPDATE users SET nama=?, nama_siswa=?, kelas=?, password=?, no_hp=? WHERE id=?',
      [nama, nama_siswa, kelas, hash, no_hp || '', req.params.id], (err) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json({ message: 'Data santri berhasil diupdate' });
      });
  } else {
    db.query('UPDATE users SET nama=?, nama_siswa=?, kelas=?, no_hp=? WHERE id=?',
      [nama, nama_siswa, kelas, no_hp || '', req.params.id], (err) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json({ message: 'Data santri berhasil diupdate' });
      });
  }
});

// ============================================================
// HAPUS SANTRI
// ============================================================
router.delete('/santri/:id', verifyAdmin, (req, res) => {
  db.query('DELETE FROM pembayaran WHERE tagihan_id IN (SELECT id FROM tagihan WHERE user_id=?)', [req.params.id], (err) => {
    if (err) return res.status(500).json({ message: err.message });
    db.query('DELETE FROM tagihan WHERE user_id=?', [req.params.id], (err) => {
      if (err) return res.status(500).json({ message: err.message });
      db.query('DELETE FROM users WHERE id=?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json({ message: 'Santri berhasil dihapus' });
      });
    });
  });
});

// ============================================================
// GET TAGIHAN PER SANTRI
// ============================================================
router.get('/tagihan/:userId', verifyAdmin, (req, res) => {
  db.query(`
    SELECT t.*,
    COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
    FROM tagihan t WHERE t.user_id=? ORDER BY t.id
  `, [req.params.userId], (err, results) => {
    if (err) return res.status(500).json({ message: 'Server error' });
    res.json(results);
  });
});

// ============================================================
// TAMBAH TAGIHAN + NOTIFIKASI WA
// ============================================================
router.post('/tagihan', verifyAdmin, (req, res) => {
  const { user_id, jenis, jumlah, tanggal_bayar, status, semester, kirim_notif } = req.body;
  db.query('INSERT INTO tagihan (user_id, jenis, jumlah, tanggal_bayar, status, semester) VALUES (?,?,?,?,?,?)',
    [user_id, jenis, Math.round(Number(jumlah)), tanggal_bayar || null, status || 'belum', semester || null], (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      res.json({ message: 'Tagihan berhasil ditambahkan', id: result.insertId });

      // Notifikasi WA tagihan baru — hanya jika kirim_notif !== false DAN status belum
      if ((status || 'belum') === 'belum' && kirim_notif !== false) {
        db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=?', [user_id], async (e, rows) => {
          if (e || !rows.length || !rows[0].no_hp) return;
          const u = rows[0];
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
        });
      }
    });
});

// ============================================================
// EDIT TAGIHAN + NOTIFIKASI WA jika ditandai lunas
// ============================================================
router.put('/tagihan/:id', verifyAdmin, (req, res) => {
  const { jenis, jumlah, tanggal_bayar, status, semester, kirim_notif } = req.body;

  // Cek status lama dulu sebelum update
  db.query('SELECT status, user_id FROM tagihan WHERE id=?', [req.params.id], (err0, old) => {
    if (err0) return res.status(500).json({ message: err0.message });
    const statusLama = old[0]?.status;
    const user_id = old[0]?.user_id;

    db.query('UPDATE tagihan SET jenis=?, jumlah=?, tanggal_bayar=?, status=?, semester=? WHERE id=?',
      [jenis, jumlah, tanggal_bayar || null, status, semester || null, req.params.id], (err) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json({ message: 'Tagihan berhasil diupdate' });

        // Kirim notifikasi WA jika baru ditandai lunas & kirim_notif tidak false
        if (statusLama === 'belum' && status === 'lunas' && user_id && kirim_notif !== false) {
          db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=?', [user_id], async (e, rows) => {
            if (e || !rows.length || !rows[0].no_hp) return;
            const u = rows[0];
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
          });
        }
      });
  });
});

// ============================================================
// HAPUS TAGIHAN
// ============================================================
router.delete('/tagihan/:id', verifyAdmin, (req, res) => {
  db.query('DELETE FROM pembayaran WHERE tagihan_id=?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ message: err.message });
    db.query('DELETE FROM tagihan WHERE id=?', [req.params.id], (err) => {
      if (err) return res.status(500).json({ message: err.message });
      res.json({ message: 'Tagihan berhasil dihapus' });
    });
  });
});

// ============================================================
// INPUT PEMBAYARAN / CICILAN + NOTIFIKASI WA
// ============================================================
router.post('/pembayaran', verifyAdmin, (req, res) => {
  const { tagihan_id, jumlah_bayar, tanggal_bayar, keterangan } = req.body;
  db.query('INSERT INTO pembayaran (tagihan_id, jumlah_bayar, tanggal_bayar, keterangan) VALUES (?,?,?,?)',
    [tagihan_id, jumlah_bayar, tanggal_bayar, keterangan || ''], (err) => {
      if (err) return res.status(500).json({ message: err.message });

      db.query(`SELECT t.jumlah, t.jenis, t.user_id, COALESCE(SUM(p.jumlah_bayar),0) as total_bayar
        FROM tagihan t LEFT JOIN pembayaran p ON p.tagihan_id=t.id
        WHERE t.id=? GROUP BY t.id`, [tagihan_id], (err2, results) => {
        if (err2) return res.status(500).json({ message: err2.message });
        const { jumlah, jenis, user_id, total_bayar } = results[0];
        const sisa = Math.round(jumlah - total_bayar);

        // Helper: ambil total kekurangan semua tagihan santri (sama dengan tampilan aplikasi)
        const getTotalKekurangan = (uid, callback) => {
          // Query ini menghitung sisa = jumlah - sudah_dicicil untuk tagihan belum lunas
          // dan 0 untuk tagihan yang sudah lunas
          db.query(`
            SELECT COALESCE(SUM(
              CASE
                WHEN t.status = 'lunas' THEN 0
                ELSE GREATEST(0, t.jumlah - COALESCE(
                  (SELECT SUM(p2.jumlah_bayar) FROM pembayaran p2 WHERE p2.tagihan_id = t.id), 0
                ))
              END
            ), 0) as total_kekurangan
            FROM tagihan t WHERE t.user_id = ?
          `, [uid], (e, rows) => {
            if (e || !rows.length) return callback(0);
            const kekurangan = Math.round(Number(rows[0].total_kekurangan));
            callback(Math.max(0, kekurangan));
          });
        };

        if (total_bayar >= jumlah) {
          // LUNAS
          db.query('UPDATE tagihan SET status="lunas", tanggal_bayar=? WHERE id=?',
            [tanggal_bayar, tagihan_id], () => {
              res.json({ message: 'Pembayaran berhasil, tagihan LUNAS!', lunas: true });

              // Notifikasi WA lunas — tampilkan sisa kekurangan total semua tagihan
              db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=?', [user_id], async (e, rows) => {
                if (e || !rows.length || !rows[0].no_hp) return;
                const u = rows[0];
                getTotalKekurangan(user_id, async (totalKekurangan) => {
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
                });
              });
            });
        } else {
          // CICILAN / SEBAGIAN
          res.json({ message: `Pembayaran dicatat. Sisa: Rp ${sisa.toLocaleString('id-ID')}`, lunas: false, sisa });

          // Notifikasi WA cicilan — tampilkan sisa tagihan ini + total kekurangan semua tagihan
          // Tunggu 500ms agar INSERT cicilan benar-benar tersimpan sebelum hitung ulang
          setTimeout(() => {
          db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=?', [user_id], async (e, rows) => {
            if (e || !rows.length || !rows[0].no_hp) return;
            const u = rows[0];
            getTotalKekurangan(user_id, async (totalKekurangan) => {
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
            });
          });
          }, 500); // end setTimeout cicilan notif
        }
      });
    });
});

// ============================================================
// GET RIWAYAT CICILAN PER TAGIHAN
// ============================================================
router.get('/pembayaran/:tagihanId', verifyAdmin, (req, res) => {
  db.query('SELECT * FROM pembayaran WHERE tagihan_id=? ORDER BY tanggal_bayar',
    [req.params.tagihanId], (err, results) => {
      if (err) return res.status(500).json({ message: 'Server error' });
      res.json(results);
    });
});

// ============================================================
// EDIT CICILAN
// ============================================================
router.put('/pembayaran/:id', verifyAdmin, (req, res) => {
  const { jumlah_bayar, tanggal_bayar, keterangan } = req.body;
  db.query('UPDATE pembayaran SET jumlah_bayar=?, tanggal_bayar=?, keterangan=? WHERE id=?',
    [jumlah_bayar, tanggal_bayar, keterangan || '', req.params.id], (err) => {
      if (err) return res.status(500).json({ message: err.message });
      db.query('SELECT tagihan_id FROM pembayaran WHERE id=?', [req.params.id], (err2, rows) => {
        if (err2 || !rows.length) return res.json({ message: 'Cicilan berhasil diupdate' });
        const tagihan_id = rows[0].tagihan_id;
        db.query(`SELECT t.jumlah, COALESCE(SUM(p.jumlah_bayar),0) as total_bayar
          FROM tagihan t LEFT JOIN pembayaran p ON p.tagihan_id=t.id
          WHERE t.id=? GROUP BY t.id`, [tagihan_id], (err3, results) => {
          if (err3 || !results.length) return res.json({ message: 'Cicilan berhasil diupdate' });
          const { jumlah, total_bayar } = results[0];
          const status = total_bayar >= jumlah ? 'lunas' : 'belum';
          const tgl = status === 'lunas' ? tanggal_bayar : null;
          db.query('UPDATE tagihan SET status=?, tanggal_bayar=? WHERE id=?', [status, tgl, tagihan_id], () => {
            res.json({ message: 'Cicilan berhasil diupdate', lunas: status === 'lunas' });
          });
        });
      });
    });
});

// ============================================================
// HAPUS CICILAN
// ============================================================
router.delete('/pembayaran/:id', verifyAdmin, (req, res) => {
  db.query('SELECT tagihan_id FROM pembayaran WHERE id=?', [req.params.id], (err, rows) => {
    if (err || !rows.length) return res.status(404).json({ message: 'Tidak ditemukan' });
    const tagihan_id = rows[0].tagihan_id;
    db.query('DELETE FROM pembayaran WHERE id=?', [req.params.id], (err2) => {
      if (err2) return res.status(500).json({ message: err2.message });
      db.query(`SELECT t.jumlah, COALESCE(SUM(p.jumlah_bayar),0) AS total_bayar, MAX(p.tanggal_bayar) AS last_tgl
        FROM tagihan t LEFT JOIN pembayaran p ON p.tagihan_id=t.id
        WHERE t.id=? GROUP BY t.id`, [tagihan_id], (err3, results) => {
        if (err3 || !results.length) return res.json({ message: 'Cicilan berhasil dihapus' });
        const { jumlah, total_bayar, last_tgl } = results[0];
        const status = total_bayar >= jumlah ? 'lunas' : 'belum';
        const tgl = status === 'lunas' ? last_tgl : null;
        db.query('UPDATE tagihan SET status=?, tanggal_bayar=? WHERE id=?', [status, tgl, tagihan_id], () => {
          res.json({ message: 'Cicilan berhasil dihapus' });
        });
      });
    });
  });
});

// ============================================================
// ARSIP SNAPSHOT SEMESTER (simpan rekap ke tabel arsip_semester)
// ============================================================
router.post('/semester/arsip', verifyAdmin, (req, res) => {
  const { nama_arsip, keterangan } = req.body;
  if (!nama_arsip) return res.status(400).json({ message: 'Nama arsip wajib diisi' });

  // Pastikan tabel ada dulu
  db.query(`CREATE TABLE IF NOT EXISTS arsip_semester (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nama_arsip VARCHAR(255) NOT NULL,
    keterangan TEXT,
    tanggal_arsip DATE,
    total_tagihan BIGINT DEFAULT 0,
    total_dibayar BIGINT DEFAULT 0,
    jumlah_santri INT DEFAULT 0,
    data_snapshot LONGTEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`, (errCreate) => {
    if (errCreate) return res.status(500).json({ message: 'Gagal membuat tabel: ' + errCreate.message });

    // Ambil semua tagihan (tanpa JSON_ARRAYAGG agar kompatibel MySQL lama)
    db.query(`
      SELECT
        u.id as user_id, u.nama_siswa, u.kelas,
        t.id as tagihan_id, t.jenis, t.jumlah, t.semester, t.status,
        COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dibayar
      FROM tagihan t
      JOIN users u ON t.user_id = u.id
      ORDER BY u.nama_siswa, t.semester, t.id
    `, (err, rows) => {
      if (err) return res.status(500).json({ message: 'Gagal ambil tagihan: ' + err.message });

      // Ambil semua riwayat pembayaran sekaligus
      db.query(`
        SELECT p.id, p.tagihan_id, p.jumlah_bayar, p.tanggal_bayar, p.keterangan
        FROM pembayaran p
        ORDER BY p.tagihan_id, p.tanggal_bayar
      `, (err2, payments) => {
        if (err2) return res.status(500).json({ message: 'Gagal ambil pembayaran: ' + err2.message });

        // Kelompokkan pembayaran per tagihan_id
        const payMap = {};
        for (const p of payments) {
          if (!payMap[p.tagihan_id]) payMap[p.tagihan_id] = [];
          payMap[p.tagihan_id].push({
            id: p.id,
            jumlah_bayar: Number(p.jumlah_bayar),
            tanggal_bayar: p.tanggal_bayar,
            keterangan: p.keterangan
          });
        }

        // Kelompokkan per santri
        const map = {};
        for (const r of rows) {
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
            sisa,
            riwayat_bayar: payMap[r.tagihan_id] || []
          });
          map[r.user_id].total_tagihan += Number(r.jumlah);
          map[r.user_id].total_dibayar += r.status === 'lunas' ? Number(r.jumlah) : sudah;
        }

        const snapshot = Object.values(map);
        const totalTagihan = snapshot.reduce((a, s) => a + s.total_tagihan, 0);
        const totalDibayar = snapshot.reduce((a, s) => a + s.total_dibayar, 0);
        const tanggal = new Date().toISOString().split('T')[0];

        db.query(
          'INSERT INTO arsip_semester (nama_arsip, keterangan, tanggal_arsip, total_tagihan, total_dibayar, jumlah_santri, data_snapshot) VALUES (?,?,?,?,?,?,?)',
          [nama_arsip, keterangan || '', tanggal, totalTagihan, totalDibayar, snapshot.length, JSON.stringify(snapshot)],
          (err3, result) => {
            if (err3) return res.status(500).json({ message: 'Gagal simpan arsip: ' + err3.message });
            res.json({ message: `Arsip "${nama_arsip}" berhasil disimpan!`, id: result.insertId, jumlah_santri: snapshot.length });
          }
        );
      });
    });
  });
});

// ============================================================
// GET DAFTAR ARSIP SEMESTER
// ============================================================
router.get('/semester/arsip', verifyAdmin, (req, res) => {
  db.query(`CREATE TABLE IF NOT EXISTS arsip_semester (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nama_arsip VARCHAR(255) NOT NULL,
    keterangan TEXT,
    tanggal_arsip DATE,
    total_tagihan BIGINT DEFAULT 0,
    total_dibayar BIGINT DEFAULT 0,
    jumlah_santri INT DEFAULT 0,
    data_snapshot LONGTEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`, () => {
    db.query('SELECT id, nama_arsip, keterangan, tanggal_arsip, total_tagihan, total_dibayar, jumlah_santri, created_at FROM arsip_semester ORDER BY created_at DESC',
      (err, results) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(results);
      });
  });
});

// ============================================================
// GET DETAIL ARSIP (buka snapshot)
// ============================================================
router.get('/semester/arsip/:id', verifyAdmin, (req, res) => {
  db.query('SELECT * FROM arsip_semester WHERE id=?', [req.params.id], (err, rows) => {
    if (err || !rows.length) return res.status(404).json({ message: 'Arsip tidak ditemukan' });
    const arsip = rows[0];
    try {
      arsip.data_snapshot = JSON.parse(arsip.data_snapshot);
    } catch (e) { arsip.data_snapshot = []; }
    res.json(arsip);
  });
});

// ============================================================
// HAPUS ARSIP
// ============================================================
router.delete('/semester/arsip/:id', verifyAdmin, (req, res) => {
  db.query('DELETE FROM arsip_semester WHERE id=?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ message: err.message });
    res.json({ message: 'Arsip berhasil dihapus' });
  });
});

// ============================================================
// RENAME SEMESTER (ubah nama semester di semua tagihan)
// ============================================================
router.put('/semester/rename', verifyAdmin, (req, res) => {
  const { nama_lama, nama_baru } = req.body;
  if (!nama_lama || !nama_baru)
    return res.status(400).json({ message: 'nama_lama dan nama_baru wajib diisi' });
  if (nama_lama.trim() === nama_baru.trim())
    return res.status(400).json({ message: 'Nama baru sama dengan nama lama' });

  db.query('UPDATE tagihan SET semester = ? WHERE semester = ?',
    [nama_baru.trim(), nama_lama.trim()], (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      if (result.affectedRows === 0)
        return res.status(404).json({ message: `Semester "${nama_lama}" tidak ditemukan` });
      res.json({
        message: `Semester "${nama_lama}" berhasil diubah ke "${nama_baru}"`,
        jumlah_tagihan: result.affectedRows
      });
    });
});

// ============================================================
// RESET TAGIHAN INDIVIDUAL (hapus cicilan 1 tagihan, reset status)
// ============================================================
router.post('/tagihan/:id/reset', verifyAdmin, (req, res) => {
  const tagihanId = req.params.id;
  db.query('SELECT * FROM tagihan WHERE id=?', [tagihanId], (err, rows) => {
    if (err || !rows.length) return res.status(404).json({ message: 'Tagihan tidak ditemukan' });
    db.query('DELETE FROM pembayaran WHERE tagihan_id=?', [tagihanId], (err2) => {
      if (err2) return res.status(500).json({ message: err2.message });
      db.query("UPDATE tagihan SET status='belum', tanggal_bayar=NULL WHERE id=?", [tagihanId], (err3) => {
        if (err3) return res.status(500).json({ message: err3.message });
        res.json({ message: 'Tagihan berhasil direset ke belum bayar. Riwayat cicilan dihapus.' });
      });
    });
  });
});


router.post('/semester/reset', verifyAdmin, (req, res) => {
  const { semester, nama_arsip_otomatis } = req.body;

  // Langkah 1: auto-arsip dulu sebelum reset (opsional, jika ada nama_arsip_otomatis)
  const doReset = () => {
    // Tentukan tagihan yang akan direset
    const whereClause = semester ? 'WHERE t.semester = ?' : '';
    const params = semester ? [semester] : [];

    db.query(`SELECT id FROM tagihan ${whereClause}`, params, (err, tagRows) => {
      if (err) return res.status(500).json({ message: err.message });
      if (!tagRows.length) return res.status(400).json({ message: 'Tidak ada tagihan yang bisa direset' });

      const tagIds = tagRows.map(r => r.id);

      // Hapus semua cicilan (pembayaran) untuk tagihan tersebut
      db.query('DELETE FROM pembayaran WHERE tagihan_id IN (?)', [tagIds], (err2) => {
        if (err2) return res.status(500).json({ message: err2.message });

        // Reset status tagihan kembali ke 'belum', tanggal_bayar null
        // Jenis & jumlah TIDAK diubah
        db.query(`UPDATE tagihan SET status='belum', tanggal_bayar=NULL ${whereClause}`, params, (err3) => {
          if (err3) return res.status(500).json({ message: err3.message });
          res.json({
            message: `Reset berhasil! ${tagIds.length} tagihan ${semester ? `semester "${semester}"` : 'semua semester'} direset ke status belum bayar. Riwayat cicilan dihapus. Jenis tagihan tetap.`,
            jumlah_tagihan: tagIds.length
          });
        });
      });
    });
  };

  doReset();
});


// ============================================================
// TAMBAH SEMESTER BARU + NOTIFIKASI WA (dengan rincian tunggakan lama)
// ============================================================
router.post('/semester', verifyAdmin, (req, res) => {
  const { nama_semester, tagihan_baru } = req.body;
  if (!tagihan_baru || tagihan_baru.length === 0) {
    return res.status(400).json({ message: 'Data tagihan baru kosong' });
  }
  const values = tagihan_baru.map(t => [t.user_id, t.jenis, t.jumlah, null, 'belum', nama_semester]);
  db.query('INSERT INTO tagihan (user_id, jenis, jumlah, tanggal_bayar, status, semester) VALUES ?',
    [values], async (err, result) => {
      if (err) return res.status(500).json({ message: err.message });
      res.json({ message: `${result.affectedRows} tagihan semester baru berhasil ditambahkan!` });

      const userIds = [...new Set(tagihan_baru.map(t => t.user_id))];
      for (const uid of userIds) {
        const tagihanUser = tagihan_baru.filter(t => t.user_id === uid);
        await new Promise((resolve) => {
          db.query('SELECT nama, nama_siswa, no_hp FROM users WHERE id=?', [uid], async (e, rows) => {
            if (e || !rows.length || !rows[0].no_hp) return resolve();
            const u = rows[0];

            // Ambil tunggakan lama (selain semester yang baru dibuat)
            db.query(`
              SELECT t.jenis, t.jumlah, t.semester,
                COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
              FROM tagihan t
              WHERE t.user_id=? AND t.status='belum' AND t.semester != ?
              ORDER BY t.semester, t.id
            `, [uid, nama_semester], async (e2, tunggakanLama) => {
              const daftarBaru = tagihanUser.map(t => `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`).join('\n');
              const totalBaru = tagihanUser.reduce((a, b) => a + Math.round(Number(b.jumlah)), 0);

              let pesanTunggakan = '';
              let totalLama = 0;
              if (!e2 && tunggakanLama && tunggakanLama.length > 0) {
                const rincianLama = tunggakanLama.map(t => {
                  const sisa = Math.round(Number(t.jumlah) - Number(t.sudah_dicicil));
                  totalLama += sisa;
                  const info = Number(t.sudah_dicicil) > 0
                    ? `• [${t.semester || '-'}] ${t.jenis}: Rp ${formatRp(t.jumlah)} (cicilan: Rp ${formatRp(t.sudah_dicicil)}, *sisa: Rp ${formatRp(sisa)}*)`
                    : `• [${t.semester || '-'}] ${t.jenis}: *Rp ${formatRp(sisa)}*`;
                  return info;
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
              resolve();
            });
          });
        });
      }
    });
});


// ============================================================
// GET DETAIL TUNGGAKAN PER SEMESTER (rincian per santri)
// ============================================================
router.get('/semester/:nama/detail', verifyAdmin, (req, res) => {
  const namaSemester = req.params.nama;
  db.query(`
    SELECT
      u.id as user_id, u.nama_siswa, u.kelas, u.no_hp,
      t.id as tagihan_id, t.jenis, t.jumlah, t.status,
      COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
    FROM tagihan t
    JOIN users u ON t.user_id = u.id
    WHERE t.semester = ?
    ORDER BY u.nama_siswa, t.id
  `, [namaSemester], (err, rows) => {
    if (err) return res.status(500).json({ message: 'Server error' });
    const map = {};
    for (const r of rows) {
      if (!map[r.user_id]) {
        map[r.user_id] = { user_id: r.user_id, nama_siswa: r.nama_siswa, kelas: r.kelas, no_hp: r.no_hp, tagihan: [], total_tagihan: 0, total_sudah_bayar: 0 };
      }
      const sudah = r.status === 'lunas' ? Number(r.jumlah) : Number(r.sudah_dicicil);
      const sisa = r.status === 'lunas' ? 0 : Math.round(Number(r.jumlah) - Number(r.sudah_dicicil));
      map[r.user_id].tagihan.push({ id: r.tagihan_id, jenis: r.jenis, jumlah: Number(r.jumlah), status: r.status, sudah_dicicil: sudah, sisa });
      map[r.user_id].total_tagihan += Number(r.jumlah);
      map[r.user_id].total_sudah_bayar += sudah;
    }
    res.json(Object.values(map));
  });
});

// ============================================================
// GET TUNGGAKAN LAMA PER SANTRI (semua tagihan belum lunas)
// ============================================================
router.get('/tunggakan-per-santri', verifyAdmin, (req, res) => {
  db.query(`
    SELECT u.id as user_id, u.nama_siswa, u.kelas,
      t.id as tagihan_id, t.jenis, t.jumlah, t.semester,
      COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
    FROM tagihan t
    JOIN users u ON t.user_id = u.id
    WHERE t.status = 'belum'
    ORDER BY u.nama_siswa, t.semester, t.id
  `, (err, rows) => {
    if (err) return res.status(500).json({ message: 'Server error' });
    const map = {};
    for (const r of rows) {
      if (!map[r.user_id]) map[r.user_id] = { user_id: r.user_id, nama_siswa: r.nama_siswa, kelas: r.kelas, tagihan: [], total_tunggakan: 0 };
      const sisa = Math.round(Number(r.jumlah) - Number(r.sudah_dicicil));
      if (sisa > 0) {
        map[r.user_id].tagihan.push({ id: r.tagihan_id, jenis: r.jenis, jumlah: Number(r.jumlah), sudah_dicicil: Number(r.sudah_dicicil), sisa, semester: r.semester || '-' });
        map[r.user_id].total_tunggakan += sisa;
      }
    }
    res.json(Object.values(map));
  });
});

// ============================================================
// GET DAFTAR SEMESTER (dengan statistik)
// ============================================================
router.get('/semester', verifyAdmin, (req, res) => {
  db.query(`
    SELECT t.semester,
      COUNT(*) as jumlah_tagihan,
      COUNT(DISTINCT t.user_id) as jumlah_santri,
      SUM(t.jumlah) as total_tagihan,
      SUM(CASE WHEN t.status='lunas' THEN t.jumlah
               ELSE COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id),0)
          END) as total_terbayar
    FROM tagihan t
    WHERE t.semester IS NOT NULL AND t.semester != ''
    GROUP BY t.semester
    ORDER BY t.semester DESC
  `, (err, results) => {
    if (err) return res.status(500).json({ message: 'Server error' });
    res.json(results);
  });
});

// ============================================================
// JADWAL OTOMATIS (simpan di memory, reset saat server restart)
// ============================================================
let jadwalPengingat = {
  aktif: false,
  tanggal: 1,      // tanggal tiap bulan (1-28)
  jam: "08:00",    // jam kirim
  intervalId: null
};

// Fungsi inti: ambil semua santri yang punya tunggakan, kirim WA
const kirimPengingatSemua = () => {
  return new Promise((resolve) => {
    db.query(`
      SELECT u.id, u.nama, u.nama_siswa, u.no_hp,
        COALESCE((
          SELECT SUM(
            CASE WHEN t.status='lunas' THEN 0
            ELSE GREATEST(0, t.jumlah - COALESCE(
              (SELECT SUM(p2.jumlah_bayar) FROM pembayaran p2 WHERE p2.tagihan_id=t.id), 0
            ))
            END
          ) FROM tagihan t WHERE t.user_id=u.id
        ), 0) as total_kekurangan
      FROM users u
      HAVING total_kekurangan > 0 AND no_hp IS NOT NULL AND no_hp != ''
      ORDER BY u.nama_siswa
    `, async (err, santriList) => {
      if (err) { console.log('Error ambil data pengingat:', err.message); return resolve(0); }

      let terkirim = 0;
      for (const u of santriList) {
        const sisa = Math.round(Number(u.total_kekurangan));
        if (sisa <= 0) continue;

        // Ambil rincian tagihan yang belum lunas
        await new Promise((res2) => {
          db.query(`
            SELECT t.jenis, t.jumlah,
              COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
            FROM tagihan t
            WHERE t.user_id=? AND t.status='belum'
            ORDER BY t.id
          `, [u.id], async (e2, tagihan) => {
            if (e2 || !tagihan.length) return res2();

            const rincian = tagihan.map(t => {
              const sisaTagihan = Math.round(Number(t.jumlah) - Number(t.sudah_dicicil));
              const sudahCicil = Math.round(Number(t.sudah_dicicil));
              if (sudahCicil > 0) {
                return `• ${t.jenis}\n  Total: Rp ${formatRp(t.jumlah)} | Cicilan: Rp ${formatRp(sudahCicil)} | Sisa: *Rp ${formatRp(sisaTagihan)}*`;
              }
              return `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`;
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
            res2();
          });
        });
      }
      resolve(terkirim);
    });
  });
};

// Fungsi set/reset interval jadwal otomatis
const aturJadwalOtomatis = () => {
  if (jadwalPengingat.intervalId) {
    clearInterval(jadwalPengingat.intervalId);
    jadwalPengingat.intervalId = null;
  }
  if (!jadwalPengingat.aktif) return;

  // Cek setiap menit apakah sudah waktunya kirim
  jadwalPengingat.intervalId = setInterval(() => {
    const now = new Date();
    const [jamSet, menitSet] = jadwalPengingat.jam.split(':').map(Number);
    const tanggalSet = jadwalPengingat.tanggal;
    if (now.getDate() === tanggalSet && now.getHours() === jamSet && now.getMinutes() === menitSet) {
      console.log(`[JADWAL] Mengirim pengingat otomatis - ${now.toLocaleString('id-ID')}`);
      kirimPengingatSemua().then(n => console.log(`[JADWAL] Terkirim ke ${n} wali`));
    }
  }, 60000); // cek tiap 1 menit
};

// GET jadwal pengingat
router.get('/pengingat/jadwal', verifyAdmin, (req, res) => {
  res.json({ aktif: jadwalPengingat.aktif, tanggal: jadwalPengingat.tanggal, jam: jadwalPengingat.jam });
});

// SIMPAN jadwal pengingat
router.post('/pengingat/jadwal', verifyAdmin, (req, res) => {
  const { aktif, tanggal, jam } = req.body;
  jadwalPengingat.aktif = aktif;
  jadwalPengingat.tanggal = Number(tanggal) || 1;
  jadwalPengingat.jam = jam || '08:00';
  aturJadwalOtomatis();
  res.json({
    message: aktif
      ? `Jadwal aktif: setiap tanggal ${jadwalPengingat.tanggal} jam ${jadwalPengingat.jam}`
      : 'Jadwal otomatis dinonaktifkan',
    jadwal: { aktif: jadwalPengingat.aktif, tanggal: jadwalPengingat.tanggal, jam: jadwalPengingat.jam }
  });
});

// KIRIM PENGINGAT MANUAL ke semua wali yang punya tunggakan
router.post('/pengingat/kirim-semua', verifyAdmin, async (req, res) => {
  try {
    const terkirim = await kirimPengingatSemua();
    res.json({ message: `Pengingat berhasil dikirim ke ${terkirim} wali santri`, terkirim });
  } catch (e) {
    res.status(500).json({ message: 'Gagal mengirim pengingat: ' + e.message });
  }
});

// KIRIM PENGINGAT MANUAL ke 1 santri
router.post('/pengingat/kirim/:userId', verifyAdmin, (req, res) => {
  db.query(`
    SELECT u.id, u.nama, u.nama_siswa, u.no_hp,
      COALESCE((
        SELECT SUM(
          CASE WHEN t.status='lunas' THEN 0
          ELSE GREATEST(0, t.jumlah - COALESCE(
            (SELECT SUM(p2.jumlah_bayar) FROM pembayaran p2 WHERE p2.tagihan_id=t.id), 0
          ))
          END
        ) FROM tagihan t WHERE t.user_id=u.id
      ), 0) as total_kekurangan
    FROM users u WHERE u.id=?
  `, [req.params.userId], (err, rows) => {
    if (err || !rows.length) return res.status(404).json({ message: 'Santri tidak ditemukan' });
    const u = rows[0];
    if (!u.no_hp) return res.status(400).json({ message: 'Santri belum punya nomor WA' });
    const sisa = Math.round(Number(u.total_kekurangan));
    if (sisa <= 0 || isNaN(sisa)) return res.status(400).json({ message: 'Santri tidak punya tunggakan' });

    db.query(`
      SELECT t.jenis, t.jumlah,
        COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id=t.id), 0) as sudah_dicicil
      FROM tagihan t WHERE t.user_id=? AND t.status='belum' ORDER BY t.id
    `, [u.id], async (e2, tagihan) => {
      if (e2) return res.status(500).json({ message: e2.message });

      const rincian = tagihan.map(t => {
        const sisaTagihan = Math.round(Number(t.jumlah) - Number(t.sudah_dicicil));
        const sudahCicil = Math.round(Number(t.sudah_dicicil));
        if (sudahCicil > 0) {
          return `• ${t.jenis}\n  Total: Rp ${formatRp(t.jumlah)} | Cicilan: Rp ${formatRp(sudahCicil)} | Sisa: *Rp ${formatRp(sisaTagihan)}*`;
        }
        return `• ${t.jenis}: *Rp ${formatRp(t.jumlah)}*`;
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
    });
  });
});
// ============================================================
// KIRIM WA NOTIFIKASI KELEBIHAN BAYAR / UANG JAJAN
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
