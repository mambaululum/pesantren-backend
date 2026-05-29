const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const authRoutes = require('./routes/auth');
const tagihanRoutes = require('./routes/tagihan');
const adminRoutes = require('./routes/admin');
const { kirimPengingatSemua } = require('./routes/admin');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use('/api/auth', authRoutes);
app.use('/api/tagihan', tagihanRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Server sekolah berjalan!' });
});

app.get('/api/cron/pengingat', async (req, res) => {
  try {
    const terkirim = await kirimPengingatSemua();
    res.json({ message: `Pengingat terkirim ke ${terkirim} wali`, terkirim });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Untuk local development
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
  });
}

// Wajib untuk Vercel
module.exports = app;
