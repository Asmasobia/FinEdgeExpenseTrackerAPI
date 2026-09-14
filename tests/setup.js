/**
 * Per-test-file isolation: give every test file its own data directory.
 *
 * Referenced from jest.config.js as `setupFilesAfterEnv`, which means Jest runs this once per test
 * FILE, before that file's module body is evaluated, in a module registry of its own.
 *
 * Why this file has to exist
 * --------------------------------------------------------------------------------
 * `src/config.js` resolves `dataDir` once, at require time. Without this setup, that resolves to
 * the repository's own `src/data/`, so:
 *
 *   - Running the tests would overwrite the developer's real users.json and transactions.json, and
 *     leave them modified in `git status` afterwards. A test suite that dirties the working tree
 *     gets run less often, and a test suite that is run less often is worth less.
 *   - Test files could not run in parallel. Jest executes each file in a separate worker *process*,
 *     and the write lock in src/utils/jsonStore.js is an in-process Map — it does not span
 *     processes. Two files sharing one data file would race exactly as two deployed servers would,
 *     and the failures would be intermittent and blamed on the tests rather than understood.
 *   - Tests could not assume a starting state, because whatever the previous file left behind would
 *     still be there.
 *
 * Setting the environment variable here rather than in a global setup is what buys the per-file
 * granularity: `crypto.randomUUID()` is evaluated once per file, so two files never collide even
 * inside the same worker running them back to back.
 *
 * Note the ordering constraint this creates for every test file: `require('../src/app')` (and
 * anything else that reaches config) must happen at the top of the test file, not at the top of
 * this one. If this file required the app, it would do so before it had finished setting DATA_DIR —
 * and config's module body, having run once, would keep the wrong path forever.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// `os.tmpdir()`, not a directory inside the repo. A test run that is killed halfway through leaves
// its directory behind; in the OS temp dir that is the OS's problem to reap, whereas inside the
// repo it would show up as untracked files in `git status` and eventually get committed.
const dataDir = path.join(os.tmpdir(), `finedge-tests-${process.pid}-${crypto.randomUUID()}`);

fs.mkdirSync(dataDir, { recursive: true });

// Absolute path. `config.js` runs it through `path.resolve(__dirname, '..', value)`, and resolve
// returns an absolute input unchanged — so an absolute value here is used verbatim regardless of
// where the repo sits on disk.
process.env.DATA_DIR = dataDir;

// Exported so a test can assert against the files directly — reading what is actually on disk is
// the only way to distinguish "the API answered 201" from "the record was persisted", which is the
// entire distinction the lost-update tests are about.
global.TEST_DATA_DIR = dataDir;

afterAll(() => {
  // `force` so a file already gone is not an error, `recursive` for the directory itself, and the
  // whole thing wrapped because a failure to clean up a temp directory must not fail the test run.
  // On Windows an antivirus scanner or an indexer can briefly hold a handle on a just-written file,
  // and that is not a reason to report a red build.
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Deliberately swallowed. The OS reaps its temp directory; a warning here would be noise on
    // every run on some machines.
  }
});
