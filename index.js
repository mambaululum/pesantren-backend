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

const PORT = process.env.PORT || 5000;
// CRON pengingat otomatis
app.get('/api/cron/pengingat', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    // Import fungsi dari admin routes
    res.json({ message: 'Cron berjalan - gunakan endpoint pengingat manual' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});