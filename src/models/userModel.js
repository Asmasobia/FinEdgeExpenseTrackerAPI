/**
 * User persistence: a JSON file standing in for a `users` table.
 *
 * The path here pointed at `../data/users.json` while the file committed to the repository
 * was `../data/user.json` — singular. Nothing crashed, which is what made it worth finding:
 * `ensureFile` simply created a second, empty `users.json` on first use, and the committed
 * `user.json` was dead weight that no code would ever open. A reader inspecting the data
 * file to understand the shape of a user would have been looking at the wrong file.
 *
 * Fixed by renaming the data file to `users.json` (a `git mv`, so history follows it),
 * matching both the code and the plural `transactions.json` beside it.
 */

const fs = require('fs/promises');
const path = require('path');

const usersFilePath = path.join(__dirname, '../data/users.json');

/**
 * Create the data file if it is missing.
 *
 * `fs.access` — what this used to call — only answers "is there a readable entry at this
 * path?". An empty or truncated file passes and then fails in `JSON.parse` with
 * `Unexpected end of JSON input`, naming neither the file nor the cause. Reading once and
 * checking the content covers both cases in a single syscall. An empty file is safe to
 * repair because there is no data to lose; invalid content is left alone and allowed to
 * throw, because overwriting unparseable data with `[]` would destroy records a human
 * might still recover. Same reasoning as `transactionModel.js`.
 */
async function ensureFile() {
  try {
    const contents = await fs.readFile(usersFilePath, 'utf-8');
    if (contents.trim() === '') {
      await fs.writeFile(usersFilePath, '[]');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(path.dirname(usersFilePath), { recursive: true });
    await fs.writeFile(usersFilePath, '[]');
  }
}

async function readUsers() {
  await ensureFile();
  const data = await fs.readFile(usersFilePath, 'utf-8');
  try {
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected a JSON array, got ${parsed === null ? 'null' : typeof parsed}`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Could not read users from ${usersFilePath}: ${error.message}`);
  }
}

async function writeUsers(users) {
  await fs.mkdir(path.dirname(usersFilePath), { recursive: true });
  await fs.writeFile(usersFilePath, JSON.stringify(users, null, 2));
}

exports.getAll = async () => readUsers();

exports.findById = async (id) => (await readUsers()).find((u) => u.id === id);

// Email comparison is case-insensitive and trims surrounding whitespace, because mail
// hosts treat the domain as case-insensitive and in practice the local part too. Without
// this, `Asma@x.com` and `asma@x.com` register as two separate accounts, and whichever
// casing the user types at login decides whether their own password works.
exports.findByEmail = async (email) => {
  if (typeof email !== 'string') return undefined;
  const needle = email.trim().toLowerCase();
  return (await readUsers()).find((u) => typeof u.email === 'string' && u.email.trim().toLowerCase() === needle);
};

exports.create = async (user) => {
  const users = await readUsers();
  users.push(user);
  await writeUsers(users);
  return user;
};
