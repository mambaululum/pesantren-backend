const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Wrapper agar syntax lama (db.query) tetap bisa dipakai
const originalQuery = db.query.bind(db);
db.query = (sql, params, callback) => {
  if (typeof params === 'function') {
    callback = params;
    params = [];
  }
  // Konversi ? ke $1, $2, $3 (PostgreSQL style)
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  
  originalQuery(pgSql, params || [])
    .then(result => {
      if (callback) callback(null, result.rows, result.fields);
    })
    .catch(err => {
      if (callback) callback(err);
    });
};

db.connect()
  .then(() => console.log('Database Supabase terhubung!'))
  .catch(err => console.log('Gagal konek database:', err.message));

module.exports = db;