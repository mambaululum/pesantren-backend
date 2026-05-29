const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/db');

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !user) {
      return res.status(401).json({
        message: 'User tidak ditemukan'
      });
    }

    if (user.password !== password) {
      return res.status(401).json({
        message: 'Password salah'
      });
    }

    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        nama: user.nama,
        nama_siswa: user.nama_siswa,
        kelas: user.kelas
      }
    });

  } catch (err) {
    console.log(err);

    res.status(500).json({
      message: err.message
    });
  }
});

module.exports = router;