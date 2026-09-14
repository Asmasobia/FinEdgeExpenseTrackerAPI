/**
 * User persistence: a JSON file standing in for a `users` table.
 *
 * The path here pointed at `../data/users.json` while the file committed to the repository was
 * `../data/user.json` — singular. Nothing crashed, which is what made it worth finding: the
 * old `ensureFile` simply created a second, empty `users.json` on first use, and the committed
 * `user.json` was dead weight that no code would ever open. A reader inspecting the data file to
 * understand the shape of a user would have been looking at the wrong file.
 *
 * Fixed by renaming the data file to `users.json` (a `git mv`, so history follows it), matching
 * both the code and the plural `transactions.json` beside it.
 *
 * Concurrency: writes go through `jsonStore.mutate`, which serialises read-modify-write and
 * replaces the file atomically. See src/utils/jsonStore.js — and `create` below for why this file
 * in particular needed it.
 */

const path = require('path');

const { mutate, readArray } = require('../utils/jsonStore');

const usersFilePath = path.join(__dirname, '../data/users.json');

/** Normalised form used on both write and read, so one address cannot become two accounts. */
const normaliseEmail = (email) => email.trim().toLowerCase();

exports.getAll = async () => readArray(usersFilePath);

exports.findById = async (id) => (await readArray(usersFilePath)).find((u) => u.id === id);

// Email comparison is case-insensitive and trims surrounding whitespace, because mail hosts treat
// the domain as case-insensitive and in practice the local part too. Without this, `Asma@x.com`
// and `asma@x.com` register as two separate accounts, and whichever casing the user types at login
// decides whether their own password works.
exports.findByEmail = async (email) => {
  if (typeof email !== 'string') return undefined;
  const needle = normaliseEmail(email);
  return (await readArray(usersFilePath)).find((u) => typeof u.email === 'string' && normaliseEmail(u.email) === needle);
};

/**
 * Insert a user, rejecting a duplicate email inside the critical section.
 *
 * The duplicate check deserves more than a passing mention, because this is the one place in the
 * application where a lost update is a *security* problem rather than a data-loss problem.
 *
 * `userService.registerUser` checks `findByEmail` and then calls this function. Those are two
 * separate awaits, so two simultaneous registrations of the same address both see "no such user"
 * and both proceed — the classic time-of-check-to-time-of-use race. Serialising the write alone
 * would not help: it would faithfully queue two inserts of the same email and end up with two
 * accounts for one address. From there, "log in as that email" resolves to whichever record
 * `find` reaches first, so one person's password now silently governs the other's account.
 *
 * So the check has to happen *inside the same critical section as the insert*, against the array
 * that is about to be written. That is what makes uniqueness an invariant of the store rather
 * than a hope held by the caller — the same reason a real database enforces this with a UNIQUE
 * constraint instead of a SELECT in application code.
 *
 * Returns the created user, or `null` if the email was already taken. The service turns `null`
 * into the 409; its own earlier `findByEmail` check is kept because it produces that 409 without
 * paying for a bcrypt hash first, but this is the check that is actually authoritative.
 */
exports.create = async (user) => {
  const needle = typeof user.email === 'string' ? normaliseEmail(user.email) : null;

  return mutate(usersFilePath, (users) => {
    if (needle !== null) {
      const clash = users.some((u) => typeof u.email === 'string' && normaliseEmail(u.email) === needle);
      // No write, so a rejected duplicate cannot clobber a concurrent successful registration.
      if (clash) return null;
    }
    return { next: [...users, user], result: user };
  });
};
