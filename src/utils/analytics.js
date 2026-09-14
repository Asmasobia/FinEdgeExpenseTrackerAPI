/**
 * Aggregation over a user's transactions.
 *
 * The original, for reference:
 *
 *     exports.calculateSummary = (transactions) => {
 *       let totalExpense = 0, totalIncome = 0;
 *       transactions.forEach(t => {
 *         if (t.type === 'income') totalIncome += t.amount;
 *         else totalExpense += t.amount;      // <- everything that is not income
 *       });
 *       return { totalExpense, totalIncome, balance: totalIncome - totalExpense };
 *     };
 *
 * Two things wrong with it, one obvious and one not.
 *
 * 1. `else` treats every non-income record as an expense. That is currently harmless, because the
 *    validator constrains `type` to exactly two values — but "currently harmless because of a rule
 *    enforced in a different file" is precisely the kind of coupling that breaks quietly. Add a
 *    `transfer` type in six months and every transfer starts counting against the balance, with no
 *    error anywhere. Matching both types explicitly and ignoring anything else means a new type
 *    shows up as "not yet counted" rather than as "counted wrongly", and only one of those two
 *    failures is discoverable by looking at the number.
 *
 * 2. Floating-point accumulation. `0.1 + 0.2 === 0.30000000000000004` in IEEE 754, and the error
 *    compounds across a column of figures — so a summary over a few hundred records can report
 *    `1234.5600000000002`, or, worse, an off-by-a-cent balance that does not equal income minus
 *    expenses as a human would compute it. The fix is the standard one for money: do the arithmetic
 *    in MINOR UNITS as integers (cents), and convert back only at the end. Integers below 2^53 are
 *    exact in a JS number, which covers about 90 trillion cents.
 *
 *    Note this does not make float storage correct — the honest fix is to store minor units in the
 *    first place, which is what a real implementation should do. It does mean the aggregate is exact
 *    with respect to the values that were stored, which is the part that shows up in a response.
 */

/** Amount in cents, as an exact integer. Rounds because the stored value is a float. */
const toMinorUnits = (amount) => Math.round(amount * 100);

/** Back to a major-unit number with at most two decimals. */
const toMajorUnits = (minor) => minor / 100;

/**
 * Income/expense totals for one caller's transactions.
 *
 * Takes an already-scoped array. It does no filtering by owner and must not: an aggregate over the
 * wrong set leaks more insidiously than a list over the wrong set, because a wrong list looks wrong
 * and a wrong total looks plausible. Scoping belongs in the model, where it cannot be forgotten —
 * see the row-level ownership note in src/models/transactionModel.js.
 */
exports.calculateSummary = (transactions) => {
  let incomeMinor = 0;
  let expenseMinor = 0;
  let incomeCount = 0;
  let expenseCount = 0;
  const byCategoryMinor = new Map();

  for (const transaction of transactions) {
    // Defensive against a record with a non-numeric amount. The validator makes this unreachable
    // through the API, but this function also runs over whatever is on disk — including rows written
    // by an earlier version of the code, or hand-edited during development. Skipping is the right
    // choice over throwing: one malformed legacy row should not make the summary endpoint 500 and
    // take the whole feature down.
    if (!Number.isFinite(transaction.amount)) continue;

    const minor = toMinorUnits(transaction.amount);

    if (transaction.type === 'income') {
      incomeMinor += minor;
      incomeCount += 1;
    } else if (transaction.type === 'expense') {
      expenseMinor += minor;
      expenseCount += 1;
      // Category totals only for expenses. Grouping income by category too would be easy and would
      // mean "groceries" could hold a mix of both, so the number would answer no question anyone
      // asks. This feeds the spending insights in src/utils/insights.js.
      const category = typeof transaction.category === 'string' ? transaction.category : 'uncategorised';
      byCategoryMinor.set(category, (byCategoryMinor.get(category) ?? 0) + minor);
    }
    // Anything else is deliberately not counted. See note 1 in the header.
  }

  // Sorted highest-first so the caller does not have to, and so the response is deterministic —
  // Map iteration order is insertion order, which for this data means "whatever order the file
  // happened to be in", and a response that reorders between identical requests is a nuisance to
  // test and to diff.
  const byCategory = [...byCategoryMinor.entries()]
    .map(([category, minor]) => ({ category, total: toMajorUnits(minor) }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  return {
    totalIncome: toMajorUnits(incomeMinor),
    totalExpense: toMajorUnits(expenseMinor),
    // Subtracted in minor units, then converted — not `totalIncome - totalExpense`, which would
    // reintroduce a float subtraction on the two values we just carefully computed exactly.
    balance: toMajorUnits(incomeMinor - expenseMinor),
    transactionCount: incomeCount + expenseCount,
    incomeCount,
    expenseCount,
    byCategory,
  };
};
