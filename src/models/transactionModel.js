/**
 * Transaction persistence: a JSON file standing in for a database table.
 *
 * The read-modify-write shape below (read the whole array, change it in memory, write the
 * whole array back) is the reason this file has a concurrency problem that a real database
 * would not: two overlapping requests both read the same array and the second write
 * silently discards the first one's change. That is addressed separately — see the
 * serialisation work — because it is a different class of bug from the ones fixed here.
 *
 * Row-level ownership
 * --------------------------------------------------------------------------------
 * Every function that reads or writes a specific record now takes `ownerId` as its first
 * argument, and every one of them filters on it. Think of it as a `WHERE user_id = $1`
 * that cannot be left off.
 *
 * The choice worth explaining is *where* that filter lives. The alternative was to leave
 * this module as dumb storage — `findById(id)` returning any record — and have the service
 * compare `transaction.userId` to the caller before proceeding. That reads more simply and
 * is how a lot of code is written, but it has two problems:
 *
 *   1. It is opt-in. A new endpoint added six months from now calls `findById(id)`, gets a
 *      record back, forgets the comparison, and leaks. The failure mode of forgetting is
 *      "returns someone else's data" — silent, and invisible in tests written by the person
 *      who forgot. Here the failure mode of forgetting is a thrown error on the first call,
 *      because `ownerId` has no default and is validated (see `requireOwnerId`). Choosing
 *      the direction a mistake fails in is most of what defensive design is.
 *   2. Check-then-act across an `await`. Reading a record, comparing the owner, then
 *      writing is three steps with two suspension points between them. Filtering inside the
 *      same read-modify-write closes the gap between the ownership test and the write —
 *      it does not close it completely (that is the serialisation work), but the ownership
 *      decision and the mutation it authorises now happen against one single snapshot of
 *      the file, so they cannot be based on different versions of the truth.
 *
 * Note what this deliberately does NOT do: there is no "admin can see everything" bypass
 * and no unscoped `getAll()` left lying around for convenience. An unscoped read that
 * exists is an unscoped read that eventually gets called from a request handler.
 */

const fs = require('fs/promises');
const path = require('path');

const transactionsFilePath = path.join(__dirname, '../data/transactions.json');

/**
 * Create the data file if it is missing, so a fresh clone works without setup.
 *
 * Two faults were fixed here. The write referenced `transactionFilePath` — no `s` — an
 * undefined variable that would have thrown `ReferenceError` the moment the file was
 * genuinely absent. It survived only because the file happens to be committed; the one
 * code path that exists to handle a missing file was itself broken.
 *
 * Second, `fs.access` answers "does a readable entry exist at this path?" and nothing
 * more. An empty or truncated file passes that check and then fails in `JSON.parse` with
 * `Unexpected end of JSON input` — a message that names neither the file nor the cause.
 * Repairing an empty file is safe (there is no data to lose); a file with *invalid* content
 * is deliberately NOT overwritten, because silently replacing unparseable data with `[]`
 * would destroy whatever a human might still recover. Loud failure beats silent deletion.
 */
async function ensureFile() {
  try {
    const contents = await fs.readFile(transactionsFilePath, 'utf-8');
    if (contents.trim() === '') {
      await fs.writeFile(transactionsFilePath, '[]');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(path.dirname(transactionsFilePath), { recursive: true });
    await fs.writeFile(transactionsFilePath, '[]');
  }
}

async function readTransactions() {
  await ensureFile();
  const data = await fs.readFile(transactionsFilePath, 'utf-8');
  try {
    const parsed = JSON.parse(data);
    // A JSON file can legitimately parse to an object, a string or a number. Every caller
    // below assumes an array and would fail confusingly on anything else (`.find` is not a
    // function), so the shape is checked where it is read rather than where it is used.
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected a JSON array, got ${parsed === null ? 'null' : typeof parsed}`);
    }
    return parsed;
  } catch (error) {
    // Re-thrown with the path attached. The native message ("Unexpected end of JSON input")
    // tells an operator nothing about *which* file to go and look at.
    throw new Error(`Could not read transactions from ${transactionsFilePath}: ${error.message}`);
  }
}

async function writeTransactions(transactions) {
  await fs.mkdir(path.dirname(transactionsFilePath), { recursive: true });
  // 2-space indentation: this file is meant to be opened and read by a human during
  // development, which is most of the value of using JSON as a store in the first place.
  await fs.writeFile(transactionsFilePath, JSON.stringify(transactions, null, 2));
}

/**
 * Reject a missing or malformed owner id before it can be used as a filter.
 *
 * This exists because of how JavaScript comparison behaves on absent values. If `ownerId`
 * arrived as `undefined` and were used directly, `t.userId === undefined` is `true` for
 * every record that has no `userId` field — so a caller who forgot to pass an owner would
 * not get an empty result, they would get exactly the set of unowned legacy records. And
 * `remove` would delete them. A filter built from an absent value does not filter; it
 * selects a different, arbitrary set.
 *
 * Throwing rather than returning empty is deliberate: an empty array looks like a valid
 * answer ("this user has no transactions") and would be reported to the client as a 200.
 * A thrown error is a 500 and a stack trace pointing at the call site that forgot. This is
 * a programming error, not a user error, and the two should not look alike.
 */
function requireOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.trim() === '') {
    throw new Error(
      'transactionModel: ownerId is required and must be a non-empty string. ' +
        'Every query must be scoped to a user — see the row-level ownership note at the top of this file.'
    );
  }
  return ownerId;
}

/** Does this record belong to this owner? One place, so the rule cannot drift between callers. */
function isOwnedBy(transaction, ownerId) {
  return transaction.userId === ownerId;
}

exports.getAllForOwner = async (ownerId) => {
  requireOwnerId(ownerId);
  return (await readTransactions()).filter((t) => isOwnedBy(t, ownerId));
};

/**
 * Look up one transaction, but only within the owner's own records.
 *
 * Returns `undefined` both when the id does not exist and when it exists but belongs to
 * somebody else. Collapsing those two cases is the point, and it is what lets the
 * controller answer 404 for both.
 *
 * Answering 403 for "exists but not yours" would be more literally accurate and is the
 * wrong choice: the difference between 403 and 404 tells an unauthenticated-for-this-record
 * caller whether a given id exists. Iterate over ids, and the status code alone maps out
 * how many transactions other users have and which ids are live — without ever returning a
 * single field of their data. Leaking existence is a smaller leak than leaking content, but
 * it is still a leak, and it costs nothing to avoid.
 */
exports.findByIdForOwner = async (id, ownerId) => {
  requireOwnerId(ownerId);
  return (await readTransactions()).find((t) => t.id === id && isOwnedBy(t, ownerId));
};

exports.create = async (transaction) => {
  // `create` takes the owner inside the record rather than as a separate argument, because
  // the service builds the whole object; validating it here still guarantees no transaction
  // can be stored without an owner, which is what would make it unreachable-but-present
  // data — invisible to every scoped read yet counted in nothing.
  requireOwnerId(transaction && transaction.userId);
  const transactions = await readTransactions();
  transactions.push(transaction);
  await writeTransactions(transactions);
  return transaction;
};

exports.updateForOwner = async (id, ownerId, data) => {
  requireOwnerId(ownerId);
  const transactions = await readTransactions();
  // The ownership test is part of the same predicate that locates the record, not a
  // separate check afterwards. `index === -1` therefore covers "no such id" and "not
  // yours" identically, and there is no branch in which a found-but-unowned record is
  // sitting in a variable waiting to be used by mistake.
  const index = transactions.findIndex((t) => t.id === id && isOwnedBy(t, ownerId));
  if (index === -1) return null;
  // Spread order matters: existing fields first, then `data`, so the caller's values win.
  // `id` and `userId` are re-asserted last, after `data`. `id` stops a request body from
  // renumbering a record; `userId` stops a body containing `"userId": "<someone else>"`
  // from *transferring the record to another account*, which would let a caller plant
  // entries in a stranger's ledger — or, more quietly, move their own record out of their
  // own view to hide it. The client never gets to name an owner, on any endpoint.
  transactions[index] = { ...transactions[index], ...data, id, userId: ownerId };
  await writeTransactions(transactions);
  return transactions[index];
};

/**
 * Delete one of the owner's transactions by id. Returns `true` if something was removed,
 * `null` if no record matched — either because the id does not exist or because it belongs
 * to another user (the caller turns both into a 404).
 *
 * This function replaces one that was catastrophically wrong in two separate ways.
 *
 * It was exported as `readFile` — a name that describes reading, on a function that
 * writes. `transactionService` called `transactionModel.delete`, which did not exist, so
 * every DELETE request threw `TypeError: transactionModel.delete is not a function`.
 *
 * And the predicate was inverted:
 *
 *     const filtered = transactions.filter(t => t.id === id);   // KEEPS only the match
 *     await writeTransactions(filtered);                        // writes back just that one
 *
 * `filter` keeps the elements for which the predicate is true, so filtering on `===` keeps
 * the record meant to be deleted and discards every other record in the file. Deleting one
 * transaction would have erased the entire ledger.
 *
 * Worth being explicit about the order in which those two bugs had to be fixed: the
 * missing export is what made this unreachable, and that is the only reason no data was
 * ever lost. Correcting the export alone — the obvious "fix the typo" change — would have
 * turned a loud 500 into silent, total data destruction. When two bugs mask each other,
 * the safe-looking one is not necessarily safe to fix first.
 */
exports.removeForOwner = async (id, ownerId) => {
  requireOwnerId(ownerId);
  const transactions = await readTransactions();
  // Read this predicate carefully, because it is the one place in the file where getting the
  // boolean algebra wrong is destructive rather than merely wrong. "Keep everything that is
  // not (the target id AND mine)" — so a record with the same id belonging to someone else
  // fails the inner condition, is therefore kept, and is untouched by another user's DELETE.
  //
  // The tempting shorter form `t.id !== id` would delete by id alone and ignore ownership
  // entirely, which is exactly the vulnerability this slice exists to close: any
  // authenticated user could delete any record whose id they could guess or observe.
  const remaining = transactions.filter((t) => !(t.id === id && isOwnedBy(t, ownerId)));
  // Compare lengths rather than searching first: one pass, and it cannot disagree with
  // itself the way a separate `find` followed by a `filter` could.
  if (remaining.length === transactions.length) return null;
  await writeTransactions(remaining);
  return true;
};
