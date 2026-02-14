const fs = require('fs/promises');
const path = require('path');

const usersFilePath = path.join(__dirname, '../data/users.json');

async function ensureFile() {
  try { await fs.access(usersFilePath); } catch {
    await fs.mkdir(path.dirname(usersFilePath), { recursive: true });
    await fs.writeFile(usersFilePath, '[]');
  }
}

async function readUsers() {
  await ensureFile();
  const data = await fs.readFile(usersFilePath, 'utf-8');
  return JSON.parse(data);
}

async function writeUsers(users) {
  await ensureFile();
  await fs.writeFile(usersFilePath, JSON.stringify(users, null, 2));
}

exports.getAll = async () => readUsers();
exports.findById = async (id) => (await readUsers()).find(u => u.id === id);
exports.findByEmail = async (email) => (await readUsers()).find(u => u.email === email);
exports.create = async (user) => {
  const users = await readUsers();
  users.push(user);
  await writeUsers(users);
  return user;
};