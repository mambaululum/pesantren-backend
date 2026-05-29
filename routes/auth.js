const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/db');

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
        kelas: data.kelas
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

module.exports = router;