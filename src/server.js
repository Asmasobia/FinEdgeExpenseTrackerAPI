/**
 * Process entry point: the only file in the project that binds a port.
 *
 * `src/app.js` builds the Express application and exports it without listening. This file is the
 * thin shell around it that turns an app object into a running server. The split exists so that
 * requiring the app has no side effects — see the header of app.js for why that mattered enough to
 * change (short version: the test suite could not import the app without starting a real server on
 * a real port, and Jest would then never exit).
 *
 * `npm start` and `npm run dev` both point here. `src/app.js` is what tests import.
 */

// Config first, for the same reason as in app.js — and here the port is actually used, so a bad
// PORT value stops the process before a listener is attempted rather than binding a random port.
const config = require('./config');

const app = require('./app');

const server = app.listen(config.port, () => {
  // `server.address().port` rather than `config.port`, because they are not always the same value:
  // port 0 means "let the OS pick a free one", which is genuinely useful in CI. Logging the
  // configured value would print `0` and leave you with no way to find the real port.
  const { port } = server.address();
  console.log(`Server running on port ${port} (${config.nodeEnv})`);
});

/**
 * Graceful shutdown.
 *
 * Without this, Node's default response to SIGINT/SIGTERM is to exit immediately: in-flight
 * requests are cut off mid-response, and — the reason this matters for *this* application in
 * particular — a write in progress dies between its temp-file write and the rename that publishes
 * it. The atomic-write design in jsonStore.js means the previous version of the data file survives
 * that, so nothing is corrupted; but the client that got no response has no way to know whether
 * their transaction was recorded. Draining first turns "unknown" into "completed".
 *
 * `server.close()` stops accepting new connections and fires the callback once existing ones have
 * finished. The timer is the other half of the pattern: a client holding an idle keep-alive
 * connection would otherwise keep the process alive indefinitely, so after a grace period we stop
 * waiting. `unref()` on the timer means it does not itself hold the event loop open — otherwise a
 * clean, fast shutdown would still sit here for the full ten seconds doing nothing.
 *
 * SIGTERM is what an orchestrator or `docker stop` sends; SIGINT is Ctrl-C. Handling only one is a
 * common half-fix that works in development and not in production, or the reverse.
 *
 * One platform caveat, stated because it would otherwise look like this code is doing more than it
 * is: Windows has no POSIX signals. Node emulates SIGINT for Ctrl-C, but `taskkill` terminates the
 * process without these handlers ever running. So on Windows this is effectively dead code — which
 * is fine, because the environment it exists for is a Linux container, and it is verified there (and
 * in tests) by emitting the signal directly rather than by sending a real one.
 */
const SHUTDOWN_GRACE_MS = 10_000;

function shutdown(signal) {
  console.log(`${signal} received — draining in-flight requests, then exiting.`);

  const forceExit = setTimeout(() => {
    console.error(`Did not finish within ${SHUTDOWN_GRACE_MS} ms — forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  server.close((error) => {
    if (error) {
      console.error('Error while closing the server:', error);
      process.exit(1);
    }
    console.log('Closed cleanly.');
    process.exit(0);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}

module.exports = server;
