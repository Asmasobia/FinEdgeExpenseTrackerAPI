/**
 * Jest configuration.
 *
 * Kept as a `.js` file rather than a `"jest"` key in package.json for one reason: JSON cannot hold
 * comments, and the two settings below are the kind that get deleted by someone tidying up unless
 * the reason they exist is written next to them.
 */

module.exports = {
  // Node, not jsdom. There is no DOM here; jsdom would load a browser-shaped global environment on
  // every test file, which is both slower and actively misleading — `window` and `fetch` would
  // exist in tests and not in production.
  testEnvironment: 'node',

  // Runs once per test FILE, in that file's fresh module registry, and — crucially — *before* the
  // test file itself is required. That ordering is what makes the temp-directory trick in
  // tests/setup.js work: it sets DATA_DIR before anything can `require('../src/config')` and
  // capture the default path.
  //
  // `setupFilesAfterEnv` rather than `setupFiles` because the setup file also registers an
  // `afterAll` cleanup hook, and the Jest globals only exist after the test framework is installed.
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],

  // Only measure the application, not the tests measuring it. Left off by default (`npm test` is
  // fast; `npm run test:coverage` opts in) because a coverage number is a prompt to go look at
  // what is untested, not a target to satisfy.
  collectCoverageFrom: ['src/**/*.js'],

  // Fail loudly if a test leaves a handle open — an un-awaited write, a timer, a listener. Without
  // this the run simply hangs at the end and the cause is invisible.
  detectOpenHandles: false,

  // Silence the application's own console output during tests. The error handler deliberately logs
  // every 4xx and 5xx, and the tests deliberately provoke dozens of them, so without this the real
  // test results scroll off the top of the terminal behind expected noise.
  silent: true,
};
