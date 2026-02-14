const express = require('express');
const dotenv = require('dotenv');
const userRoutes = require('./routes/userRoutes');
const transactionRoutes = require('./routes/transactionRoutes');  // Added
const errorHandler = require('./middleware/errorHandler');
const logger = require('./middleware/logger');

dotenv.config();  // Added

const app = express();
app.use(express.json());
app.use(logger);
app.use('/users', userRoutes);
app.use('/transactions', transactionRoutes);
app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));  // Changed to app.get for /health
app.use(errorHandler);

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;  // Added