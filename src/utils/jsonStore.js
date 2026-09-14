/**
 * A JSON-array-on-disk store: serialised writes, atomic replacement, lock-free reads.
 *
 * The bug this exists to fix
 * ================================================================================
 * Every write in this codebase was read-modify-write with an `await` in the middle:
 *
 *     const transactions = await readTransactions();     // (1) read
 *     transactions.push(transaction);                    // (2) modify in memory
 *     await writeTransactions(transactions);             // (3) write the whole array back
 *
 * Node runs one piece of JavaScript at a time, which is what makes this feel safe and is
 * exactly why it is not. Single-threaded does not mean uninterrupted: at every `await` the
 * function suspends and the event loop is free to run another request's handler. So two
 * concurrent POSTs interleave like this:
 *
 *     request A: read  -> [x]
 *     request B: read  -> [x]              <- B read BEFORE A wrote
 *     request A: write -> [x, a]
 *     request B: write -> [x, b]           <- A's record is gone
 *
 * Both requests returned 201. The client that created `a` was told it succeeded, has the id
 * in hand, and the record does not exist. Ten simultaneous creates can leave one row.
 *
 * This is the *lost update* problem, and it is the same shape as the mutex bugs in a
 * different project of mine: a check-then-act sequence spanning a suspension point, where
 * the state the decision was based on is stale by the time the decision is applied. The
 * detail that makes it easy to miss here is that there is no visible concurrency primitive
 * anywhere — no thread, no `Promise.all`, nothing to look suspicious. Two users clicking at
 * the same moment is all it takes.
 *
 * Why not just be careful?
 * --------------------------------------------------------------------------------
 * You cannot fix this by reordering or by making the window smaller. Any read-modify-write
 * against shared mutable state needs *mutual exclusion* — a guarantee that no other writer
 * runs between the read and the write. A real database gives you this (row locks, MVCC, or
 * an atomic `UPDATE ... WHERE`); a JSON file gives you nothing, so it has to be built.
 *
 * The two mechanisms below, and why they are both needed
 * ================================================================================
 *
 * 1. `withLock` — an in-process queue, one per file. Serialises writers so a read-modify-write
 *    runs to completion before the next one starts. This fixes the lost update.
 *
 * 2. `writeArrayAtomic` — write a temp file, then rename it over the target. This fixes two
 *    *other* problems the lock does not touch:
 *
 *      - A torn read. `fs.writeFile` truncates the file and then writes, so there is a real
 *        window in which the file on disk is empty or half-written. A concurrent reader lands
 *        in that window and gets `Unexpected end of JSON input` on data that is perfectly
 *        fine. `rename` is a single filesystem operation: a reader sees either the whole old
 *        file or the whole new one, never a partial one.
 *      - A crash mid-write. Truncate-then-write leaves a destroyed file if the process dies
 *        in between. Temp-then-rename leaves the previous version fully intact.
 *
 *    And it is (2) that lets reads skip the lock entirely: because no reader can ever observe
 *    a partial file, a read needs no coordination at all. Readers never block writers and
 *    writers never block readers. That is worth having — the alternative, locking reads too,
 *    would serialise every GET in the application behind every POST for no benefit.
 *
 * What this deliberately does NOT solve — stated plainly rather than left to be discovered
 * ================================================================================
 * - **Cross-process safety.** The lock is a Map in this process's memory. Two `npm start`s,
 *   a `cluster`/PM2 setup with several workers, or a maintenance script run while the server
 *   is up, and the lost update comes straight back — each process serialises against itself
 *   and knows nothing of the others. Fixing that needs an OS-level advisory lock (`flock`, or
 *   an `O_EXCL` lockfile with stale-lock recovery), and lockfiles bring their own failure
 *   mode: a crashed holder leaves one behind and everything wedges until someone deletes it.
 *   The honest answer at that point is a database, which is the real fix for all of this.
 * - **Durability against power loss.** `rename` orders the *visibility* of the new file, but
 *   without `fsync` on the temp file and its directory, the OS may not have flushed the bytes
 *   yet. A power cut can therefore lose the last write even though the rename appeared to
 *   succeed. Not implemented because an fsync per request is a large, permanent latency cost,
 *   and it would be a strange thing to pay for a store whose data lives in a text file. Named
 *   here so it is a known trade-off rather than an accident.
 */

const fs = require('fs/promises');
const path = require('path');

/**
 * One promise chain per file path. The value is always a promise that CANNOT reject — see the
 * note in `withLock`, because getting that wrong is the classic way this pattern breaks.
 */
const chains = new Map();

/**
 * Run `task` with exclusive access to `key`, queued behind anything already waiting.
 *
 * The whole mechanism is: keep a promise representing "everything queued so far", and make
 * each new task wait on it. Because a `.then()` callback cannot start until the promise it is
 * attached to settles, tasks run strictly one at a time, in arrival order.
 *
 * Two details here are the difference between working and subtly broken:
 *
 * 1. `previous.then(task, task)` passes `task` as BOTH handlers, so it runs whether the
 *    previous task fulfilled or rejected. With the more natural-looking `previous.then(task)`,
 *    a single failed write would reject the chain and every task queued after it would be
 *    skipped forever — one transient error and the endpoint silently stops writing, with no
 *    error to point at because the new requests never ran at all. A lock must always be
 *    released, and this is the promise-chain equivalent of `finally`.
 *
 * 2. The promise stored back into the Map is `run.then(noop, noop)`, which never rejects.
 *    Storing `run` itself would leave a rejected promise in the Map with no handler attached
 *    to *that* reference, and Node reports it as an unhandled rejection — a spurious crash
 *    warning about an error the caller is handling perfectly well one reference away.
 *
 * The caller gets `run`, so it still sees the real result or the real error.
 */
function withLock(key, task) {
  const previous = chains.get(key) ?? Promise.resolve();

  const run = previous.then(task, task);

  const settled = run.then(
    () => {},
    () => {}
  );
  chains.set(key, settled);

  // Drop the entry once this task is the last one in the queue, so a long-lived process does
  // not accumulate a Map entry per file forever. The identity check matters: if another task
  // queued up in the meantime, `chains.get(key)` is now ITS promise, and deleting the entry
  // would hand the next arrival a fresh `Promise.resolve()` — it would start immediately,
  // running concurrently with the task still in flight. That would quietly reintroduce the
  // exact bug this function exists to prevent, in the cleanup code.
  settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });

  return run;
}

/**
 * Read a JSON array from disk. No lock; see the header note on why that is safe.
 *
 * A missing or empty file reads as `[]` rather than being created here. The previous code had
 * an `ensureFile` step that WROTE `[]` on the read path, which is a poor shape for two
 * reasons: a read that mutates the disk is surprising, and it meant the read path needed the
 * write lock to be correct. Letting the first write create the file removes both problems and
 * a whole function with it — a fresh clone still works, because a GET on a nonexistent file
 * correctly reports "no records" instead of failing.
 *
 * Invalid content, by contrast, THROWS and is never repaired. Silently replacing unparseable
 * data with `[]` would destroy records a human might still recover by hand. Loud failure beats
 * quiet deletion.
 */
async function readArray(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  if (raw.trim() === '') return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // The path is attached for the operator's benefit; `expose: false` on the resulting 500
    // is what keeps it out of the HTTP response. See src/errors.js.
    throw new Error(`Could not parse JSON from ${filePath}: ${error.message}`);
  }

  // A JSON file can legitimately hold an object, a string or a number. Every caller assumes an
  // array and would fail confusingly on anything else (`.find is not a function`), so the shape
  // is checked where it is read rather than where it is used.
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array in ${filePath}, got ${parsed === null ? 'null' : typeof parsed}`);
  }

  return parsed;
}

/**
 * Replace the file's contents atomically: write a sibling temp file, then rename over the target.
 *
 * The temp file must be in the SAME DIRECTORY as the target. `rename` is only atomic within a
 * filesystem, so a temp file in the OS temp directory can land on a different volume and
 * degrade into copy-then-delete — losing exactly the property this function exists for.
 *
 * The name includes the pid and a counter so two processes (or two queued writes) can never
 * pick the same temp path and corrupt each other's in-progress file.
 */
let tempCounter = 0;

async function writeArrayAtomic(filePath, data) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });

  tempCounter += 1;
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${tempCounter}.tmp`);

  // 2-space indentation: this file is meant to be opened and read by a human during
  // development, which is most of the value of using JSON as a store in the first place.
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2));

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Windows is the reason this retry exists. POSIX `rename` over an existing path always
    // succeeds; on Windows the operation fails with EPERM/EACCES/EBUSY if anything else holds a
    // handle to the target — an antivirus scanner, a file-watcher, an editor with the JSON open.
    // These are transient by nature and clear in milliseconds, so a few short retries turn a
    // spurious 500 into a slight delay. Retrying forever would be wrong: a genuine permission
    // problem must surface, so this gives up quickly and rethrows.
    const transient = ['EPERM', 'EACCES', 'EBUSY'];
    if (!transient.includes(error.code)) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }

    let lastError = error;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      try {
        await fs.rename(tempPath, filePath);
        return;
      } catch (retryError) {
        lastError = retryError;
      }
    }
    // Clean up the orphan so a failed write does not leave litter next to the real data.
    await fs.rm(tempPath, { force: true });
    throw lastError;
  }
}

/**
 * The one safe way to change a file: read, modify and write inside a single critical section.
 *
 * `mutator` receives the current array and returns either:
 *   - `null`  — nothing to do; no write happens at all (so a 404 does not rewrite the file), or
 *   - `{ next, result }` — `next` is the array to persist, `result` is what the caller gets back.
 *
 * Requiring the mutator to hand back the array it wants written, rather than mutating the one it
 * was given and relying on that being noticed, is deliberate: it makes "did this operation
 * actually intend to write?" explicit at every call site, which is what allows the no-write case
 * to exist safely.
 *
 * Note that `readArray` is called here, INSIDE the lock, and that the public read helpers do not
 * take the lock. That asymmetry is load-bearing. If reads acquired the same lock, a mutator that
 * performed a read would deadlock — it would wait for a lock its own caller is already holding,
 * and this implementation has no reentrancy support. Keeping reads lock-free makes that
 * impossible by construction rather than by remembering not to do it.
 */
async function mutate(filePath, mutator) {
  return withLock(filePath, async () => {
    const current = await readArray(filePath);
    const outcome = await mutator(current);
    if (outcome === null || outcome === undefined) return null;
    await writeArrayAtomic(filePath, outcome.next);
    return outcome.result;
  });
}

module.exports = { withLock, readArray, writeArrayAtomic, mutate };
