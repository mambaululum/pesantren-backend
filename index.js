const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const authRoutes = require('./routes/auth');
const tagihanRoutes = require('./routes/tagihan');
const adminRoutes = require('./routes/admin');
dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/tagihan', tagihanRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Server sekolah berjalan!' });
});

// CRON pengingat otomatis
app.get('/api/cron/pengingat', async (req, res) => {
  try {
    const terkirim = await adminRoutes.kirimPengingatSemua();
    res.json({ message: `Pengingat terkirim ke ${terkirim} wali`, terkirim });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});