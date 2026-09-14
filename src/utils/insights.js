/**
 * Spending insights: a deterministic, rule-based budget suggestion.
 *
 * This file was `src/utils/aiHelper.js` (renamed with `git mv`, so history follows it). Two reasons
 * for the rename, and the second is the one that matters:
 *
 *   - It was never imported anywhere. No route, no controller, no service — dead code that the
 *     README nonetheless advertised as an "AI/Automation" feature. It is now reachable at
 *     GET /transactions/insights.
 *   - There was no AI in it. It was an average multiplied by 1.1. Naming a heuristic "AI" is the
 *     kind of thing that gets asked about in an interview, and the honest answer — "it is arithmetic,
 *     the file name was aspirational" — is a worse position to be in than just calling it what it is.
 *     A deterministic rule is also the *better* engineering choice here: it is explainable to the
 *     person whose money it is, it costs nothing, it needs no network call, and it is testable with
 *     an exact assertion rather than a fuzzy one.
 *
 * The original, for reference:
 *
 *     exports.suggestBudget = (transactions) => {
 *       const expenses = transactions.filter(t => t.type === 'expense').map(t => t.amount);
 *       const avgExpense = expenses.reduce((a, b) => a + b, 0) / expenses.length || 0;
 *       return `Budget suggested is :${avgExpense * 1.1}`;
 *     };
 *
 * Its problems, worth separating because they are different classes of mistake:
 *
 *  1. **It returned a STRING, not a number.** `"Budget suggested is :1234.5600000000002"` cannot be
 *     compared, charted, summed or localised. A function that computes a number should return a
 *     number and let the presentation layer decide how to render it — the currency symbol, the
 *     decimal separator and the wording are all locale decisions, and burying them in a utility
 *     means they can only be changed here.
 *
 *  2. **Operator precedence bug.** `a / b || 0` parses as `(a / b) || 0`, not `a / (b || 0)`. That
 *     happens to work — an empty array gives `0 / 0` which is `NaN`, which is falsy, so `|| 0`
 *     catches it — but by accident rather than by design, and it is one edit away from breaking. It
 *     also silently converts `NaN` into a real-looking `0`, which is how a "your budget is 0"
 *     suggestion reaches a user with no explanation.
 *
 *  3. **An average of transaction amounts is not a budget.** The mean *per transaction* answers "how
 *     much is a typical purchase", which is not a question anyone budgeting asks. A budget is spend
 *     per unit of TIME. Twenty small purchases and one large one give the same mean regardless of
 *     whether they happened in a week or a year.
 *
 *  4. **1.1 was an unexplained magic number**, and multiplying a spending average *up* by 10% is
 *     advice to spend more than you already do — the opposite of what a budget suggestion is for.
 *
 * What replaces it
 * --------------------------------------------------------------------------------
 * A monthly budget derived from observed monthly spending, with the reasoning returned alongside the
 * number so the user can judge it. Three rules, applied in order:
 *
 *   - Spend is bucketed by calendar month and averaged over the months actually observed, so the
 *     figure is per-month rather than per-transaction.
 *   - The suggestion is the average shaded DOWN by a small factor, because the useful direction for
 *     a budget is slightly tighter than current behaviour. The factor is a named constant with the
 *     reasoning next to it, not a bare 1.1 in an expression.
 *   - Below a minimum number of months of data, no figure is offered at all. Extrapolating a monthly
 *     budget from four days of records produces a confident number that is mostly noise, and a
 *     confidently wrong number is worse than an honest "not enough data yet" — the user acts on it.
 */

const MINOR = 100;

/**
 * How much tighter than observed average spend the suggestion should be.
 *
 * 0.95 — a 5% trim. Chosen to be small on purpose: a budget that demands a 30% cut gets abandoned in
 * the first week, and a budget equal to current spending is not a budget. This is a product judgement
 * rather than a mathematical result, which is exactly why it is a named constant with this comment
 * attached instead of a literal buried in an expression. If a real product were being built, this is
 * the number you would want to be able to change from a config file after looking at retention.
 */
const TRIM_FACTOR = 0.95;

/**
 * Fewest distinct calendar months of expense data before a figure is offered.
 *
 * Two, not one. With a single month there is no way to tell a typical month from an unusual one — a
 * month containing an annual insurance payment would set a budget nobody can hit, and a quiet month
 * would set one that breaks immediately.
 */
const MIN_MONTHS = 2;

/** `YYYY-MM` from a `YYYY-MM-DD` string, by slicing rather than parsing. */
const monthKeyOf = (date) => (typeof date === 'string' && date.length >= 7 ? date.slice(0, 7) : null);

/** Round a major-unit figure to whole cents, exactly, via integers. */
const roundMoney = (value) => Math.round(value * MINOR) / MINOR;

/**
 * Suggest a monthly budget from a user's transactions.
 *
 * Takes an already-owner-scoped array, for the same reason `calculateSummary` does.
 *
 * Returns an object rather than a string: `{ suggestedMonthlyBudget, basis, ... }`, where
 * `suggestedMonthlyBudget` is a number or `null` when there is not enough data, and `basis` is a
 * short machine-readable reason for which branch was taken. Returning the *reason* alongside the
 * number is what lets a client say "based on 3 months of spending" instead of presenting a bare
 * figure the user has no way to sanity-check.
 */
exports.suggestBudget = (transactions) => {
  // Bucket expenses by calendar month, in integer cents.
  const monthlyMinor = new Map();

  for (const transaction of transactions) {
    if (transaction.type !== 'expense') continue;
    if (!Number.isFinite(transaction.amount)) continue;

    const month = monthKeyOf(transaction.date);
    // A record with an unusable date is skipped rather than lumped into an arbitrary month. It
    // cannot happen through the API — the validator enforces `YYYY-MM-DD` — but the file on disk may
    // predate that validation, and quietly attributing old bad data to the current month would
    // corrupt the very average this function exists to compute.
    if (month === null) continue;

    monthlyMinor.set(month, (monthlyMinor.get(month) ?? 0) + Math.round(transaction.amount * MINOR));
  }

  const monthsObserved = monthlyMinor.size;

  if (monthsObserved === 0) {
    return {
      suggestedMonthlyBudget: null,
      basis: 'NO_EXPENSES',
      monthsObserved: 0,
      averageMonthlyExpense: null,
      message: 'No expenses recorded yet, so there is nothing to base a budget on.',
    };
  }

  // Averaged over the months that have data, NOT over the calendar span between the first and last
  // transaction. The distinction is real: someone with records in January and December but nothing
  // in between has two months of data, and dividing by twelve would suggest a budget one sixth of
  // what they actually spend. Dividing by months-observed answers "what does a month I spend in look
  // like", which is the question that generalises.
  const totalMinor = [...monthlyMinor.values()].reduce((sum, minor) => sum + minor, 0);
  const averageMonthlyExpense = roundMoney(totalMinor / monthsObserved / MINOR);

  if (monthsObserved < MIN_MONTHS) {
    return {
      suggestedMonthlyBudget: null,
      basis: 'INSUFFICIENT_HISTORY',
      monthsObserved,
      averageMonthlyExpense,
      message:
        `Only ${monthsObserved} month of expenses recorded. At least ${MIN_MONTHS} are needed before a ` +
        'monthly budget means anything — a single month cannot show which costs are typical.',
    };
  }

  const suggestedMonthlyBudget = roundMoney(averageMonthlyExpense * TRIM_FACTOR);

  return {
    suggestedMonthlyBudget,
    basis: 'MONTHLY_AVERAGE',
    monthsObserved,
    averageMonthlyExpense,
    // The percentage is derived from the constant rather than written as a literal "5%", so the text
    // cannot drift out of agreement with the arithmetic when the constant is tuned. Prose that
    // contradicts the number beside it is a bug report waiting to happen.
    message:
      `Based on ${monthsObserved} months of spending averaging ${averageMonthlyExpense} per month, ` +
      `aim for ${suggestedMonthlyBudget} — about ${Math.round((1 - TRIM_FACTOR) * 100)}% below your current average.`,
  };
};
