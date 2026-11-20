// Access control for the class-work half of this app.
//
// Three tiers, and only the server decides which one a request is in:
//
//   owner    — Mr Shen (role 'admin' in tokens, for continuity). Proves it
//              with a passphrase that lives only in a Vercel environment
//              variable (never in this repo, never in the page), and gets back
//              a short-lived signed token. Only the owner can invite, reset or
//              remove other teachers, and run the store-wide maintenance.
//   teacher  — another teacher the owner invited. Signs in with their own
//              name and password (scrypt-hashed in KV) and gets a token for
//              their OWN teacher code, so they see only their own classes.
//              The owner cannot see theirs either: every class endpoint
//              already compares the class's teacherCode with the token's.
//   student  — proves membership of one class by holding a token issued when
//              they joined it with the class code.
//   everyone — can read a task by its unguessable id, as before.
//
// Why tokens rather than the teacher code the client used to send: that code
// was generated in the browser and checked against nothing, so anyone could
// mint one and walk into the teacher interface. Hiding the button would have
// been theatre — the server has to be the one that refuses.
//
// BOOTSTRAP, and why this deploy cannot lock anyone out: until
// TEACHER_PASSPHRASE is set in the Vercel dashboard, requireAdmin() falls back
// to exactly the old behaviour (trust the teacherCode in the request). So the
// day this ships nothing changes for the existing teacher; setting that one
// variable is what switches enforcement on, and the teacher page says loudly
// that it hasn't been set yet.

import { createHmac, randomBytes, timingSafeEqual, createHash, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { kv, ID_RE } from './kv.js';

const SECRET_KEY = 'app:secret';
const ADMIN_CODE_KEY = 'admin:code';

export function passphraseConfigured() {
  return typeof process.env.TEACHER_PASSPHRASE === 'string' && process.env.TEACHER_PASSPHRASE.length > 0;
}

// One signing secret for every token this app issues. Generated on first use
// and kept in KV rather than derived from the passphrase, so student tokens
// keep working before the passphrase is set and survive it being changed.
let cachedSecret = null;
async function signingSecret() {
  if (cachedSecret) return cachedSecret;
  let s = await kv.get(SECRET_KEY);
  if (!s) {
    s = randomBytes(32).toString('hex');
    await kv.set(SECRET_KEY, s);
  }
  cachedSecret = s;
  return s;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export async function signToken(payload, ttlSeconds) {
  const body = { ...payload, exp: Date.now() + ttlSeconds * 1000 };
  const data = b64u(JSON.stringify(body));
  const mac = createHmac('sha256', await signingSecret()).update(data).digest('base64url');
  return data + '.' + mac;
}

// Returns the payload, or null for anything that isn't a token this server
// signed and that hasn't expired. Never throws on malformed input.
export async function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const data = token.slice(0, dot), mac = token.slice(dot + 1);
  let expected;
  try {
    expected = createHmac('sha256', await signingSecret()).update(data).digest('base64url');
  } catch { return null; }
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

export function checkPassphrase(given) {
  if (!passphraseConfigured()) return false;
  if (typeof given !== 'string') return false;
  // Hash both sides first so the comparison is over equal-length buffers and
  // the length of the real passphrase doesn't leak through timing.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(process.env.TEACHER_PASSPHRASE).digest();
  return timingSafeEqual(a, b);
}

// The teacher code that owns the admin's classes. Bound once, to whatever code
// the admin's browser is already using, so every class/task/submission created
// before this existed keeps its owner and nothing needs migrating.
export async function adminCode(adoptIfUnset) {
  let code = await kv.get(ADMIN_CODE_KEY);
  if (!code && typeof adoptIfUnset === 'string' && ID_RE.test(adoptIfUnset)) {
    code = adoptIfUnset;
    await kv.set(ADMIN_CODE_KEY, code);
  }
  return code || null;
}
export async function bindAdminCode(code) {
  await kv.set(ADMIN_CODE_KEY, code);
  return code;
}

export function bearer(req) {
  const h = req.headers || {};
  const direct = h['x-admin-token'] || h['X-Admin-Token'];
  if (typeof direct === 'string' && direct) return direct;
  const auth = h.authorization || h.Authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// ---------- teacher accounts ----------
// teacher:<nameKey>  → { name, nameKey, code, salt, hash, pv, createdAt }
// teachers           → a set of every nameKey, so the owner can list them
// invite:<token>     → { kind: 'new' } or { kind: 'reset', nameKey }, 7-day TTL
// `pv` (password version) goes into every token issued; a password reset
// bumps it and removing the account deletes the record, and either one makes
// the teacher's open sessions stop working on their next request.
const scrypt = promisify(scryptCb);
export const TEACHER_INDEX_KEY = 'teachers';
export function teacherKey(nameKey) { return `teacher:${nameKey}`; }
export function inviteKey(token) { return `invite:${token}`; }
export const INVITE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_SECONDS = 12 * 60 * 60;   // a school day; a shared machine shouldn't stay unlocked

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'\-]{0,38}[\p{L}\p{N}.]$/u;
// Display form keeps the teacher's capitals; the key is what makes "Ms Lee"
// and "ms  lee" the same account.
export function cleanTeacherName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : null;
}
export function nameKeyOf(name) { return name.toLowerCase(); }

export const MIN_PASSWORD = 8;
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { salt, hash };
}
export async function checkPassword(password, rec) {
  // Always do the work, even with no account, so a wrong name and a wrong
  // password take the same time and the reply can't be used to list names.
  const salt = rec && rec.salt ? rec.salt : '00000000000000000000000000000000';
  const got = await scrypt(typeof password === 'string' ? password : '', salt, 64);
  if (!rec || !rec.hash) return false;
  const want = Buffer.from(rec.hash, 'hex');
  return want.length === got.length && timingSafeEqual(got, want);
}

export async function teacherSessionToken(rec) {
  return signToken({ role: 'teacher', code: rec.code, name: rec.name, nk: rec.nameKey, pv: rec.pv }, SESSION_SECONDS);
}

// Who a token belongs to, re-checked against the store for invited teachers
// so that removing an account or resetting its password takes effect at once.
// Returns { role: 'owner'|'teacher', code, name } or null.
export async function resolveSession(token) {
  const payload = await verifyToken(token);
  if (!payload || !payload.code) return null;
  if (payload.role === 'admin') return { role: 'owner', code: payload.code, name: null };
  if (payload.role === 'teacher' && typeof payload.nk === 'string') {
    let rec;
    try { rec = await kv.get(teacherKey(payload.nk)); } catch { return null; }
    if (!rec || rec.code !== payload.code || rec.pv !== payload.pv) return null;
    return { role: 'teacher', code: rec.code, name: rec.name };
  }
  return null;
}

// Resolves a request to the teacher code it is allowed to act as, or null.
// Any signed-in teacher — the owner or an invited one — acts only as their
// own code. In bootstrap mode (no passphrase set yet) it falls back to the
// teacherCode the client sends, which is what shipped before.
export async function requireTeacher(req, res, parsedBody) {
  if (passphraseConfigured()) {
    const session = await resolveSession(bearer(req));
    if (!session) {
      res.status(401).json({ error: 'Teacher sign-in required.', needsUnlock: true });
      return null;
    }
    return session.code;
  }
  // Bootstrap only. parsedBody matters because readJsonBody() hands back a
  // parsed copy without writing it onto req.
  const body = parsedBody || req.body || {};
  const legacy = (typeof body === 'object' && body.teacherCode) || (req.query && req.query.teacherCode);
  if (typeof legacy !== 'string' || !ID_RE.test(legacy)) {
    res.status(400).json({ error: 'Missing or invalid teacherCode.' });
    return null;
  }
  return legacy;
}

// The owner only: managing other teachers' accounts, and the maintenance
// survey that reads the whole store. Never available in bootstrap mode —
// without a passphrase there is no way to tell the owner apart.
export async function requireOwner(req, res) {
  if (!passphraseConfigured()) {
    res.status(503).json({ error: 'Set TEACHER_PASSPHRASE in the Vercel dashboard first.' });
    return null;
  }
  const session = await resolveSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: 'Teacher sign-in required.', needsUnlock: true });
    return null;
  }
  if (session.role !== 'owner') {
    res.status(403).json({ error: 'Only the site owner can do that.' });
    return null;
  }
  return session.code;
}

// Membership of one class: either a token issued at join time, or — for a
// student who joined before tokens existed and hasn't refreshed yet — the
// class's own join code, which only someone given it would have.
// The client sends every membership proof it holds and the server keeps the
// one that fits this class. That is deliberately simpler than having the
// browser work out which class a task belongs to: it cannot get that wrong,
// and nothing is revealed — these are tokens this server signed and codes it
// handed out.
export async function isClassMember(req, classRec, classId) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const tokens = [bearer(req), body.classToken, ...(Array.isArray(body.classTokens) ? body.classTokens : [])];
  for (const t of tokens) {
    if (!t) continue;
    const payload = await verifyToken(t);
    if (payload && payload.role === 'student' && payload.classId === classId) return true;
  }
  const codes = [body.joinCode, ...(Array.isArray(body.joinCodes) ? body.joinCodes : [])];
  const real = classRec && typeof classRec.joinCode === 'string' ? classRec.joinCode.toUpperCase() : null;
  if (real) {
    for (const c of codes) {
      if (typeof c === 'string' && c.toUpperCase() === real) return true;
    }
  }
  return false;
}

export function clientIp(req) {
  const h = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
  return String(h).split(',')[0].trim() || 'unknown';
}

// A counter per IP per bucket, expiring on its own. Enough to make guessing a
// passphrase or walking the join-code space impractical; it is not, and does
// not pretend to be, a defence against a distributed attacker.
export async function rateLimit(res, bucket, ip, limit, windowSeconds) {
  const key = `rl:${bucket}:${ip}`;
  let n;
  try {
    n = await kv.incr(key);
    if (n === 1) await kv.expire(key, windowSeconds);
  } catch {
    return true; // a counter that won't store must not take the app down
  }
  if (n > limit) {
    res.status(429).json({ error: 'Too many attempts. Wait a little and try again.' });
    return false;
  }
  return true;
}
