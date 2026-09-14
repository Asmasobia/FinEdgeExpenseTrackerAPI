/**
 * Configuration, loaded and VALIDATED once at start-up.
 *
 * Why this file exists at all
 * --------------------------------------------------------------------------------
 * Before it, `process.env.JWT_SECRET` was read lazily, deep inside `loginUser`:
 *
 *     const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
 *
 * If the variable was missing, the server started happily, served `/health` happily,
 * and then threw on the first login attempt — surfacing to the user as an opaque 500
 * and to the operator as a stack trace in `jsonwebtoken`, far from the actual cause.
 *
 * A missing secret is not a request-time problem. It is a deployment problem, and the
 * cheapest place to catch a deployment problem is at boot, before any traffic arrives.
 * That principle has a name — **fail fast** — and the reasoning behind it is that a
 * process which refuses to start is unmissable, whereas a process that starts and then
 * misbehaves under load can go unnoticed for a long time. A crash-looping container is
 * a loud, obvious signal; intermittent 500s are a debugging session.
 *
 * Reading environment variables in exactly one place buys three further things:
 *   1. Every `process.env` access is greppable in one file, so it is possible to
 *      answer "what does this service need to run?" by reading 40 lines.
 *   2. Defaults live next to the validation instead of being scattered as
 *      `process.env.PORT || 3000` in whichever module happened to need it first.
 *   3. The rest of the code depends on a plain object, which a test can substitute.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load `.env` into process.env.
//
// The explicit `path` matters. `dotenv.config()` with no arguments resolves `.env`
// relative to `process.cwd()` — the directory the process was *launched* from, not the
// one this file lives in. So `npm start` from the repo root works, and
// `node src/app.js` from anywhere else silently finds no file, sets nothing, and
// leaves you debugging a missing secret that is sitting right there on disk.
// Anchoring to `__dirname/..` makes loading independent of where it was started.
//
// `quiet` suppresses dotenv's start-up banner; it is ignored by older versions, so
// passing it is safe either way.
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * A fixed, obviously-fake secret used ONLY when NODE_ENV is exactly 'test'.
 *
 * The test suite needs to sign and verify tokens, but requiring every contributor to
 * create a `.env` before `npm test` works is friction that gets solved by someone
 * committing a `.env` — which is the exact outcome this repository is trying to avoid.
 *
 * The danger with a fallback secret is that it silently becomes the production secret.
 * Two things prevent that here: the fallback applies only when NODE_ENV is the literal
 * string 'test' (a value nothing sets by accident — Jest sets it deliberately), and the
 * value is named so that finding it in a running production process is unambiguous.
 */
const TEST_ONLY_JWT_SECRET = 'insecure-test-only-secret-do-not-use-in-production';

/** Variables with no safe default. A missing one is a hard stop. */
const REQUIRED = ['JWT_SECRET'];

if (NODE_ENV === 'test' && !process.env.JWT_SECRET) {
  process.env.JWT_SECRET = TEST_ONLY_JWT_SECRET;
}

// `.trim() === ''` as well as absence: an empty assignment in a .env file (`JWT_SECRET=`)
// produces an empty string, which is falsy in JS but would pass a `!== undefined` check.
// Whitespace-only is the same mistake with a space after the equals sign.
const missing = REQUIRED.filter((key) => {
  const value = process.env[key];
  return value === undefined || value.trim() === '';
});

if (missing.length > 0) {
  console.error(
    `[CONFIG] Refusing to start. Missing required environment variable(s): ${missing.join(', ')}.\n` +
      `         Copy .env.example to .env and fill in the values:  cp .env.example .env`
  );
  // Exit code 1, not 0: process managers, CI and container orchestrators all treat a
  // non-zero exit as a failure worth reporting or restarting. Exiting 0 here would tell
  // them the service shut down cleanly and on purpose.
  process.exit(1);
}

// A weak secret is not a missing secret, so this warns rather than exits — refusing to
// boot over a short development secret would be obstructive. 32 bytes is the output size
// of the SHA-256 that HS256 uses internally, so a shorter secret adds no strength beyond
// its own length while being far easier to brute-force offline.
const MIN_SECRET_LENGTH = 32;
if (NODE_ENV !== 'test' && process.env.JWT_SECRET.length < MIN_SECRET_LENGTH) {
  console.warn(
    `[CONFIG] JWT_SECRET is only ${process.env.JWT_SECRET.length} characters. ` +
      `Use at least ${MIN_SECRET_LENGTH}; see .env.example for a one-line generator.`
  );
}

// `Number.parseInt` then a sanity check, because `PORT=abc` would otherwise become NaN
// and `app.listen(NaN)` binds a random free port — a server that starts successfully on
// an address nobody is expecting, which is worse than one that refuses.
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`[CONFIG] Refusing to start. PORT must be an integer 0-65535, got "${process.env.PORT}".`);
  process.exit(1);
}

/**
 * Where the JSON data files live.
 *
 * This became configurable for the test suite, and the reason is worth stating because it is a
 * general trap rather than a detail of this project. The models previously resolved
 * `__dirname/../data/transactions.json` at require time, which meant a test that exercised a
 * write would write to the developer's real data files — deleting their records, and leaving the
 * committed `transactions.json` dirty in `git status` afterwards. Worse, tests sharing one file
 * cannot run in parallel: Jest runs test files in separate worker processes, so the in-process
 * lock from jsonStore.js does not span them and two suites would race exactly as two servers
 * would. Each suite pointing at its own temp directory removes both problems.
 *
 * Resolved against the repo root rather than the current working directory, for the same reason
 * `dotenv` is: it must not matter where the process was launched from. An absolute value passed
 * in is used as-is, which is what the tests do.
 */
const dataDir = path.resolve(__dirname, '..', process.env.DATA_DIR || 'src/data');

module.exports = {
  nodeEnv: NODE_ENV,
  isProduction: NODE_ENV === 'production',
  isTest: NODE_ENV === 'test',
  port,
  jwtSecret: process.env.JWT_SECRET,
  /** Lifetime of an issued token, in `jsonwebtoken`'s `expiresIn` format. */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  dataDir,
};
