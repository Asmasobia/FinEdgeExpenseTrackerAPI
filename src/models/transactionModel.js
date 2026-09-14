/**
 * Transaction persistence: a JSON file standing in for a database table.
 *
 * The read-modify-write shape below (read the whole array, change it in memory, write the
 * whole array back) is the reason this file has a concurrency problem that a real database
 * would not: two overlapping requests both read the same array and the second write
 * silently discards the first one's change. That is addressed separately — see the
 * serialisation work — because it is a different class of bug from the ones fixed here.
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

exports.getAll = async () => readTransactions();

exports.findById = async (id) => (await readTransactions()).find((t) => t.id === id);

exports.create = async (transaction) => {
  const transactions = await readTransactions();
  transactions.push(transaction);
  await writeTransactions(transactions);
  return transaction;
};

exports.update = async (id, data) => {
  const transactions = await readTransactions();
  const index = transactions.findIndex((t) => t.id === id);
  if (index === -1) return null;
  // Spread order matters: existing fields first, then `data`, so the caller's values win.
  // `id` is re-asserted last so a request body containing `"id": "something-else"` cannot
  // renumber a record and detach it from whatever already references it.
  transactions[index] = { ...transactions[index], ...data, id };
  await writeTransactions(transactions);
  return transactions[index];
};

/**
 * Delete one transaction by id. Returns `true` if something was removed, `null` if no
 * record matched (the caller turns that into a 404).
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
exports.remove = async (id) => {
  const transactions = await readTransactions();
  const remaining = transactions.filter((t) => t.id !== id);
  // Compare lengths rather than searching first: one pass, and it cannot disagree with
  // itself the way a separate `find` followed by a `filter` could.
  if (remaining.length === transactions.length) return null;
  await writeTransactions(remaining);
  return true;
};
