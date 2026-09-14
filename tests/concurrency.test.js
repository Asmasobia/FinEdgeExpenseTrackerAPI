/**
 * Concurrent-write tests: the lost update, and the lock that prevents it.
 *
 * These are the tests that fail hardest against the code as it was. Measured during development,
 * against the commit before the write lock existed: 25 simultaneous POSTs all answered 201 and left
 * **one** record on disk. Twenty-four transactions acknowledged as created, and gone.
 *
 * Why the bug exists at all, in one paragraph
 * --------------------------------------------------------------------------------
 * Node is single-threaded, which is widely misread as "my handler cannot be interrupted". It cannot
 * be interrupted *between* statements — but at every `await` the handler suspends and the event loop
 * runs somebody else's request. So a read-modify-write spread across an `await`:
 *
 *     const all = await read();      // request A reads [x]
 *     all.push(newOne);              //   ... request B reads [x] here
 *     await write(all);              // A writes [x, a];  B writes [x, b] — A's record is gone
 *
 * is a race in exactly the way it would be with threads. No amount of care in the handler fixes it;
 * the read and the write have to be made indivisible, which is what `jsonStore.mutate` does.
 *
 * Two notes on what these tests can and cannot prove:
 *
 *   - The `Promise.all` fan-out below is genuine concurrency for this purpose. supertest opens a real
 *     socket per request, so the requests interleave in the event loop exactly as they would from
 *     separate clients. What it does NOT reproduce is concurrency across *processes* — the lock is an
 *     in-process Map, so two deployed instances sharing a data file would still race. That is a
 *     documented limit of the JSON-file design, not an oversight, and it is stated in jsonStore.js.
 *   - The read-during-write test asserts that no read ever observes a truncated file. Be aware that
 *     it did NOT fail against the pre-atomic-write code when tried during development, across several
 *     attempts including a 400-record seed to widen the truncate window. The atomic rename is
 *     justified by `fs.writeFile`'s truncate-then-write semantics and by crash safety, not by an
 *     observed torn read here. The test is kept as a regression guard; it is not evidence.
 */

const fs = require('fs/promises');

const {
  app,
  request,
  createUser,
  resetData,
  transactionBody,
  readTransactionsFile,
  readUsersFile,
  transactionsFile,
} = require('./helpers');
const { withLock, mutate } = require('../src/utils/jsonStore');

let user;

beforeEach(async () => {
  await resetData();
  user = await createUser();
});

describe('concurrent writes through the API', () => {
  it('persists every one of 25 simultaneous creates', async () => {
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        user.auth(request(app).post('/transactions')).send(transactionBody({ amount: i + 1 }))
      )
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);

    // The assertion that matters is against the FILE, not the responses. Every response was 201
    // before the fix too — that is what makes a lost update so dangerous. The client is told the
    // record exists. Nothing anywhere logs a problem. The data is simply not there.
    const stored = await readTransactionsFile();
    expect(stored).toHaveLength(25);

    // And each one is the record its own response described, not 25 copies of the last writer.
    const storedIds = new Set(stored.map((t) => t.id));
    for (const response of responses) {
      expect(storedIds.has(response.body.id)).toBe(true);
    }
  });

  it('keeps every record when creates, updates and deletes interleave', async () => {
    // A homogeneous burst of creates is the easiest case to reason about; a mixed burst is closer to
    // real traffic and exercises the paths that rewrite an existing array rather than appending.
    const seeded = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        user.auth(request(app).post('/transactions')).send(transactionBody({ amount: 100 + i }))
      )
    );
    const ids = seeded.map((r) => r.body.id);

    await Promise.all([
      // 5 deletes, 5 patches on the remaining 5, and 5 new creates — all at once.
      ...ids.slice(0, 5).map((id) => user.auth(request(app).delete(`/transactions/${id}`))),
      ...ids.slice(5).map((id) => user.auth(request(app).patch(`/transactions/${id}`)).send({ amount: 7 })),
      ...Array.from({ length: 5 }, () => user.auth(request(app).post('/transactions')).send(transactionBody())),
    ]);

    const stored = await readTransactionsFile();
    // 10 seeded - 5 deleted + 5 created = 10. Any lost update shows up as a count that is too high
    // (a delete was discarded) or too low (a create was discarded), and both are failures.
    expect(stored).toHaveLength(10);
    // The five that were patched all took the new value — none of the patches was overwritten by a
    // concurrent delete's rewrite of the array.
    expect(stored.filter((t) => t.amount === 7)).toHaveLength(5);
    // And none of the deleted ids came back from a stale in-memory array.
    for (const id of ids.slice(0, 5)) {
      expect(stored.find((t) => t.id === id)).toBeUndefined();
    }
  });

  it('never lets a read observe a partially written file', async () => {
    // Seeded large enough that writing it is not instantaneous — a bigger payload means a wider
    // window between truncate and the last byte, if such a window is observable at all. See the
    // honesty note in this file's header: this did not reproduce a torn read against the old code.
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        user.auth(request(app).post('/transactions')).send(transactionBody({ amount: i + 1 }))
      )
    );

    const writes = Array.from({ length: 15 }, () =>
      user.auth(request(app).post('/transactions')).send(transactionBody())
    );
    const reads = Array.from({ length: 30 }, () => user.auth(request(app).get('/transactions')));

    const [writeResults, readResults] = await Promise.all([Promise.all(writes), Promise.all(reads)]);

    expect(writeResults.every((r) => r.status === 201)).toBe(true);
    // A read hitting a truncated or half-written file would fail to parse and surface as a 500. Every
    // read returning 200 with an array is the property being guarded: readers never block writers and
    // never see an inconsistent snapshot, which is what makes it safe for reads to skip the lock
    // entirely rather than queueing behind every POST.
    for (const res of readResults) {
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  it('leaves no temp files behind after a burst of writes', async () => {
    await Promise.all(
      Array.from({ length: 15 }, () => user.auth(request(app).post('/transactions')).send(transactionBody()))
    );

    const entries = await fs.readdir(require('path').dirname(transactionsFile));
    // Atomic writes work by writing a sibling temp file and renaming it over the target. A leaked
    // temp file means a rename failed silently — and on Windows renames genuinely can fail
    // transiently (EPERM/EACCES/EBUSY) when an antivirus scanner or file watcher holds a handle,
    // which is why the store retries. This asserts the cleanup half of that path.
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('email uniqueness under concurrency', () => {
  it('allows exactly one of eight simultaneous registrations of the same address', async () => {
    const credentials = { username: 'racer', email: 'race@example.test', password: 'a-long-enough-password' };

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post('/users').send(credentials))
    );

    const created = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    // Measured against the pre-lock code: 7 of 8 answered 201 and the file held 2 rows for one
    // address. This is the one place in the application where a lost update is a *security* problem
    // rather than a data-loss problem — with two rows for one email, "log in as that address"
    // resolves to whichever `find` reaches first, so one person's password silently governs the
    // other's account.
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(7);

    // The service's own `findByEmail` check cannot deliver this: it is a separate `await` from the
    // insert, so all eight requests pass it before any of them writes (time-of-check-to-time-of-use).
    // The authoritative check is the one inside the store's critical section, against the array that
    // is about to be written — the same reason a real database uses a UNIQUE constraint rather than a
    // SELECT in application code.
    const users = await readUsersFile();
    expect(users.filter((u) => u.email === 'race@example.test')).toHaveLength(1);
  });

  it('serialises registrations of different addresses without losing any', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app)
          .post('/users')
          .send({ username: `u${i}`, email: `u${i}@example.test`, password: 'a-long-enough-password' })
      )
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    // 8 new, plus the one created in beforeEach.
    expect(await readUsersFile()).toHaveLength(9);
  });
});

describe('jsonStore.withLock', () => {
  // Unit tests on the lock itself, below the HTTP layer. The API tests above prove the outcome; these
  // prove the mechanism, and they are the ones that pin down the two subtleties that are easy to get
  // wrong when editing it.

  it('runs queued tasks one at a time, in order', async () => {
    const events = [];
    const task = (id) => async () => {
      events.push(`start-${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end-${id}`);
      return id;
    };

    const results = await Promise.all([withLock('k', task(1)), withLock('k', task(2)), withLock('k', task(3))]);

    expect(results).toEqual([1, 2, 3]);
    // Strictly non-overlapping: every start is immediately followed by its own end. Without the lock
    // this would be start-1, start-2, start-3, end-1, end-2, end-3.
    expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  });

  it('does not serialise different keys against each other', async () => {
    const events = [];
    const task = (id) => async () => {
      events.push(`start-${id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end-${id}`);
    };

    await Promise.all([withLock('a', task('a')), withLock('b', task('b'))]);

    // Interleaved, which is the point of keying the lock by file path: a write to users.json must not
    // have to wait behind a write to transactions.json. A single global lock would be correct and
    // needlessly slow.
    expect(events).toEqual(['start-a', 'start-b', 'end-a', 'end-b']);
  });

  it('keeps running queued tasks after one of them throws', async () => {
    // THE poisoned-chain test, and the reason the implementation reads `previous.then(task, task)`
    // with the task as BOTH handlers. Written the obvious way — `previous.then(task)` — a single
    // failed write rejects the chain, and every task queued behind it never runs. Not "fails": never
    // runs. No error is raised, because the code that would have thrown was never entered, so the
    // symptom is requests that hang forever with nothing in the logs. This is the promise-chain
    // equivalent of using `finally` rather than `then`.
    const failing = withLock('poison', async () => {
      throw new Error('deliberate');
    });

    await expect(failing).rejects.toThrow('deliberate');

    const after = await withLock('poison', async () => 'still works');
    expect(after).toBe('still works');
  });

  it('recovers after a genuinely corrupt data file is repaired', async () => {
    // The same hazard, end to end rather than in isolation: a real write failure (unparseable JSON on
    // disk) must not strand every subsequent write to that file.
    await fs.writeFile(transactionsFile, '{ this is not json');

    const failed = await user.auth(request(app).post('/transactions')).send(transactionBody());
    expect(failed.status).toBe(500);

    await fs.writeFile(transactionsFile, '[]');

    const recovered = await Promise.all(
      Array.from({ length: 5 }, () => user.auth(request(app).post('/transactions')).send(transactionBody()))
    );
    expect(recovered.every((r) => r.status === 201)).toBe(true);
    expect(await readTransactionsFile()).toHaveLength(5);
  });

  it('writes nothing when the mutator returns null', async () => {
    await fs.writeFile(transactionsFile, JSON.stringify([{ id: 'keep' }]));
    const before = await fs.stat(transactionsFile);

    const result = await mutate(transactionsFile, () => null);

    expect(result).toBeNull();
    expect(await readTransactionsFile()).toEqual([{ id: 'keep' }]);
    // Same size and content: the file was not rewritten at all. This is what lets a 404 path be
    // completely side-effect free, so a missing-id request cannot clobber a concurrent successful
    // write.
    expect((await fs.stat(transactionsFile)).size).toBe(before.size);
  });

  it('treats a missing file as an empty array rather than an error', async () => {
    await fs.rm(transactionsFile, { force: true });

    const res = await user.auth(request(app).get('/transactions'));

    // This is why there is no `ensureFile` helper any more. Handling ENOENT at the one place that
    // reads removed a whole category of "create the file first" bookkeeping — and, more usefully, it
    // means the read path needs no lock, because it no longer writes.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
