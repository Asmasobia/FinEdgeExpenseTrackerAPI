/**
 * Request validation.
 *
 * The whole original file, for reference:
 *
 *     exports.validateTransaction = (req, res, next) => {
 *       const { type, category, amount, date } = req.body;
 *       if (!type || !['income','expense'].includes(type) || !category || !amount || !date) {
 *         return res.status(400).json({ message: 'Invalid transaction data' });
 *       }
 *       next();
 *     };
 *
 * It has five distinct problems, worth separating because they are different kinds of mistake:
 *
 *  1. `!amount` is a TRUTHINESS test on a value that is legitimately falsy. `0` is a
 *     perfectly good amount and was rejected. This is the classic falsy-value bug: `!x` means
 *     "x is absent" only for types where no valid value is falsy, and numbers and strings are
 *     not such types.
 *
 *  2. Nothing checked that `amount` was a NUMBER, let alone a sensible one. `"1200"`, `"abc"`,
 *     `NaN`, `Infinity`, `-500` and `{}` all passed. `-500` is the dangerous one:
 *     `analytics.calculateSummary` does `totalExpense += t.amount`, so an "expense" of `-500`
 *     *reduces* total expenses and inflates the balance. A validation gap became an arithmetic
 *     integrity bug in a different file.
 *
 *  3. `date` was required but never validated, so `date: "yesterday"` was stored and every
 *     later attempt to sort or group by date silently misbehaves.
 *
 *  4. The SAME function was used for POST and PATCH. A patch is by definition partial, so
 *     requiring all four fields meant `PATCH { amount: 50 }` was a 400 — the endpoint could
 *     not do the one thing its verb exists for.
 *
 *  5. Whatever survived was handed to the model as `req.body` and spread into the stored
 *     record, so a client could add arbitrary keys to a row (mass assignment). Bounded here by
 *     whitelisting: the validators build `req.validated` from known fields only, and the
 *     controllers persist that instead of the raw body.
 */

const { ValidationError } = require('../errors');

const TRANSACTION_TYPES = ['income', 'expense'];
const MAX_CATEGORY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 8;
// bcrypt truncates its input at 72 BYTES. Anything past that is silently ignored, so a
// 200-character passphrase is no stronger than its first 72 bytes — and two passwords sharing
// a long enough prefix would both authenticate. Rejecting explicitly is honest; silently
// ignoring half of what someone typed is not.
const MAX_PASSWORD_BYTES = 72;

/** Strict `YYYY-MM-DD`. See `validateDate` for why the shape is checked before parsing. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Deliberately loose email check: something, an @, something, a dot, something.
 *
 * Resisting the urge to write a "correct" one is the point. Validating an address fully per
 * RFC 5322 takes a famously enormous regex, and even a correct one cannot tell you the address
 * exists or accepts mail — which is the only property anyone actually cares about. A strict
 * regex therefore buys no real assurance while reliably rejecting valid unusual addresses
 * (plus-tags, new TLDs, quoted local parts) and locking those users out. The honest design is a
 * cheap shape check plus a confirmation email as the real verification; this project has no
 * mail sender, so the shape check is the honest limit of what it can claim.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Express 5 leaves `req.body` undefined when there is no body at all, so every read needs this. */
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

/* ── Field-level rules ───────────────────────────────────────────────────────────────────
 * Each returns an error string or null, and each is used by both the create and the patch
 * path. One definition per rule is what keeps POST and PATCH from drifting apart — the
 * original file's problem was the opposite extreme: one *function* shared where the
 * requiredness differs but the rules do not.
 */

function validateType(value) {
  if (typeof value !== 'string') return 'must be a string';
  if (!TRANSACTION_TYPES.includes(value)) return `must be one of: ${TRANSACTION_TYPES.join(', ')}`;
  return null;
}

function validateCategory(value) {
  if (typeof value !== 'string') return 'must be a string';
  if (value.trim() === '') return 'must not be empty';
  if (value.length > MAX_CATEGORY_LENGTH) return `must be at most ${MAX_CATEGORY_LENGTH} characters`;
  return null;
}

function validateAmount(value) {
  // `typeof NaN === 'number'` and `typeof Infinity === 'number'`, so a bare typeof check is not
  // enough. `Number.isFinite` rejects both and — unlike the global `isFinite` — does not
  // coerce, so the string `"1200"` is rejected rather than quietly accepted. Rejecting numeric
  // strings is deliberate: accept them and the stored type depends on how the client happened
  // to serialise, and `"10" + 5` is `"105"` in any arithmetic that follows.
  if (!Number.isFinite(value)) return 'must be a finite number';

  // Zero is ALLOWED; negatives are not. The direction of a transaction is carried by `type`,
  // so `amount` is a magnitude and a negative one is self-contradictory — an "expense" of -500
  // is income wearing the wrong label, and it corrupts the summary instead of failing loudly.
  // Zero, by contrast, is a coherent if unexciting record, and rejecting it was bug (1) above.
  // "Non-negative" and "truthy" are not the same test, and only one of them is correct here.
  if (value < 0) return 'must not be negative (use type: expense instead of a negative amount)';

  // Money in a float is a compromise this project accepts and should name: 0.1 + 0.2 is not
  // 0.3 in IEEE 754, so a long column of these drifts. The robust fix is to store minor units
  // as integers (cents/paise) and format at the edges. Short of that, capping at two decimal
  // places keeps values on the grid real currency uses and rejects the sub-unit noise that
  // makes drift compound.
  if (Math.round(value * 100) !== value * 100) return 'must have at most 2 decimal places';
  return null;
}

function validateDate(value) {
  if (typeof value !== 'string') return 'must be a string';

  // Shape first, and strictly, because JavaScript's date parsing is only predictable for the
  // ISO form. `new Date('2026-2-3')` and `new Date('01/09/2026')` are parsed as LOCAL time
  // (ISO date-only strings are parsed as UTC), so they shift by the host's UTC offset and can
  // land on the previous day — a ledger entry silently filed under the wrong date, on some
  // machines and not others.
  if (!ISO_DATE.test(value)) return 'must be a date in YYYY-MM-DD format';

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'must be a real calendar date';

  // The round-trip is not redundant with the checks above, and this is the subtle one:
  // `new Date('2026-02-30')` does NOT produce an Invalid Date. It ROLLS OVER to 2026-03-02.
  // So "it parsed" proves nothing about the date existing. Re-serialising and comparing is what
  // catches it — if the input survives a round trip unchanged, no rollover happened.
  if (parsed.toISOString().slice(0, 10) !== value) return 'must be a real calendar date';

  return null;
}

/** The whitelist. A field absent from this map cannot reach storage, whatever the client sends. */
const TRANSACTION_FIELDS = {
  type: validateType,
  category: validateCategory,
  amount: validateAmount,
  date: validateDate,
};

/**
 * Collect every failure instead of returning on the first.
 *
 * Fail-fast validation makes a client fix one field, resubmit, and discover the next — four
 * round trips to learn about four bad fields. Reporting all of them at once costs nothing and
 * is much of the difference between an API that is pleasant to integrate against and one that
 * is not.
 */
function collectErrors(source, fields, { requireAll }) {
  const details = {};
  const validated = {};

  for (const [field, validate] of Object.entries(fields)) {
    // `hasOwnProperty` rather than `!== undefined`, so an explicit `"amount": null` counts as
    // provided-but-invalid (400, naming the field) rather than as absent. A client that sent a
    // field wants to know it was rejected; ignoring it silently looks like success.
    const provided = Object.prototype.hasOwnProperty.call(source, field);

    if (!provided) {
      if (requireAll) details[field] = 'is required';
      continue;
    }

    const problem = validate(source[field]);
    if (problem) details[field] = problem;
    else validated[field] = source[field];
  }

  return { details, validated };
}

/**
 * POST /transactions — all four fields required.
 */
exports.validateCreateTransaction = (req, res, next) => {
  const { details, validated } = collectErrors(bodyOf(req), TRANSACTION_FIELDS, { requireAll: true });

  if (Object.keys(details).length > 0) {
    return next(new ValidationError('Invalid transaction data', details));
  }

  // Normalising here rather than in the model, so storage receives data already in canonical
  // form and every reader sees one shape. Trimming the category means " Rent " and "Rent" do
  // not become two categories in a group-by.
  validated.category = validated.category.trim();
  req.validated = validated;
  next();
};

/**
 * PATCH /transactions/:id — validate what was sent, require nothing, but require *something*.
 *
 * The empty-patch check matters: without it, `PATCH {}` passes validation, reaches the model,
 * spreads nothing, writes the file back unchanged and answers 200. A success response for an
 * operation that did nothing is worse than an error, because a client with a typo'd field name
 * (`ammount`) sees 200 and believes the update landed. Rejecting the empty case turns a silent
 * no-op into a visible mistake.
 */
exports.validatePatchTransaction = (req, res, next) => {
  const { details, validated } = collectErrors(bodyOf(req), TRANSACTION_FIELDS, { requireAll: false });

  if (Object.keys(details).length > 0) {
    return next(new ValidationError('Invalid transaction data', details));
  }

  if (Object.keys(validated).length === 0) {
    return next(
      new ValidationError(`A patch must change at least one of: ${Object.keys(TRANSACTION_FIELDS).join(', ')}`, {
        body: 'no updatable fields were provided',
      })
    );
  }

  if (validated.category !== undefined) validated.category = validated.category.trim();
  req.validated = validated;
  next();
};

/**
 * POST /users — registration input.
 *
 * New: registration had no validation at all. `userService.registerUser` checked only that
 * three fields were truthy, so a one-character password was accepted, and because the check
 * lived in the service it surfaced as a 500 rather than a 400.
 */
exports.validateRegister = (req, res, next) => {
  const body = bodyOf(req);
  const details = {};

  if (typeof body.username !== 'string' || body.username.trim() === '') {
    details.username = 'is required and must be a non-empty string';
  } else if (body.username.length > 64) {
    details.username = 'must be at most 64 characters';
  }

  if (typeof body.email !== 'string' || !EMAIL_SHAPE.test(body.email.trim())) {
    details.email = 'is required and must look like an email address';
  }

  if (typeof body.password !== 'string') {
    details.password = 'is required and must be a string';
  } else if (body.password.length < MIN_PASSWORD_LENGTH) {
    // Length only. No mandatory symbol/digit/mixed-case rules: they push people towards
    // predictable substitutions ("Password1!") and towards writing passwords down, and current
    // NIST guidance favours length plus a breach-list check over composition rules. Measured in
    // characters, because that is what someone typed and would count.
    details.password = `must be at least ${MIN_PASSWORD_LENGTH} characters`;
  } else if (Buffer.byteLength(body.password, 'utf8') > MAX_PASSWORD_BYTES) {
    // Measured in BYTES here, because bcrypt's limit is a byte limit — a passphrase of emoji or
    // non-Latin script reaches 72 bytes at far fewer than 72 characters.
    details.password = `must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }

  if (Object.keys(details).length > 0) {
    return next(new ValidationError('Invalid registration data', details));
  }

  req.validated = {
    username: body.username.trim(),
    email: body.email.trim(),
    password: body.password,
  };
  next();
};

/**
 * POST /users/login — shape only.
 *
 * Deliberately thin: it checks that both fields are present strings and stops there. It does
 * NOT apply the registration rules. Rejecting a 6-character password at login with "must be at
 * least 8 characters" would tell an attacker that the password they guessed is too short to be
 * the real one — free filtering of the search space — and would lock out any account created
 * before the rule existed. Login validates that a credential was supplied; whether it is
 * correct is bcrypt's job, and the answer is always the same opaque 401.
 */
exports.validateLogin = (req, res, next) => {
  const body = bodyOf(req);
  const details = {};
  if (typeof body.email !== 'string' || body.email.trim() === '') details.email = 'is required';
  if (typeof body.password !== 'string' || body.password === '') details.password = 'is required';

  if (Object.keys(details).length > 0) {
    return next(new ValidationError('Invalid login data', details));
  }

  req.validated = { email: body.email.trim(), password: body.password };
  next();
};
