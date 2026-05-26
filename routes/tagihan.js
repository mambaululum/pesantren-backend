const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../config/db');

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
    const result = await db.query(
      `SELECT t.*, 
       COALESCE((
         SELECT SUM(p.jumlah_bayar) 
         FROM pembayaran p 
         WHERE p.tagihan_id = t.id
       ), 0) AS sudah_dicicil
       FROM tagihan t 
       WHERE t.user_id = $1 
       ORDER BY t.id`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error tagihan:', err.message);
    res.status(500).json({ message: 'Server error', detail: err.message });
  }
});

module.exports = router;