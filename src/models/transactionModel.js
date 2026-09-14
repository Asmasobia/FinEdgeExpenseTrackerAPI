/**
 * Transaction persistence: a JSON file standing in for a database table.
 *
 * Concurrency
 * --------------------------------------------------------------------------------
 * Every function that writes now goes through `jsonStore.mutate`, which reads, modifies and
 * writes inside a single critical section. Before this, each write was a bare
 * read → `await` → write, so two overlapping requests both read the same array and the second
 * write silently discarded the first one's change — both clients getting a success response.
 * The mechanism, and what it does and does not protect against, is documented in
 * src/utils/jsonStore.js; that file is worth reading before changing anything here.
 *
 * The reads stay lock-free, deliberately. Writes replace the file atomically (temp + rename),
 * so a reader can never observe a half-written file, which means a read needs no coordination
 * at all and no GET has to queue behind a POST.
 *
 * Row-level ownership
 * --------------------------------------------------------------------------------
 * Every function that reads or writes a specific record takes `ownerId` as its first argument,
 * and every one of them filters on it. Think of it as a `WHERE user_id = $1` that cannot be
 * left off.
 *
 * The choice worth explaining is *where* that filter lives. The alternative was to leave this
 * module as dumb storage — `findById(id)` returning any record — and have the service compare
 * `transaction.userId` to the caller before proceeding. That reads more simply and is how a lot
 * of code is written, but it has two problems:
 *
 *   1. It is opt-in. A new endpoint added six months from now calls `findById(id)`, gets a
 *      record back, forgets the comparison, and leaks. The failure mode of forgetting is
 *      "returns someone else's data" — silent, and invisible in tests written by the person who
 *      forgot. Here the failure mode of forgetting is a thrown error on the first call, because
 *      `ownerId` has no default and is validated (see `requireOwnerId`). Choosing the direction
 *      a mistake fails in is most of what defensive design is.
 *   2. Check-then-act across an `await`. Reading a record, comparing the owner, then writing is
 *      three steps with suspension points between them — and an ownership decision made against
 *      one version of the file, applied to another, is a security bug rather than merely a lost
 *      update. Filtering inside the mutator means the ownership test and the write it authorises
 *      now happen against one snapshot, inside the lock, with no window between them at all.
 *
 * Note what this deliberately does NOT do: there is no "admin can see everything" bypass and no
 * unscoped `getAll()` left lying around for convenience. An unscoped read that exists is an
 * unscoped read that eventually gets called from a request handler.
 */

const path = require('path');

const { mutate, readArray } = require('../utils/jsonStore');

const transactionsFilePath = path.join(__dirname, '../data/transactions.json');

/**
 * Reject a missing or malformed owner id before it can be used as a filter.
 *
 * This exists because of how JavaScript comparison behaves on absent values. If `ownerId`
 * arrived as `undefined` and were used directly, `t.userId === undefined` is `true` for every
 * record that has no `userId` field — so a caller who forgot to pass an owner would not get an
 * empty result, they would get exactly the set of unowned legacy records. And `remove` would
 * delete them. A filter built from an absent value does not filter; it selects a different,
 * arbitrary set.
 *
 * Throwing rather than returning empty is deliberate: an empty array looks like a valid answer
 * ("this user has no transactions") and would be reported to the client as a 200. A thrown error
 * is a 500 and a stack trace pointing at the call site that forgot. This is a programming error,
 * not a user error, and the two should not look alike.
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
  return (await readArray(transactionsFilePath)).filter((t) => isOwnedBy(t, ownerId));
};

/**
 * Look up one transaction, but only within the owner's own records.
 *
 * Returns `undefined` both when the id does not exist and when it exists but belongs to somebody
 * else. Collapsing those two cases is the point, and it is what lets the controller answer 404
 * for both.
 *
 * Answering 403 for "exists but not yours" would be more literally accurate and is the wrong
 * choice: the difference between 403 and 404 tells a caller whether a given id exists. Iterate
 * over ids and the status code alone maps out how many transactions other users have and which
 * ids are live — without ever returning a single field of their data. Leaking existence is a
 * smaller leak than leaking content, but it is still a leak, and it costs nothing to avoid.
 */
exports.findByIdForOwner = async (id, ownerId) => {
  requireOwnerId(ownerId);
  return (await readArray(transactionsFilePath)).find((t) => t.id === id && isOwnedBy(t, ownerId));
};

exports.create = async (transaction) => {
  // `create` takes the owner inside the record rather than as a separate argument, because the
  // service builds the whole object; validating it here still guarantees no transaction can be
  // stored without an owner, which is what would make it unreachable-but-present data —
  // invisible to every scoped read yet counted in nothing.
  requireOwnerId(transaction && transaction.userId);
  return mutate(transactionsFilePath, (transactions) => ({
    next: [...transactions, transaction],
    result: transaction,
  }));
};

exports.updateForOwner = async (id, ownerId, data) => {
  requireOwnerId(ownerId);
  return mutate(transactionsFilePath, (transactions) => {
    // The ownership test is part of the same predicate that locates the record, not a separate
    // check afterwards. `index === -1` therefore covers "no such id" and "not yours" identically,
    // and there is no branch in which a found-but-unowned record sits in a variable waiting to be
    // used by mistake.
    const index = transactions.findIndex((t) => t.id === id && isOwnedBy(t, ownerId));
    // Returning null means "no write at all". A 404 must not rewrite the file: doing so would
    // burn a disk write per missing-id request and, worse, would make a failed lookup capable of
    // clobbering a concurrent successful write.
    if (index === -1) return null;

    // Spread order matters: existing fields first, then `data`, so the caller's values win.
    // `id` and `userId` are re-asserted last, after `data`. `id` stops a request body from
    // renumbering a record; `userId` stops a body containing `"userId": "<someone else>"` from
    // *transferring the record to another account*, which would let a caller plant entries in a
    // stranger's ledger — or, more quietly, move their own record out of their own view to hide
    // it. The client never gets to name an owner, on any endpoint.
    const updated = { ...transactions[index], ...data, id, userId: ownerId };

    // A fresh array with one element replaced, rather than assigning into the array that was
    // read. `mutate` hands over the parsed array and takes back whatever should be persisted;
    // building a new one keeps the input untouched, so there is no state left behind if the
    // mutator throws partway through.
    const next = transactions.slice();
    next[index] = updated;
    return { next, result: updated };
  });
};

/**
 * Delete one of the owner's transactions by id. Returns `true` if something was removed, `null`
 * if no record matched — either because the id does not exist or because it belongs to another
 * user (the caller turns both into a 404).
 *
 * This function replaces one that was catastrophically wrong in two separate ways.
 *
 * It was exported as `readFile` — a name that describes reading, on a function that writes.
 * `transactionService` called `transactionModel.delete`, which did not exist, so every DELETE
 * request threw `TypeError: transactionModel.delete is not a function`.
 *
 * And the predicate was inverted:
 *
 *     const filtered = transactions.filter(t => t.id === id);   // KEEPS only the match
 *     await writeTransactions(filtered);                        // writes back just that one
 *
 * `filter` keeps the elements for which the predicate is true, so filtering on `===` keeps the
 * record meant to be deleted and discards every other record in the file. Deleting one
 * transaction would have erased the entire ledger.
 *
 * Worth being explicit about the order in which those two bugs had to be fixed: the missing
 * export is what made this unreachable, and that is the only reason no data was ever lost.
 * Correcting the export alone — the obvious "fix the typo" change — would have turned a loud 500
 * into silent, total data destruction. When two bugs mask each other, the safe-looking one is not
 * necessarily safe to fix first.
 */
exports.removeForOwner = async (id, ownerId) => {
  requireOwnerId(ownerId);
  return mutate(transactionsFilePath, (transactions) => {
    // Read this predicate carefully, because it is the one place in the file where getting the
    // boolean algebra wrong is destructive rather than merely wrong. "Keep everything that is not
    // (the target id AND mine)" — so a record with the same id belonging to someone else fails the
    // inner condition, is therefore kept, and is untouched by another user's DELETE.
    //
    // The tempting shorter form `t.id !== id` would delete by id alone and ignore ownership
    // entirely, which is exactly the vulnerability the auth work exists to close: any
    // authenticated user could delete any record whose id they could guess or observe.
    const next = transactions.filter((t) => !(t.id === id && isOwnedBy(t, ownerId)));
    // Compare lengths rather than searching first: one pass, and it cannot disagree with itself
    // the way a separate `find` followed by a `filter` could.
    if (next.length === transactions.length) return null;
    return { next, result: true };
  });
};
