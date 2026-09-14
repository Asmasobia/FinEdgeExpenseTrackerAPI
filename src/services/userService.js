const crypto = require('crypto');

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const config = require('../config');
const UserModel = require('../models/userModel');

/**
 * bcrypt cost factor. Each increment doubles the work, so this is the dial that decides how
 * expensive an offline guess is if the user file is ever stolen. 10 was the original value
 * and is kept: it is the library default and lands around 50-100 ms on current hardware,
 * which is slow enough to make large-scale guessing costly and fast enough that a login
 * request does not feel sluggish. Raising it is a deliberate trade of login latency for
 * resistance to cracking, not a free win.
 */
const BCRYPT_COST = 10;

exports.registerUser = async ({ username, email, password }) => {
  if (!username || !email || !password) throw new Error('All fields are required');

  // Store the email in the same normalised form that `findByEmail` compares against.
  // Without this the check below and the lookup at login could disagree: registering
  // `Asma@x.com` then logging in as `asma@x.com` would find the account (the lookup lowers
  // both sides) but a second registration of the lowercase form would also be allowed if
  // the stored value were left as typed — two accounts, one address.
  const normalisedEmail = email.trim().toLowerCase();

  const existing = await UserModel.findByEmail(normalisedEmail);
  if (existing) throw new Error('Email exists');

  const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);
  const newUser = {
    id: crypto.randomUUID(),
    username,
    email: normalisedEmail,
    password: hashedPassword,
    createdAt: new Date().toISOString(),
  };
  await UserModel.create(newUser);

  // Deliberately returns only the id — never the user object. Spreading `newUser` into a
  // response would hand the bcrypt hash to the client, which is a slow offline cracking
  // target rather than an immediate compromise, but there is no reason to publish it.
  return { userId: newUser.id };
};

exports.loginUser = async ({ email, password }) => {
  if (!email || !password) throw new Error('Email and Password are required');

  const user = await UserModel.findByEmail(email);

  // One combined check with one message, on purpose. Answering "no such user" separately
  // from "wrong password" turns the login endpoint into an account-existence oracle: an
  // attacker can enumerate which addresses are registered without ever guessing a
  // password. Note this only closes the *message* channel — the timing channel remains,
  // since a missing user skips the ~80 ms bcrypt comparison entirely. Closing that
  // properly means comparing against a dummy hash so both paths cost the same, which is
  // noted as a known limitation rather than silently left unmentioned.
  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new Error('Invalid credentials');
  }

  // Reads from the validated config rather than `process.env.JWT_SECRET` directly, so a
  // missing secret is a refusal to boot rather than a 500 on this line. See src/config.js.
  const token = jwt.sign({ userId: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
  return { token, userId: user.id };
};
