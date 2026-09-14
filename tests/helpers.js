/**
 * Shared test helpers.
 *
 * Requiring this file pulls in `src/app.js`, which pulls in `src/config.js`. That is safe here and
 * would not be in tests/setup.js: setup runs before the test file, this runs from inside it, so
 * DATA_DIR is already set by the time config's module body executes. Worth stating because the
 * failure mode of getting it wrong is not an error — it is tests that silently write to the real
 * `src/data/` directory.
 */

const fs = require('fs/promises');
const path = require('path');

const request = require('supertest');

const app = require('../src/app');

const dataDir = global.TEST_DATA_DIR;
const usersFile = path.join(dataDir, 'users.json');
const transactionsFile = path.join(dataDir, 'transactions.json');

/**
 * Empty both data files.
 *
 * Called from `beforeEach` so each test starts from a known state. Writes `[]` rather than deleting
 * the files, because either would work — `jsonStore.readArray` treats ENOENT as an empty array — and
 * writing makes the intent visible in the directory while a test is being debugged.
 */
async function resetData() {
  await fs.mkdir(dataDir, { recursive: true });
  await Promise.all([fs.writeFile(usersFile, '[]'), fs.writeFile(transactionsFile, '[]')]);
}

/** Read a data file the way an outside observer would — bypassing the application entirely. */
async function readUsersFile() {
  return JSON.parse(await fs.readFile(usersFile, 'utf-8'));
}

async function readTransactionsFile() {
  return JSON.parse(await fs.readFile(transactionsFile, 'utf-8'));
}

/**
 * Register a user and log them in, returning a usable bearer token.
 *
 * Goes through the real HTTP endpoints rather than calling the service or seeding the file directly.
 * That is a deliberate trade: seeding would be far faster (each registration pays for a bcrypt hash,
 * ~80 ms), but a token minted by the application is a token the application will accept, whereas a
 * hand-built one is an assumption about the signing algorithm and payload shape that can drift out
 * of date without any test noticing.
 *
 * The default password satisfies the 8-character minimum. `email` defaults to a unique address so
 * two calls in one test do not collide on the uniqueness constraint.
 */
let userCounter = 0;

async function createUser(overrides = {}) {
  userCounter += 1;
  const credentials = {
    username: `user${userCounter}`,
    email: `user${userCounter}-${Date.now()}@example.test`,
    password: 'correct-horse-battery',
    ...overrides,
  };

  const registration = await request(app).post('/users').send(credentials);
  if (registration.status !== 201) {
    // Throwing with the body attached, rather than letting the caller's later expectation fail on a
    // missing token. A helper that fails should say why it failed, not hand back `undefined` and let
    // the symptom surface three lines later as "expected 200, got 401".
    throw new Error(`createUser: registration returned ${registration.status}: ${JSON.stringify(registration.body)}`);
  }

  const login = await request(app).post('/users/login').send({
    email: credentials.email,
    password: credentials.password,
  });
  if (login.status !== 200) {
    throw new Error(`createUser: login returned ${login.status}: ${JSON.stringify(login.body)}`);
  }

  return {
    ...credentials,
    userId: login.body.userId,
    token: login.body.token,
    /** `auth(request(app).get('/x'))` — attaches this user's bearer token to a supertest request. */
    auth: (req) => req.set('Authorization', `Bearer ${login.body.token}`),
  };
}

/** A valid transaction body, with overrides for the field a given test is about. */
function transactionBody(overrides = {}) {
  return { type: 'expense', category: 'groceries', amount: 42.5, date: '2026-01-15', ...overrides };
}

module.exports = {
  app,
  request,
  dataDir,
  usersFile,
  transactionsFile,
  resetData,
  readUsersFile,
  readTransactionsFile,
  createUser,
  transactionBody,
};
