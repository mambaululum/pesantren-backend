const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/db');

// Middleware verify token
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token diperlukan' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ message: 'Token tidak valid' });
    req.userId = decoded.id;
    next();
  });
};

// GET semua tagihan milik user yang login
router.get('/', verifyToken, async (req, res) => {
  try {
    const { data: tagihan, error } = await supabase
      .from('tagihan')
      .select('*')
      .eq('user_id', req.userId)
      .order('id');

    if (error) return res.status(500).json({ message: 'Server error', detail: error.message });

    // Tambahkan sudah_dicicil per tagihan
    const result = await Promise.all(tagihan.map(async (t) => {
      const { data: bayar } = await supabase
        .from('pembayaran')
        .select('jumlah_bayar')
        .eq('tagihan_id', t.id);
      const sudah_dicicil = bayar ? bayar.reduce((a, p) => a + Number(p.jumlah_bayar), 0) : 0;
      return { ...t, sudah_dicicil };
    }));

    res.json(result);
  } catch (err) {
    console.error('Error tagihan:', err.message);
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

module.exports = router;
