# FinEdge Expense Tracker API

A REST API for tracking personal income and expenses. Node.js and Express, with JWT authentication,
row-level ownership, and JSON files for persistence.

This README describes what the code actually does. That is worth saying explicitly, because the
version it replaces advertised a Budget entity, MongoDB, rate limiting, CORS and in-memory caching —
none of which existed — and documented the summary endpoint at a path that was never registered. A
README that overstates is worse than a short one: it sends a reader looking for code that is not
there, and every claim in it is a claim you have to be able to defend.

## Quick start

```bash
npm install
cp .env.example .env        # then set JWT_SECRET — see below
npm start                   # or: npm run dev  (restarts on change)
npm test
```

`JWT_SECRET` has no default and the process **refuses to start without it**. That is deliberate: a
missing secret is a deployment problem, and the cheapest place to catch a deployment problem is at
boot rather than on a user's first login. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Environment variables

| Variable         | Required | Default     | Notes                                                        |
|------------------|----------|-------------|--------------------------------------------------------------|
| `JWT_SECRET`     | yes      | —           | Signs and verifies tokens. Warns below 32 characters.        |
| `PORT`           | no       | `3000`      | Validated as an integer 0–65535.                             |
| `NODE_ENV`       | no       | `development` | `test` allows a fixed dummy secret so `npm test` needs no `.env`. |
| `JWT_EXPIRES_IN` | no       | `1h`        | Any `jsonwebtoken` duration string.                          |
| `DATA_DIR`       | no       | `src/data`  | Where the JSON files live. The test suite points this at a temp directory. |

## Authentication

`POST /users` then `POST /users/login`. Login returns a JWT; send it on every transaction request:

```
Authorization: Bearer <token>
```

Every route under `/transactions` requires it — mounted once for the whole router rather than named
per route, so a route added later is protected by default and making one public has to be a
deliberate, visible act.

## Endpoints

| Method   | Route                     | Auth | Description                                   |
|----------|---------------------------|------|-----------------------------------------------|
| `GET`    | `/health`                 | no   | Liveness probe. `{ "status": "OK" }`.         |
| `POST`   | `/users`                  | no   | Register. Returns `{ userId }`.               |
| `POST`   | `/users/login`            | no   | Returns `{ token, userId }`.                  |
| `POST`   | `/transactions`           | yes  | Create. All four fields required.             |
| `GET`    | `/transactions`           | yes  | List the caller's own transactions.           |
| `GET`    | `/transactions/summary`   | yes  | Income/expense totals and category breakdown. |
| `GET`    | `/transactions/insights`  | yes  | Suggested monthly budget.                     |
| `GET`    | `/transactions/:id`       | yes  | One transaction, if it is the caller's.       |
| `PATCH`  | `/transactions/:id`       | yes  | Partial update. At least one field.           |
| `DELETE` | `/transactions/:id`       | yes  | Delete.                                       |

The summary lives at `/transactions/summary`, not `/summary`: it is a derived view of the
transactions collection rather than a resource of its own. Note that `/summary` and `/insights` are
registered **before** `/:id` — `/:id` is a wildcard that would otherwise match the literal string
`"summary"` and answer `404 Transaction not found`.

### Transaction shape

```json
{
  "type": "expense",
  "category": "groceries",
  "amount": 42.50,
  "date": "2026-01-15"
}
```

| Field      | Rules                                                                              |
|------------|------------------------------------------------------------------------------------|
| `type`     | Exactly `"income"` or `"expense"`.                                                 |
| `category` | Non-empty string, ≤ 64 characters, trimmed on save.                                |
| `amount`   | Finite number, **≥ 0** (`0` is valid), ≤ 2 decimal places, ≤ 1e12.                 |
| `date`     | `YYYY-MM-DD`, and a date that really exists.                                       |

`amount` is a magnitude, not a signed value — direction is carried by `type`. A negative "expense"
would *reduce* total expenses and inflate the balance, so it is rejected rather than stored.

Server-controlled fields (`id`, `userId`, `createdAt`) are ignored if a client sends them, and any
field not in the table above is dropped rather than stored.

### Errors

One shape for every error, so a client that can parse one can parse all of them:

```json
{ "error": "VALIDATION_ERROR", "message": "Invalid transaction data",
  "details": { "amount": "must not be negative (use type: expense instead of a negative amount)" } }
```

`details` reports **every** invalid field at once, rather than making a client fix one and resubmit
to discover the next.

| Status | When                                                                       |
|--------|----------------------------------------------------------------------------|
| `400`  | Malformed body or failed validation.                                       |
| `401`  | Missing, malformed, expired or invalid token; wrong login credentials.      |
| `404`  | No such route, or no such transaction **belonging to the caller**.          |
| `409`  | Email already registered.                                                  |
| `413`  | Body over 100 kB.                                                          |
| `500`  | Server fault. The body never carries internal detail.                      |

A transaction that exists but belongs to someone else returns `404`, not `403`. `403` would be more
literally accurate and is the wrong answer: the difference between the two codes tells a caller
whether a given id exists, so iterating over ids would map out which of another user's records are
live without ever returning a field of their data.

## Design notes

Things in here that were decided rather than defaulted. Each is explained at length in a comment at
the top of the relevant file.

- **Row-level ownership** (`src/models/transactionModel.js`). Every read and write takes an `ownerId`
  and filters on it, inside the storage layer rather than in the service. A new endpoint that forgets
  to scope throws on the first call instead of silently returning someone else's data.
- **Serialised writes** (`src/utils/jsonStore.js`). Node is single-threaded but not uninterrupted: at
  every `await` the handler suspends and another request runs, so a read-modify-write across an
  `await` loses updates. Before this, 25 simultaneous creates all returned `201` and left **one**
  record on disk. Writes now hold a per-file lock and replace the file atomically (temp file +
  rename), so reads need no lock at all and never see a partial file.
- **Email uniqueness is enforced inside the write lock**, not by a check in the service. Those are two
  separate `await`s, so concurrent registrations both pass the check — and two rows for one address
  means whichever one `find` reaches first decides whose password works.
- **Fail fast on config** (`src/config.js`). Environment variables are read and validated in one place
  at boot.
- **`app.js` does not listen** (`src/server.js` does). Importing a module should not bind a port.
- **Money is summed in integer cents** (`src/utils/analytics.js`), because `0.1 + 0.2` is not `0.3`.
  Storing floats is still a compromise; the honest fix is to store minor units, which is noted in the
  file rather than quietly ignored.

## Known limitations

Stated rather than left for a reader to discover:

- **JSON files, single process.** The write lock is an in-process `Map`, so two instances sharing a
  data directory would race. This is a learning project's persistence layer, not a production one.
- **No `fsync`.** A write survives a process crash but not necessarily an OS crash.
- **No refresh tokens or logout.** A token is valid until it expires; there is no revocation list.
- **Login leaks timing, not messages.** Wrong-password and unknown-email return an identical `401`,
  but an unknown email skips the ~80 ms bcrypt comparison, so the two are distinguishable by
  response time. Closing that means comparing against a dummy hash.
- **Email shape is checked, not existence.** Real verification is a confirmation email; there is no
  mail sender here.
- **Registration reveals whether an address is taken.** Unavoidable while duplicate prevention answers
  synchronously; the fix is to accept the registration and mail the address either way.
- **No rate limiting.** Login is therefore online-brute-forceable.

## Project layout

```
src/
  server.js              process entry point — the only file that binds a port
  app.js                 Express wiring; exports the app
  config.js              environment variables, validated once at boot
  errors.js              AppError hierarchy; carries statusCode + a client-safe `expose` flag
  routes/                health, users, transactions
  controllers/           HTTP in, HTTP out
  services/              application logic
  models/                persistence, owner-scoped
  middleware/            auth, validator, errorHandler, logger
  utils/
    jsonStore.js         write lock + atomic file replacement
    analytics.js         totals and category breakdown
    insights.js          rule-based monthly budget suggestion
  data/                  users.json, transactions.json
tests/                   jest + supertest; each file gets its own temp DATA_DIR
```

## Tests

```bash
npm test                 # 105 tests
npm run test:coverage
```

The suite is deliberately weighted towards negative cases. An authentication test that only proves a
valid token works is compatible with a middleware that accepts anything at all, so the tests that
matter are the ones asserting a forged token, an `alg: none` token, an expired token and another
user's record are all refused — and that a delete removes *only* the named record, since the original
predicate kept the match and discarded everything else.

It was also checked by mutation testing: each original defect was reintroduced one at a time to
confirm the suite goes red. That exercise found a live bug — the decimal-places check was
`Math.round(value * 100) !== value * 100`, and since `4.35 * 100` is `434.99999999999994`, it rejected
ordinary prices like `4.35`, `8.7` and `1.15`. A validation rule implemented with the very
floating-point arithmetic it was written to guard against.

## License

MIT — see [LICENSE](LICENSE).
