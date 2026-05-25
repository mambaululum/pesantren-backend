const { Pool } = require('pg');
require('dotenv').config();

console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'ADA' : 'TIDAK ADA');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

db.connect()
  .then(() => console.log('Database terhubung!'))
  .catch(err => console.log('Gagal konek database:', err.message));

module.exports = db;
