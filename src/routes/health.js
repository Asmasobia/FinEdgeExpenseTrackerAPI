/**
 * Liveness endpoint: GET /health
 *
 * This file existed before and was never mounted — `app.js` declared an inline `/health` handler
 * instead, so editing this file had no effect on the running server. It is now the real route (see
 * the mount in src/app.js) and the inline handler is gone.
 *
 * What a health check is for, and what it must therefore NOT do
 * --------------------------------------------------------------------------------
 * A load balancer or container orchestrator polls this every few seconds to decide whether to keep
 * sending traffic to this process, and whether to restart it. That job description constrains the
 * implementation more than it first appears:
 *
 *   - No authentication. The prober has no credentials and cannot be given any. This is why the
 *     route lives in its own router rather than being added to an existing one: `userRoutes` and
 *     `transactionRoutes` are where a future `router.use(requireAuth)` might land, and a health
 *     check that starts answering 401 takes the whole service out of rotation.
 *   - No dependency checks. Deliberately: this reports only "the process is up and the event loop
 *     is turning". Reading the data files here would mean a transient disk problem gets answered
 *     with a failing health check, the orchestrator kills the container, the replacement finds the
 *     same disk problem, and something that would have degraded one endpoint instead crash-loops
 *     the entire service. Dependency status belongs on a separate readiness endpoint, whose failure
 *     means "stop sending me traffic" rather than "restart me".
 *   - Nothing about the deployment in the response. No version, no build id, no hostname, no
 *     uptime. It is unauthenticated and therefore world-readable, and every field added here is a
 *     field an attacker gets for free. `{ status: 'OK' }` is the whole useful payload; the status
 *     code is what a prober actually reads.
 *
 * The original also returned `message: 'Server is running'`, which restated the status code in
 * prose. Dropped — a probe parses neither.
 */

const express = require('express');

const router = express.Router();

// Mounted at `/health`, so the path here is '/' — a router's paths are relative to its mount point.
// Writing '/health' inside a router mounted at '/health' serves `/health/health`, which is a common
// enough mistake to be worth naming, because the resulting 404 looks like the file was not loaded.
router.get('/', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

module.exports = router;
