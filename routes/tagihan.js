const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../config/db');

const verifyToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token diperlukan' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ message: 'Token tidak valid' });
    req.userId = decoded.id;
    next();
  });
};

router.get('/', verifyToken, (req, res) => {
  db.query(
    `SELECT t.*, 
     COALESCE((SELECT SUM(p.jumlah_bayar) FROM pembayaran p WHERE p.tagihan_id = t.id), 0) as sudah_dicicil
     FROM tagihan t WHERE t.user_id = ? ORDER BY t.id`,
    [req.userId], (err, results) => {
      if (err) return res.status(500).json({ message: 'Server error' });
      res.json(results);
    });
});

module.exports = router;