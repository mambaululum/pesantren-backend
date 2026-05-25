const { Pool } = require('pg');
require('dotenv').config();

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

db.connect()
  .then(() => console.log('Database terhubung!'))
  .catch(err => console.log('Gagal konek database:', err.message));

module.exports = db;