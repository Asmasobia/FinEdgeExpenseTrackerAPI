/**
 * Application-level plumbing: the health route, the 404 fallback, and the error handler's treatment
 * of failures that originate inside Express rather than inside our own code.
 *
 * These are the tests most likely to be skipped as "not worth writing", and they are the ones that
 * caught a regression during development: an early version of the error handler mapped *every*
 * non-AppError to 500, which silently turned body-parser's own 400 for malformed JSON into a 500.
 * Nothing in the business-logic tests would have noticed, because none of them send broken JSON.
 */

const { app, request } = require('./helpers');

describe('GET /health', () => {
  it('answers 200 with a minimal body and no authentication', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'OK' });
  });

  it('is served by src/routes/health.js, not a stale inline handler', async () => {
    // Asserts the absence of the mistake described in src/routes/health.js: a router mounted at
    // `/health` whose internal path is also '/health' serves `/health/health` and 404s on `/health`.
    // This test fails in both directions, which is what makes it worth having.
    const nested = await request(app).get('/health/health');
    expect(nested.status).toBe(404);
  });
});

describe('unmatched routes', () => {
  it('answer 404 in the same JSON shape as every other error', async () => {
    const res = await request(app).get('/no-such-route');

    expect(res.status).toBe(404);
    // The shape matters as much as the code. A client that can parse one error from this API should
    // be able to parse all of them; an HTML error page from Express's default handler here would
    // break a client that assumed JSON everywhere.
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.message).toContain('/no-such-route');
  });

  it('report the method, so a right-path-wrong-verb mistake is diagnosable', async () => {
    // `/health` exists for GET only. Without the method in the message this is indistinguishable
    // from a typo'd path, which is a genuinely annoying five minutes to debug.
    const res = await request(app).delete('/health');

    expect(res.status).toBe(404);
    expect(res.body.message).toContain('DELETE');
  });
});

describe('error handler', () => {
  it('passes through body-parser\'s 400 for malformed JSON instead of reporting 500', async () => {
    const res = await request(app)
      .post('/users')
      .set('Content-Type', 'application/json')
      .send('{"username": '); // deliberately truncated

    // 400, not 500: the client sent something wrong, and retrying the identical request cannot
    // help. Reporting this as 500 tells a client's retry logic to try again forever, and tells the
    // operator's alerting that the server is broken.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
  });

  it('does not leak internal detail in a 500 body', async () => {
    // Provoking a genuine 500 without breaking the app requires a fault we can inject, so this
    // mounts a throwing route on a *copy* of the pipeline rather than sabotaging the real app.
    // Using the real error handler is the point — the assertion is about its behaviour.
    const express = require('express');
    const { errorHandler } = require('../src/middleware/errorHandler');

    const probe = express();
    probe.get('/boom', () => {
      throw new Error('secret detail: /home/deploy/app/src/data/users.json is unreadable');
    });
    probe.use(errorHandler);

    const res = await request(probe).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Internal Server Error');
    // The specific thing being prevented: an error we did not author carries a message written for
    // a developer reading a log, and it routinely contains absolute paths, host names and query
    // fragments. Publishing it hands an attacker the deployment layout for free.
    expect(res.body.message).not.toContain('/home/deploy');
    expect(JSON.stringify(res.body)).not.toContain('secret detail');
  });
});
