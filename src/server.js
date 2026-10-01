require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

require('./db'); // initialise schema on boot

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '8mb' })); // selfies/photos travel as base64 data URLs for now

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/workers', require('./routes/workers'));
app.use('/api/kyc', require('./routes/kyc'));
app.use('/api/punches', require('./routes/punches'));
app.use('/api', require('./routes/masters')); // /api/vendors, /api/locations
app.use('/api/regularisations', require('./routes/regularisations'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/admin-users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/assisted', require('./routes/assisted'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`TSG Workforce backend listening on http://localhost:${PORT}`));
