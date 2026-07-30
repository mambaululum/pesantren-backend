const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/db');

// Login untuk santri/wali (tabel users)
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !data) return res.status(401).json({ message: 'Username tidak ditemukan' });

    const valid = await bcrypt.compare(password, data.password);
    if (!valid) return res.status(401).json({ message: 'Password salah' });

    const token = jwt.sign({ id: data.id }, process.env.JWT_SECRET, { expiresIn: '1d' });

    res.json({
      token,
     user: {
          id: data.id,
          nama: data.nama,
          nama_siswa: data.nama_siswa,
          kelas: data.kelas,
          foto_url: data.foto_url || null
        }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

// Ambil ulang data profil user yang sedang login (dipakai untuk sinkronkan
// foto_url dkk. tanpa harus logout-login setiap kali admin update data).
router.get('/profil', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Token tidak ada' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Token tidak valid / kedaluwarsa' });
    }

    const { data, error } = await supabase
      .from('users')
      .select('id, nama, nama_siswa, kelas, foto_url')
      .eq('id', payload.id)
      .single();

    if (error || !data) return res.status(404).json({ message: 'User tidak ditemukan' });

    res.json({
      user: {
        id: data.id,
        nama: data.nama,
        nama_siswa: data.nama_siswa,
        kelas: data.kelas,
        foto_url: data.foto_url || null
      }
    });
  } catch (err) {
    console.error('Profil error:', err.message);
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

module.exports = router;