const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/db');

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const { data: results, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .limit(1);

    if (error) return res.status(500).json({ message: 'Server error', detail: error.message });
    if (!results || results.length === 0) return res.status(401).json({ message: 'Username tidak ditemukan' });

    const user = results[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: 'Password salah' });

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, user: { id: user.id, nama: user.nama, nama_siswa: user.nama_siswa, kelas: user.kelas } });

  } catch (err) {
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

module.exports = router;