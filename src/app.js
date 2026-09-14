// Config FIRST, before any other local require.
//
// This ordering is load-bearing, not stylistic. `require` executes a module's top level
// immediately, so anything below that reads configuration at module scope would observe
// process.env before .env had been loaded — and would capture `undefined` permanently,
// because a module body runs exactly once no matter how many times it is required.
// Putting this line first means every module loaded after it sees a validated
// environment, and a misconfigured deployment dies here rather than on a user's request.
const config = require('./config');

const express = require('express');
const userRoutes = require('./routes/userRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./middleware/logger');

const app = express();
app.use(express.json());
app.use(logger);
app.use('/users', userRoutes);
app.use('/transactions', transactionRoutes);
app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));  // Changed to app.get for /health
app.use(errorHandler);

// Start Server
app.listen(config.port, () => {
  console.log(`Server running on port ${config.port} (${config.nodeEnv})`);
});

module.exports = app;