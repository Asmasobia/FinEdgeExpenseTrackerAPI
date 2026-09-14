const crypto = require('crypto');

const transactionModel = require('../models/transactionModel');
const analytics = require('../utils/analytics');

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
 */
exports.addTransaction = async (data) => {
  const transaction = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await transactionModel.create(transaction);
  return transaction;
};

exports.getAllTransactions = async () => transactionModel.getAll();

exports.getTransactionById = async (id) => transactionModel.findById(id);

exports.updateTransaction = async (id, data) => transactionModel.update(id, data);

// Renamed from the model's side: this used to call `transactionModel.delete`, which did not
// exist. The model now exports `remove` — `delete` is a reserved word, and while
// `exports.delete` is legal as a property name, a bare `delete(...)` reads like the
// operator and invites exactly this kind of mismatch.
exports.deleteTransaction = async (id) => transactionModel.remove(id);

/**
 * Income/expense totals across all transactions.
 *
 * This called `analytics.generateSummary`, which does not exist — the module exports
 * `calculateSummary`. A third broken call site of the same kind, and it went unnoticed
 * because no route is wired to this function: the README advertises `GET /summary`, but
 * no such route was ever registered. The endpoint is added in the routing work; the name
 * is corrected here so the function is at least callable.
 */
exports.getSummary = async () => {
  const transactions = await transactionModel.getAll();
  return analytics.calculateSummary(transactions);
};
