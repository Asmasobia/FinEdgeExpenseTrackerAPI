/**
 * Transaction CRUD, cross-user isolation, validation, and the two derived views.
 *
 * The isolation block is the important one. Before the auth work, transactions carried no `userId`
 * at all — one shared global ledger where every caller saw and edited everyone's spending — so these
 * tests are the executable statement of the invariant that replaced it: a user can observe and affect
 * their own records and nothing else, through any verb, on any route.
 */

const { app, request, createUser, resetData, transactionBody, readTransactionsFile } = require('./helpers');

let alice;
let bob;

beforeEach(async () => {
  await resetData();
  // Two users created fresh per test rather than once in `beforeAll`. Sharing them would be roughly
  // twice as fast (each `createUser` pays for two bcrypt hashes), and it would couple the tests: one
  // test's leftover transactions would be visible to the next, so a test asserting "alice has one
  // transaction" would pass or fail depending on execution order.
  [alice, bob] = await Promise.all([createUser(), createUser()]);
});

describe('POST /transactions', () => {
  it('creates a transaction owned by the caller', async () => {
    const res = await alice.auth(request(app).post('/transactions')).send(transactionBody());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'expense', category: 'groceries', amount: 42.5, date: '2026-01-15' });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.userId).toBe(alice.userId);
    expect(res.body.createdAt).toEqual(expect.any(String));
  });

  it('generates a unique id rather than a timestamp', async () => {
    // The original used `Date.toISOString()` as the id — which crashed, because that is an instance
    // method, not a static one. The obvious repair, `new Date().toISOString()`, would have run and
    // been wrong: two transactions created in the same millisecond collide, and because the file is
    // keyed by id, one would then shadow the other on lookup, update and delete. Creating two at once
    // is what makes that concrete.
    const [first, second] = await Promise.all([
      alice.auth(request(app).post('/transactions')).send(transactionBody()),
      alice.auth(request(app).post('/transactions')).send(transactionBody()),
    ]);

    expect(first.body.id).not.toBe(second.body.id);
  });

  it('ignores a client-supplied id and userId', async () => {
    const res = await alice
      .auth(request(app).post('/transactions'))
      .send({ ...transactionBody(), id: 'chosen-by-client', userId: bob.userId, createdAt: '1999-01-01' });

    expect(res.body.id).not.toBe('chosen-by-client');
    // The `userId` case is the one with teeth: honouring it would let a caller file entries in a
    // stranger's ledger. `id` matters too — choosing your own primary key means being able to
    // overwrite an existing record through the create endpoint.
    expect(res.body.userId).toBe(alice.userId);
    expect(res.body.createdAt).not.toBe('1999-01-01');

    const stored = await readTransactionsFile();
    expect(stored).toHaveLength(1);
    expect(stored[0].userId).toBe(alice.userId);
  });

  it('does not store unrecognised fields', async () => {
    await alice
      .auth(request(app).post('/transactions'))
      .send({ ...transactionBody(), note: 'arbitrary', isSettled: true });

    const [stored] = await readTransactionsFile();
    // Mass assignment again, on the resource where it is easiest to overlook. Storage receives
    // `req.validated`, built from the four known fields only.
    expect(stored).not.toHaveProperty('note');
    expect(stored).not.toHaveProperty('isSettled');
  });

  it('accepts an amount of 0', async () => {
    const res = await alice.auth(request(app).post('/transactions')).send(transactionBody({ amount: 0 }));

    // The original validator's `!amount` check rejected this. `0` is a coherent record — a refunded
    // purchase, a zero-rated line item — and `!x` means "absent" only for types where no valid value
    // is falsy. Numbers are not such a type.
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(0);
  });

  it.each([
    ['a negative amount', { amount: -500 }, 'amount'],
    ['a numeric string amount', { amount: '1200' }, 'amount'],
    ['NaN-producing amount', { amount: null }, 'amount'],
    ['more than 2 decimal places', { amount: 10.555 }, 'amount'],
    ['an unknown type', { type: 'transfer' }, 'type'],
    ['an empty category', { category: '   ' }, 'category'],
    ['an over-long category', { category: 'x'.repeat(65) }, 'category'],
    ['a non-ISO date', { date: '15/01/2026' }, 'date'],
    ['a vague date', { date: 'yesterday' }, 'date'],
    ['a date that does not exist', { date: '2026-02-30' }, 'date'],
  ])('rejects %s', async (_label, override, field) => {
    const res = await alice.auth(request(app).post('/transactions')).send(transactionBody(override));

    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty(field);
  });

  it.each([4.35, 8.7, 1.15, 0.29, 2.5, 0.01, 999999.99])('accepts the ordinary two-decimal amount %p', async (amount) => {
    const res = await alice.auth(request(app).post('/transactions')).send(transactionBody({ amount }));

    // Every one of these was REJECTED by an earlier version of the validator, which tested decimal
    // places with `Math.round(value * 100) !== value * 100`. `4.35 * 100` is `434.99999999999994`, so
    // the check failed for values that are perfectly well formed — a validation rule implemented with
    // the very floating-point arithmetic it was written to guard against. Found by mutation-testing
    // this suite, not by reading the code.
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(amount);
  });

  it.each([10.555, 0.001, 1.0000001, 1e-7])('rejects the sub-cent amount %p', async (amount) => {
    const res = await alice.auth(request(app).post('/transactions')).send(transactionBody({ amount }));

    // `1e-7` is the case that needs the exponential branch in `decimalPlaces`: `String(1e-7)` is
    // `"1e-7"`, which contains no decimal point at all, so counting characters after a `.` would read
    // it as having zero decimal places and let a sub-cent amount through the exact check meant to
    // stop it.
    expect(res.status).toBe(400);
    expect(res.body.details.amount).toMatch(/2 decimal places/);
  });

  it('rejects an absurdly large amount', async () => {
    const res = await alice.auth(request(app).post('/transactions')).send(transactionBody({ amount: 1e15 }));

    // Bounded so the integer-cent arithmetic in the summary stays exact: cents above 2^53 stop being
    // exactly representable, and a total that silently loses precision is worse than a rejected input.
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty('amount');
  });

  it('rejects 2026-02-30 even though JavaScript parses it', async () => {
    // Worth its own test because the reason is genuinely surprising: `new Date('2026-02-30')` does not
    // produce an Invalid Date, it ROLLS OVER to 2026-03-02. So a `Number.isNaN(parsed.getTime())`
    // check passes and the record is stored under a date the user never entered — filed in the wrong
    // month, and therefore counted in the wrong month's budget. The round-trip comparison in
    // `validateDate` is what catches it.
    const res = await alice.auth(request(app).post('/transactions')).send(transactionBody({ date: '2026-02-30' }));

    expect(res.status).toBe(400);
    expect(new Date('2026-02-30').toISOString().slice(0, 10)).toBe('2026-03-02'); // the surprise, asserted
  });

  it('reports every invalid field at once', async () => {
    const res = await alice
      .auth(request(app).post('/transactions'))
      .send({ type: 'transfer', category: '', amount: -1, date: 'nope' });

    expect(res.status).toBe(400);
    // Fail-fast validation would make the client fix one field, resubmit, and discover the next —
    // four round trips to learn about four bad fields.
    expect(Object.keys(res.body.details).sort()).toEqual(['amount', 'category', 'date', 'type']);
  });

  it('reports missing fields as required', async () => {
    const res = await alice.auth(request(app).post('/transactions')).send({});

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({
      type: 'is required',
      category: 'is required',
      amount: 'is required',
      date: 'is required',
    });
  });

  it('trims the category so " Rent " and "Rent" are one category', async () => {
    await alice.auth(request(app).post('/transactions')).send(transactionBody({ category: '  Rent  ' }));

    const [stored] = await readTransactionsFile();
    expect(stored.category).toBe('Rent');
  });
});

describe('GET /transactions', () => {
  it('returns only the caller\'s own transactions', async () => {
    await alice.auth(request(app).post('/transactions')).send(transactionBody({ category: 'alice-only' }));
    await bob.auth(request(app).post('/transactions')).send(transactionBody({ category: 'bob-only' }));

    const res = await alice.auth(request(app).get('/transactions'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].category).toBe('alice-only');
    // Both halves asserted. "Alice sees her own record" would pass against a completely unscoped
    // endpoint; "and does not see Bob's" is the half that actually tests the scoping.
    expect(JSON.stringify(res.body)).not.toContain('bob-only');
  });

  it('returns an empty array for a user with no transactions', async () => {
    const res = await alice.auth(request(app).get('/transactions'));

    // 200 with `[]`, not 404. An empty collection is a valid state of an existing collection.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /transactions/:id', () => {
  it('returns the caller\'s own transaction', async () => {
    const created = await alice.auth(request(app).post('/transactions')).send(transactionBody());

    const res = await alice.auth(request(app).get(`/transactions/${created.body.id}`));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it('answers 404 for an id that does not exist', async () => {
    const res = await alice.auth(request(app).get('/transactions/no-such-id'));

    expect(res.status).toBe(404);
  });

  it('answers 404 — not 403 — for another user\'s transaction', async () => {
    const bobs = await bob.auth(request(app).post('/transactions')).send(transactionBody());

    const res = await alice.auth(request(app).get(`/transactions/${bobs.body.id}`));

    // 404, deliberately identical to the missing-id case above. 403 would be more literally accurate
    // and is the wrong answer: the difference between the two codes tells a caller whether an id
    // exists, so iterating over ids would map out which of another user's records are live — without
    // ever returning a field of their data. Leaking existence is a smaller leak than leaking content,
    // and it costs nothing to avoid.
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Transaction not found');
  });
});

describe('PATCH /transactions/:id', () => {
  it('updates a single field, leaving the rest alone', async () => {
    const created = await alice.auth(request(app).post('/transactions')).send(transactionBody());

    const res = await alice.auth(request(app).patch(`/transactions/${created.body.id}`)).send({ amount: 99.99 });

    // The original shared one validator between POST and PATCH, which required all four fields — so
    // this exact request was a 400 and the endpoint could not do the one thing its verb exists for.
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(99.99);
    expect(res.body.category).toBe('groceries');
    expect(res.body.date).toBe('2026-01-15');
  });

  it('rejects an empty patch instead of reporting a misleading success', async () => {
    const created = await alice.auth(request(app).post('/transactions')).send(transactionBody());

    const res = await alice.auth(request(app).patch(`/transactions/${created.body.id}`)).send({});

    // Without this check the request passes validation, spreads nothing, rewrites the file unchanged
    // and answers 200 — so a client with a typo'd field name (`ammount`) sees success and believes
    // the update landed. A silent no-op is worse than an error.
    expect(res.status).toBe(400);
  });

  it('ignores unknown fields in a patch', async () => {
    const created = await alice.auth(request(app).post('/transactions')).send(transactionBody());

    // Only unknown fields, so after whitelisting there is nothing left to change — which the empty
    // patch rule then rejects. That is the desired outcome: the client learns nothing it sent was
    // understood, instead of a 200 implying `ammount` was applied.
    const res = await alice.auth(request(app).patch(`/transactions/${created.body.id}`)).send({ ammount: 5 });

    expect(res.status).toBe(400);
    const [stored] = await readTransactionsFile();
    expect(stored.amount).toBe(42.5);
    expect(stored).not.toHaveProperty('ammount');
  });

  it('cannot be used to transfer a record to another user', async () => {
    const created = await alice.auth(request(app).post('/transactions')).send(transactionBody());

    await alice
      .auth(request(app).patch(`/transactions/${created.body.id}`))
      .send({ amount: 1, userId: bob.userId, id: 'renumbered' });

    const [stored] = await readTransactionsFile();
    // `id` and `userId` are re-asserted after the incoming data is spread, so the client's values
    // lose. Without that, a body naming another owner would move the record into a stranger's ledger
    // — or, more quietly, let a caller hide their own record from their own view.
    expect(stored.userId).toBe(alice.userId);
    expect(stored.id).toBe(created.body.id);
  });

  it('answers 404 for another user\'s transaction and does not modify it', async () => {
    const bobs = await bob.auth(request(app).post('/transactions')).send(transactionBody({ amount: 10 }));

    const res = await alice.auth(request(app).patch(`/transactions/${bobs.body.id}`)).send({ amount: 9999 });

    expect(res.status).toBe(404);
    // The second assertion is the one that matters. A 404 response proves what the caller was told;
    // reading the file proves what actually happened to the data.
    const [stored] = await readTransactionsFile();
    expect(stored.amount).toBe(10);
  });
});

describe('DELETE /transactions/:id', () => {
  it('deletes the caller\'s own transaction', async () => {
    const created = await alice.auth(request(app).post('/transactions')).send(transactionBody());

    const res = await alice.auth(request(app).delete(`/transactions/${created.body.id}`));

    // Every DELETE used to fail twice over: the controller referenced `re.params.id` (a typo for
    // `req`, so a ReferenceError), and the model function the service called did not exist under that
    // name. This is the test that proves the path works end to end.
    expect(res.status).toBe(200);
    expect(await readTransactionsFile()).toEqual([]);
  });

  it('deletes ONLY the named transaction', async () => {
    const keep = await alice.auth(request(app).post('/transactions')).send(transactionBody({ category: 'keep-1' }));
    const remove = await alice.auth(request(app).post('/transactions')).send(transactionBody({ category: 'remove' }));
    const keep2 = await alice.auth(request(app).post('/transactions')).send(transactionBody({ category: 'keep-2' }));

    await alice.auth(request(app).delete(`/transactions/${remove.body.id}`));

    // This is the single most important assertion in the file. The original predicate was
    // `filter(t => t.id === id)` — `filter` KEEPS what matches, so it kept the record being deleted
    // and discarded every other record in the file. Deleting one transaction would have erased the
    // entire ledger. A test that only checked "the deleted one is gone" would have passed against it.
    const remaining = (await readTransactionsFile()).map((t) => t.category).sort();
    expect(remaining).toEqual(['keep-1', 'keep-2']);
    expect([keep.body.id, keep2.body.id]).toHaveLength(2);
  });

  it('answers 404 for another user\'s transaction and leaves it on disk', async () => {
    const bobs = await bob.auth(request(app).post('/transactions')).send(transactionBody());

    const res = await alice.auth(request(app).delete(`/transactions/${bobs.body.id}`));

    expect(res.status).toBe(404);
    // Before ownership existed, this returned 200 and Bob's record was gone: any authenticated user
    // could delete any record whose id they could guess or observe.
    expect(await readTransactionsFile()).toHaveLength(1);
  });

  it('answers 404 for an id that never existed, without rewriting the file', async () => {
    await alice.auth(request(app).post('/transactions')).send(transactionBody());
    const before = await readTransactionsFile();

    const res = await alice.auth(request(app).delete('/transactions/no-such-id'));

    expect(res.status).toBe(404);
    // The model returns `null` for "nothing matched", and `mutate` skips the write entirely on null.
    // Otherwise every missing-id request would burn a disk write — and, worse, a failed lookup could
    // clobber a concurrent successful write.
    expect(await readTransactionsFile()).toEqual(before);
  });
});

describe('GET /transactions/summary', () => {
  it('is not shadowed by GET /:id', async () => {
    const res = await alice.auth(request(app).get('/transactions/summary'));

    // Route order. `/:id` is a wildcard that matches the literal string "summary", so registered
    // first it would send this to `getTransactionById`, which would find no such record and answer
    // `404 Transaction not found`. A confusing bug to chase — the route is registered, the handler is
    // correct, the URL is right, and it still 404s because a different handler answered.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('balance');
  });

  it('totals the caller\'s income and expenses', async () => {
    for (const body of [
      transactionBody({ type: 'income', amount: 5000, category: 'salary' }),
      transactionBody({ type: 'expense', amount: 1200, category: 'rent' }),
      transactionBody({ type: 'expense', amount: 300.5, category: 'groceries' }),
    ]) {
      await alice.auth(request(app).post('/transactions')).send(body);
    }

    const res = await alice.auth(request(app).get('/transactions/summary'));

    expect(res.body).toMatchObject({
      totalIncome: 5000,
      totalExpense: 1500.5,
      balance: 3499.5,
      transactionCount: 3,
      incomeCount: 1,
      expenseCount: 2,
    });
  });

  it('sums money exactly, without floating-point drift', async () => {
    for (const amount of [0.1, 0.2]) {
      await alice.auth(request(app).post('/transactions')).send(transactionBody({ type: 'expense', amount }));
    }

    const res = await alice.auth(request(app).get('/transactions/summary'));

    // `0.1 + 0.2 === 0.30000000000000004` in IEEE 754, so a naive accumulator reports that verbatim
    // in the response body — and the error compounds across a longer column. Summing in integer cents
    // and converting once at the end is what makes this exact.
    expect(res.body.totalExpense).toBe(0.3);
    expect(res.body.balance).toBe(-0.3);
  });

  it('rounds when converting to minor units, not just at the end', async () => {
    // A second, sharper case, and worth having as its own test because the first one does NOT pin
    // down the whole mechanism: `0.1 * 100` is exactly `10` in IEEE 754, so multiplying by 100
    // without rounding would still pass the test above. That was found by mutation-testing the
    // suite — deleting the `Math.round` from `toMinorUnits` left every test green, which means the
    // suite was not testing the thing its comment claimed.
    //
    // These three amounts are chosen because the multiplication itself is inexact:
    //   4.35 * 100 === 434.99999999999994
    //   8.70 * 100 === 869.9999999999999
    // so accumulating the unrounded products gives 13.399999999999999, identical to naive addition.
    // Rounding each amount to a whole number of cents *before* summing is what produces 13.4.
    for (const amount of [4.35, 8.7, 0.35]) {
      await alice.auth(request(app).post('/transactions')).send(transactionBody({ type: 'expense', amount }));
    }

    const res = await alice.auth(request(app).get('/transactions/summary'));

    expect(res.body.totalExpense).toBe(13.4);
    // The naive result, asserted explicitly so the value being avoided is visible rather than implied.
    expect(4.35 + 8.7 + 0.35).toBe(13.399999999999999);
  });

  it('excludes other users\' transactions from the totals', async () => {
    await alice.auth(request(app).post('/transactions')).send(transactionBody({ type: 'income', amount: 100 }));
    await bob.auth(request(app).post('/transactions')).send(transactionBody({ type: 'income', amount: 99999 }));

    const res = await alice.auth(request(app).get('/transactions/summary'));

    // An unscoped aggregate is a nastier leak than an unscoped list: a wrong list is visibly wrong —
    // you can see somebody else's rent in it — whereas a wrong total is a single plausible number,
    // and nothing about the response says whose spending it includes.
    expect(res.body.totalIncome).toBe(100);
  });

  it('groups expenses by category, highest first', async () => {
    for (const body of [
      transactionBody({ type: 'expense', amount: 50, category: 'food' }),
      transactionBody({ type: 'expense', amount: 900, category: 'rent' }),
      transactionBody({ type: 'expense', amount: 25, category: 'food' }),
      transactionBody({ type: 'income', amount: 4000, category: 'salary' }),
    ]) {
      await alice.auth(request(app).post('/transactions')).send(body);
    }

    const res = await alice.auth(request(app).get('/transactions/summary'));

    expect(res.body.byCategory).toEqual([
      { category: 'rent', total: 900 },
      { category: 'food', total: 75 },
    ]);
    // Income is deliberately absent from the breakdown: mixing both directions into one category
    // total produces a number that answers no question anyone asks.
    expect(res.body.byCategory.map((c) => c.category)).not.toContain('salary');
  });

  it('returns zeroes rather than NaN for a user with no transactions', async () => {
    const res = await alice.auth(request(app).get('/transactions/summary'));

    expect(res.body).toMatchObject({ totalIncome: 0, totalExpense: 0, balance: 0, byCategory: [] });
  });
});

describe('GET /transactions/insights', () => {
  it('is not shadowed by GET /:id', async () => {
    const res = await alice.auth(request(app).get('/transactions/insights'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('basis');
  });

  it('reports NO_EXPENSES rather than a number, when there are none', async () => {
    const res = await alice.auth(request(app).get('/transactions/insights'));

    expect(res.body.basis).toBe('NO_EXPENSES');
    // `null`, not `0`. The original computed `0 / 0`, got NaN, and its `|| 0` turned that into a
    // real-looking zero — which reaches the user as "your suggested budget is 0" with no explanation.
    expect(res.body.suggestedMonthlyBudget).toBeNull();
  });

  it('declines to suggest a budget from a single month of data', async () => {
    for (const date of ['2026-01-05', '2026-01-20']) {
      await alice.auth(request(app).post('/transactions')).send(transactionBody({ amount: 100, date }));
    }

    const res = await alice.auth(request(app).get('/transactions/insights'));

    // Extrapolating a monthly budget from one month produces a confident number that is mostly noise
    // — a month containing an annual insurance payment sets a budget nobody can hit. A confidently
    // wrong number is worse than an honest refusal, because the user acts on it.
    expect(res.body.basis).toBe('INSUFFICIENT_HISTORY');
    expect(res.body.suggestedMonthlyBudget).toBeNull();
    // The observed average is still reported, so the client has something true to show.
    expect(res.body.averageMonthlyExpense).toBe(200);
  });

  it('suggests a budget slightly below the monthly average once there are two months', async () => {
    for (const [date, amount] of [
      ['2026-01-05', 600],
      ['2026-01-20', 400],
      ['2026-02-10', 1000],
    ]) {
      await alice.auth(request(app).post('/transactions')).send(transactionBody({ amount, date }));
    }

    const res = await alice.auth(request(app).get('/transactions/insights'));

    expect(res.body.basis).toBe('MONTHLY_AVERAGE');
    expect(res.body.monthsObserved).toBe(2);
    // Per MONTH, not per transaction: 1000 in January and 1000 in February. The original averaged
    // across transactions, giving 666.67 — a figure that answers "how big is a typical purchase",
    // which is not a question anyone budgeting asks.
    expect(res.body.averageMonthlyExpense).toBe(1000);
    // Trimmed DOWN by 5%. The original multiplied UP by 1.1, i.e. advised spending 10% more than
    // current behaviour — the opposite of what a budget suggestion is for.
    expect(res.body.suggestedMonthlyBudget).toBe(950);
  });

  it('averages over months observed, not the calendar span between them', async () => {
    for (const [date, amount] of [
      ['2026-01-15', 1000],
      ['2026-12-15', 1000],
    ]) {
      await alice.auth(request(app).post('/transactions')).send(transactionBody({ amount, date }));
    }

    const res = await alice.auth(request(app).get('/transactions/insights'));

    // Two months of data eleven months apart. Dividing by the twelve-month span would suggest a
    // budget one sixth of what this person actually spends in a month they spend in.
    expect(res.body.monthsObserved).toBe(2);
    expect(res.body.averageMonthlyExpense).toBe(1000);
  });

  it('ignores income when suggesting a spending budget', async () => {
    for (const body of [
      transactionBody({ type: 'income', amount: 9000, date: '2026-01-01' }),
      transactionBody({ type: 'expense', amount: 500, date: '2026-01-02' }),
      transactionBody({ type: 'expense', amount: 500, date: '2026-02-02' }),
    ]) {
      await alice.auth(request(app).post('/transactions')).send(body);
    }

    const res = await alice.auth(request(app).get('/transactions/insights'));

    expect(res.body.averageMonthlyExpense).toBe(500);
    expect(res.body.suggestedMonthlyBudget).toBe(475);
  });

  it('is scoped to the caller', async () => {
    for (const date of ['2026-01-01', '2026-02-01']) {
      await bob.auth(request(app).post('/transactions')).send(transactionBody({ amount: 5000, date }));
    }

    const res = await alice.auth(request(app).get('/transactions/insights'));

    expect(res.body.basis).toBe('NO_EXPENSES');
  });
});
