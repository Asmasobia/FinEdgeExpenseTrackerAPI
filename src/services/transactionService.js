const crypto = require('crypto');

const transactionModel = require('../models/transactionModel');
const analytics = require('../utils/analytics');
const insights = require('../utils/insights');

/**
 * Create a transaction.
 *
 * The id generation here was a hard crash:
 *
 *     const transaction = { id: Date.toISOString(), ...data };
 *
 * `toISOString` is an instance method on a Date *object*, not a static method on the `Date`
 * constructor, so `Date.toISOString` is `undefined` and calling it threw
 * `TypeError: Date.toISOString is not a function` on every single POST. The endpoint had
 * never worked.
 *
 * `new Date().toISOString()` would have run, but it is the wrong choice for an identifier.
 * A millisecond timestamp is not unique: two transactions created in the same millisecond
 * — which is entirely ordinary under any concurrency — would collide, and because the file
 * is keyed by id, one would then shadow the other on lookup, update and delete. An id
 * needs to be unique; a timestamp is a measurement of when something happened, and those
 * are different jobs. `crypto.randomUUID()` is 122 random bits, built into Node, needing
 * no dependency.
 *
 * `createdAt` carries the timestamp instead, which is what the original code was reaching
 * for. Field order puts the generated fields first so `...data` cannot overwrite them,
 * then re-asserts `id` last: without that, a request body containing its own `"id"` would
 * choose its own primary key, letting a caller overwrite an existing record through the
 * create endpoint.
 *
 * `userId` is stamped here, from the verified token, and is re-asserted after `...data` for
 * the same reason `id` is — a request body carrying `"userId": "<somebody else>"` must not
 * be able to file an expense in a stranger's ledger. The rule across this whole codebase is
 * that identity comes from the token and only from the token; the body is user input, and
 * user input never names its own owner.
 *
 * Before this, transactions had no `userId` field at all. There was no ownership model to
 * enforce even if a token had been checked — one shared global ledger where every user saw
 * and edited everyone's spending. That is why this slice touches four files rather than
 * just adding a middleware: authentication without ownership answers "who are you?" and
 * then ignores the answer.
 */
exports.addTransaction = async (ownerId, data) => {
  const transaction = {
    ...data,
    id: crypto.randomUUID(),
    userId: ownerId,
    createdAt: new Date().toISOString(),
  };
  await transactionModel.create(transaction);
  return transaction;
};

/**
 * Every function below takes `ownerId` first and passes it down. The repetition is the
 * feature: there is no code path from a route to the data file that does not carry an owner,
 * so scoping cannot be forgotten in one handler while the other four are correct.
 */
exports.getAllTransactions = async (ownerId) => transactionModel.getAllForOwner(ownerId);

exports.getTransactionById = async (ownerId, id) => transactionModel.findByIdForOwner(id, ownerId);

exports.updateTransaction = async (ownerId, id, data) => transactionModel.updateForOwner(id, ownerId, data);

// Renamed from the model's side: this used to call `transactionModel.delete`, which did not
// exist. The model now exports `removeForOwner` — `delete` is a reserved word, and while
// `exports.delete` is legal as a property name, a bare `delete(...)` reads like the
// operator and invites exactly this kind of mismatch. The `ForOwner` suffix on the model's
// functions is doing similar work: a reader skimming a call site sees that a scope is being
// applied, instead of having to open the model to find out whether it is.
exports.deleteTransaction = async (ownerId, id) => transactionModel.removeForOwner(id, ownerId);

/**
 * Income/expense totals across the caller's own transactions.
 *
 * This called `analytics.generateSummary`, which does not exist — the module exports
 * `calculateSummary`. A third broken call site of the same kind, and it went unnoticed
 * because no route was wired to this function: the README advertises `GET /summary`, but no
 * such route was ever registered. The name is corrected and the route now exists.
 *
 * An aggregate is worth a second look when adding ownership, because it is the easiest place
 * to leak by accident. A list endpoint that forgets to scope is obvious the moment you look
 * at the response — you can see somebody else's rent in it. A *total* that forgets to scope
 * returns a single plausible-looking number that happens to include every user's spending,
 * and nothing about the response says so. Reading through the aggregate's own owner-scoped
 * query, rather than an unscoped `getAll`, is what keeps that from happening.
 */
exports.getSummary = async (ownerId) => {
  const transactions = await transactionModel.getAllForOwner(ownerId);
  return analytics.calculateSummary(transactions);
};

/**
 * A suggested monthly budget for the caller, derived from their own spending.
 *
 * The utility behind this (`src/utils/insights.js`, formerly `aiHelper.js`) existed but was imported
 * by nothing — dead code that the README advertised as a feature. This is the wiring that makes the
 * claim true. Same owner-scoped read as the summary, for the same reason: a budget suggestion
 * computed over everybody's spending would be a single plausible number that is quietly wrong.
 */
exports.getInsights = async (ownerId) => {
  const transactions = await transactionModel.getAllForOwner(ownerId);
  return insights.suggestBudget(transactions);
};
