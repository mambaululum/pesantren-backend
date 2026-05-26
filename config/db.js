const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log('✅ Database Supabase terhubung!'))
  .catch(err => console.error('❌ Gagal konek database:', err.message));

// Export fungsi query langsung
module.exports = {
  query: (sql, params) => pool.query(sql, params)
};