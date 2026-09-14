/**
 * Registration, login, and the token check that guards every transaction route.
 *
 * The headline defect this repository started with was that tokens were *signed* and none was ever
 * *verified*, so the tests below are not decoration — several of them fail outright against the
 * original code. The ones that matter most are the negative cases: an authentication test suite that
 * only proves a valid token works is compatible with a middleware that accepts anything at all.
 */

const jwt = require('jsonwebtoken');

const config = require('../src/config');
const { app, request, createUser, resetData, readUsersFile } = require('./helpers');

beforeEach(resetData);

describe('POST /users — registration', () => {
  it('creates a user and returns only the id', async () => {
    const res = await request(app)
      .post('/users')
      .send({ username: 'asma', email: 'asma@example.test', password: 'a-long-enough-password' });

    expect(res.status).toBe(201);
    expect(res.body.userId).toEqual(expect.any(String));
    // Nothing else. Returning the created user object would ship the bcrypt hash to the client —
    // not an immediate compromise, since it is a slow offline target, but there is no reason to
    // publish it and plenty of ways for it to end up in a log or a client-side cache.
    expect(res.body).not.toHaveProperty('password');
  });

  it('stores the password as a bcrypt hash, never as plaintext', async () => {
    const password = 'a-long-enough-password';
    await request(app).post('/users').send({ username: 'asma', email: 'asma@example.test', password });

    // Reading the file directly rather than trusting a response body. This is the assertion that
    // would catch the single worst possible regression in this file, and it can only be made by
    // looking at what was actually persisted.
    const [stored] = await readUsersFile();
    expect(stored.password).not.toBe(password);
    expect(stored.password).toMatch(/^\$2[aby]\$\d\d\$/); // bcrypt's modular crypt prefix
  });

  it('rejects a duplicate email with 409, not 500', async () => {
    const body = { username: 'asma', email: 'dupe@example.test', password: 'a-long-enough-password' };
    await request(app).post('/users').send(body);

    const res = await request(app).post('/users').send({ ...body, username: 'someone-else' });

    // 409 Conflict. The original threw a bare Error and answered 500, which told the client to
    // retry a request that can never succeed.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });

  it('treats emails case-insensitively, so one address cannot become two accounts', async () => {
    await request(app)
      .post('/users')
      .send({ username: 'asma', email: 'Case@Example.test', password: 'a-long-enough-password' });

    const res = await request(app)
      .post('/users')
      .send({ username: 'other', email: 'case@example.test', password: 'a-long-enough-password' });

    expect(res.status).toBe(409);
    // The consequence if this were not enforced is not a cosmetic duplicate: "log in as
    // case@example.test" would resolve to whichever record `find` reached first, so one person's
    // password would silently govern the other's account.
    expect(await readUsersFile()).toHaveLength(1);
  });

  it('logs in with a different casing than was registered', async () => {
    await request(app)
      .post('/users')
      .send({ username: 'asma', email: 'MixedCase@Example.test', password: 'a-long-enough-password' });

    const res = await request(app)
      .post('/users/login')
      .send({ email: 'mixedcase@example.test', password: 'a-long-enough-password' });

    // The other half of the previous test. Normalising on write without normalising on read would
    // lock people out of their own accounts based on how they typed their address that day.
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it.each([
    ['missing username', { email: 'a@b.test', password: 'a-long-enough-password' }, 'username'],
    ['blank username', { username: '   ', email: 'a@b.test', password: 'a-long-enough-password' }, 'username'],
    ['malformed email', { username: 'a', email: 'not-an-email', password: 'a-long-enough-password' }, 'email'],
    ['short password', { username: 'a', email: 'a@b.test', password: 'short' }, 'password'],
    ['non-string password', { username: 'a', email: 'a@b.test', password: 12345678 }, 'password'],
  ])('rejects %s with a 400 naming the field', async (_label, body, field) => {
    const res = await request(app).post('/users').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    // Naming the offending field is the difference between an API a client can integrate against
    // and one where every 400 is a guessing game. `details` reports all failures at once, so a body
    // with four bad fields costs one round trip rather than four.
    expect(res.body.details).toHaveProperty(field);
  });

  it('rejects a password over bcrypt\'s 72-byte limit rather than silently truncating it', async () => {
    const res = await request(app)
      .post('/users')
      .send({ username: 'a', email: 'a@b.test', password: 'x'.repeat(100) });

    // bcrypt ignores everything past 72 bytes, silently. Accepting a 100-character password would
    // mean two passwords sharing a 72-byte prefix both authenticate — and the user would have no
    // way to know that most of what they typed was discarded.
    expect(res.status).toBe(400);
    expect(res.body.details.password).toMatch(/72 bytes/);
  });

  it('ignores extra fields in the body instead of storing them', async () => {
    await request(app).post('/users').send({
      username: 'asma',
      email: 'mass@example.test',
      password: 'a-long-enough-password',
      id: 'attacker-chosen-id',
      role: 'admin',
      createdAt: '1970-01-01T00:00:00.000Z',
    });

    const [stored] = await readUsersFile();
    // Mass assignment. The validator whitelists into `req.validated` and the controller persists
    // that, so a field the code does not know about cannot reach storage — which is what stops a
    // client from choosing its own id or inventing a `role` that some future authorisation check
    // might read.
    expect(stored).not.toHaveProperty('role');
    expect(stored.id).not.toBe('attacker-chosen-id');
    expect(stored.createdAt).not.toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('POST /users/login', () => {
  it('returns a token that carries the user id and nothing sensitive', async () => {
    const user = await createUser();

    // `jwt.decode`, not `verify`, and only in a test: the point here is to inspect the payload as
    // anyone holding the token can. A JWT payload is base64url-ENCODED, not encrypted — it is
    // readable by the client, by any proxy that logs the header, and by anyone who finds it in
    // localStorage. Which is exactly why a secret must never be put in one.
    const payload = jwt.decode(user.token);

    expect(payload.userId).toBe(user.userId);
    expect(payload).not.toHaveProperty('password');
    expect(payload).not.toHaveProperty('email');
    expect(payload.exp).toEqual(expect.any(Number)); // an expiry exists at all
  });

  it.each([
    ['a wrong password', { email: 'known@example.test', password: 'wrong-but-long-enough' }],
    ['an unknown email', { email: 'nobody@example.test', password: 'a-long-enough-password' }],
  ])('answers an identical opaque 401 for %s', async (_label, credentials) => {
    await createUser({ email: 'known@example.test', password: 'a-long-enough-password' });

    const res = await request(app).post('/users/login').send(credentials);

    expect(res.status).toBe(401);
    // Identical for both cases, deliberately. Distinguishing "no such user" from "wrong password"
    // turns login into an account-existence oracle: an attacker enumerates which addresses are
    // registered without ever guessing a password. Asserting the exact same message for both is how
    // that property gets defended against a well-meaning future change to "improve the error".
    expect(res.body.message).toBe('Invalid credentials');
    expect(res.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('does not apply the registration password rules at login', async () => {
    // A 6-character guess must produce the same 401 as any other wrong guess. A 400 saying "must be
    // at least 8 characters" would tell an attacker that guess is too short to be real — free
    // filtering of their search space — and would lock out accounts created before the rule.
    const res = await request(app).post('/users/login').send({ email: 'a@b.test', password: 'short' });

    expect(res.status).toBe(401);
  });
});

describe('requireAuth', () => {
  // Every one of these hits the same route. What differs is only the credential, which is the point:
  // the middleware is the subject, not the endpoint.
  const protectedRequest = () => request(app).get('/transactions');

  it('rejects a request with no Authorization header', async () => {
    const res = await protectedRequest();

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NO_CREDENTIALS');
  });

  it.each([
    ['no scheme', 'sometoken'],
    ['the wrong scheme', 'Basic sometoken'],
    ['an empty token', 'Bearer '],
    ['extra parts', 'Bearer a b'],
  ])('rejects a malformed header (%s)', async (_label, header) => {
    const res = await protectedRequest().set('Authorization', header);

    expect(res.status).toBe(401);
  });

  it('accepts the scheme case-insensitively, as RFC 7235 requires', async () => {
    const user = await createUser();

    const res = await protectedRequest().set('Authorization', `bearer ${user.token}`);

    // Not pedantry: the scheme name in an Authorization header is case-insensitive per the spec, and
    // clients in the wild send `bearer`. Rejecting it produces a 401 that looks like a credential
    // problem and is actually a string-comparison problem.
    expect(res.status).toBe(200);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ userId: 'whoever-i-like' }, 'not-the-real-secret', { expiresIn: '1h' });

    const res = await protectedRequest().set('Authorization', `Bearer ${forged}`);

    // THIS is the test that fails against the original code. The signature is the only thing
    // standing between a well-formed token and impersonation of any user; `jwt.decode` parses the
    // payload and checks nothing, so the original middleware would have accepted this and served
    // `whoever-i-like`'s data. It fails *open* — which is why it worked fine in manual testing.
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it('rejects an unsigned `alg: none` token', async () => {
    // The reason `algorithms: ['HS256']` is passed to `jwt.verify`. Without an explicit allow-list
    // the library honours the algorithm named in the token's own header — a field the token's author
    // controls. `alg: "none"` then means "there is no signature to check", and verification passes.
    const unsigned = jwt.sign({ userId: 'whoever-i-like' }, '', { algorithm: 'none' });

    const res = await protectedRequest().set('Authorization', `Bearer ${unsigned}`);

    expect(res.status).toBe(401);
  });

  it('rejects an expired token with a distinguishable code', async () => {
    const expired = jwt.sign({ userId: 'someone' }, config.jwtSecret, { expiresIn: '-1s' });

    const res = await protectedRequest().set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    // TOKEN_EXPIRED is separated from INVALID_TOKEN on purpose, and it is the one distinction worth
    // making: it tells a client to refresh rather than to send the user back to the login form. It
    // leaks nothing, because the expiry is already readable in the token the client is holding.
    expect(res.body.error).toBe('TOKEN_EXPIRED');
  });

  it('rejects a validly-signed token that carries no user identity', async () => {
    const anonymous = jwt.sign({ role: 'admin' }, config.jwtSecret, { expiresIn: '1h' });

    const res = await protectedRequest().set('Authorization', `Bearer ${anonymous}`);

    // A signature proves the token came from us; it does not prove the payload is the shape the
    // handlers expect. Without this check `req.user.userId` would be `undefined`, and an undefined
    // owner filter does not select nothing — it selects every record with no `userId`.
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it('does not leak the library\'s internal error text', async () => {
    const res = await protectedRequest().set('Authorization', 'Bearer not.a.jwt');

    expect(res.status).toBe(401);
    // jsonwebtoken's own messages ("invalid signature", "jwt malformed", "invalid algorithm") tell a
    // probing client exactly which check it failed and therefore how close it is. Our two fixed
    // messages tell it only that it failed.
    expect(['Invalid token', 'Token expired']).toContain(res.body.message);
  });

  it('guards every transaction route, not just the ones someone remembered', async () => {
    // Enumerated deliberately rather than spot-checking one route. `router.use(requireAuth)` guards
    // the whole router, so the property being tested is "no route on this router is reachable
    // unauthenticated" — and a new route added below it inherits that automatically. A test that
    // checked one path would keep passing if someone later moved a route above the `use`.
    const routes = [
      ['get', '/transactions'],
      ['get', '/transactions/summary'],
      ['get', '/transactions/insights'],
      ['get', '/transactions/some-id'],
      ['post', '/transactions'],
      ['patch', '/transactions/some-id'],
      ['delete', '/transactions/some-id'],
    ];

    for (const [method, path] of routes) {
      const res = await request(app)[method](path);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });
});
