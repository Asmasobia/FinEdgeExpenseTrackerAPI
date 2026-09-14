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
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const logger = require('./middleware/logger');

const app = express();

// A body-size cap, because the default is 100kb and "the default" is not a decision. Without a
// deliberate limit, a single request can make the process buffer an arbitrary amount of JSON in
// memory before any of this application's own code runs. 100kb is generous for a transaction; a
// request over it gets a 413 from body-parser, which the error handler now passes through with
// its own status instead of converting to a 500.
app.use(express.json({ limit: '100kb' }));
app.use(logger);

app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));
app.use('/users', userRoutes);
app.use('/transactions', transactionRoutes);

// ORDER MATTERS FOR BOTH OF THESE, and they are not interchangeable with the routes above.
//
// Express walks its middleware stack in registration order, so `notFoundHandler` must come after
// every route — mounted earlier it would match everything and the API would be nothing but 404s.
// And `errorHandler` must come last of all, because it is only reachable via `next(err)` from
// something registered before it; anything mounted after it is unreachable from the error path.
// These two lines belong at the bottom of this file and nowhere else.
app.use(notFoundHandler);
app.use(errorHandler);

// Start Server
app.listen(config.port, () => {
  console.log(`Server running on port ${config.port} (${config.nodeEnv})`);
});

module.exports = app;