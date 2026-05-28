const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
dotenv.config();

// Untuk admin.js (pakai db.query)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Untuk tagihan.js (pakai supabase)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = {
  query: (text, params) => pool.query(text, params),
  supabase
};