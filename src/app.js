/**
 * The Express application — wiring only. It does NOT listen on a port.
 *
 * That separation is the point of this file, and it is worth explaining because the version it
 * replaces did both: it called `app.listen(...)` at module scope *and* exported `app`. Which meant
 * merely requiring this module bound a TCP port as a side effect. Three consequences:
 *
 *   1. Tests could not use it. `supertest(app)` asks Express for an ephemeral listener of its own,
 *      so importing the app to test it would leave a second server holding port 3000 — and the
 *      Jest process would never exit, because an open listener is a live handle in the event loop.
 *      Two test files importing it in parallel workers would collide outright with EADDRINUSE.
 *   2. Any tool that just wants to inspect the app — a route lister, a script that mounts it under
 *      a different prefix, a serverless adapter — inherits a running server it never asked for.
 *   3. There is nowhere to put shutdown handling, because nothing holds a reference to the server
 *      object that `listen` returns.
 *
 * So: this file builds and exports the app; `src/server.js` requires it and starts listening. The
 * rule of thumb is that importing a module should not change the state of the world.
 */

// Config FIRST, before any other local require.
//
// This ordering is load-bearing, not stylistic. `require` executes a module's top level
// immediately, so anything below that reads configuration at module scope would observe
// process.env before .env had been loaded — and would capture `undefined` permanently,
// because a module body runs exactly once no matter how many times it is required.
// Putting this line first means every module loaded after it sees a validated
// environment, and a misconfigured deployment dies here rather than on a user's request.
//
// Bare `require` with no assignment: this file no longer needs any config *value* (the port moved
// to server.js), but it still needs the loading and validation to happen before the requires below.
// Deleting this line would not break anything today and would break it later, silently, the first
// time a module below reads config at its top level — hence the comment rather than the deletion.
require('./config');

const express = require('express');
const userRoutes = require('./routes/userRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const healthRoutes = require('./routes/health');
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

// `/health` is mounted first, deliberately. A liveness probe should be the cheapest and most
// reliable route in the process — it must not sit behind auth, and it must not be able to fail
// because of anything the business routes do.
//
// It was previously declared inline here while `src/routes/health.js` sat in the tree unused, so
// the file a reader would open to find the health route was not the code that served it. Mounting
// the router and deleting the inline handler resolves that in the direction of consistency: every
// route in this application now lives in `src/routes/`.
app.use('/health', healthRoutes);
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

module.exports = app;