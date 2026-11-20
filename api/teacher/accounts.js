// Teacher accounts, for teachers other than the site owner.
//
// Owner only (signed in with the passphrase):
//   GET  /api/teacher/accounts                      — list the invited teachers
//   POST { action: 'invite' }                       — a one-use link for a new teacher
//   POST { action: 'reset', name }                  — a one-use link to set a new password
//   POST { action: 'remove', name, dryRun? }        — delete the account AND every class,
//                                                     task, score PDF and submission it owns
// The invited teacher themselves (signed in as that teacher):
//   POST { action: 'delete-self', dryRun: true }    — what deleting their account would remove
//   POST { action: 'delete-self', password }        — delete their own account and everything
//                                                     it owns, the same as 'remove'
// Anyone holding an invite link:
//   POST { action: 'check-invite', invite }         — is it still good, and what is it for
//   POST { action: 'accept-invite', invite, name?, password }
//                                                   — make the account (or set the new
//                                                     password) and sign straight in
//
// One file rather than several because Vercel's Hobby plan caps a deployment
// at twelve functions and this makes the twelfth.
//
// Each invited teacher gets a fresh random teacher code, so they start with an
// empty class list and the existing per-class ownership checks keep everyone
// to their own work. The owner manages accounts but never sees inside them.

import { randomBytes, randomUUID } from 'node:crypto';
import { kv, noKvResponse, readJsonBody, classKey, teacherClassesKey,
         submissionsKey, purgeClass, deleteBlob } from '../_lib/kv.js';
import { requireOwner, passphraseConfigured, clientIp, rateLimit,
         cleanTeacherName, nameKeyOf, teacherKey, inviteKey, TEACHER_INDEX_KEY,
         INVITE_SECONDS, SESSION_SECONDS, MIN_PASSWORD, hashPassword, checkPassword,
         teacherSessionToken, resolveSession, bearer } from '../_lib/auth.js';

const INVITE_RE = /^[A-Za-z0-9_-]{20,64}$/;

async function classesOf(code) {
  const ids = (await kv.get(teacherClassesKey(code))) || [];
  const out = [];
  for (const id of ids) {
    const rec = await kv.get(classKey(id));
    if (rec) out.push({ id, rec });
  }
  return out;
}

// What an account owns, counted before anything is deleted.
async function countTeacherData(rec) {
  const classes = await classesOf(rec.code);
  let tasks = 0, submissions = 0;
  for (const { rec: c } of classes) {
    tasks += (c.taskIds || []).length;
    for (const t of c.taskIds || []) {
      try {
        const subs = await kv.get(submissionsKey(t));
        if (Array.isArray(subs)) submissions += subs.length;
      } catch { /* informational */ }
    }
  }
  return { classes, counts: { classes: classes.length, tasks, submissions } };
}

// Deletes an account and everything it owns: every class, with its tasks,
// score PDFs, recordings and submissions (purgeClass), then the account.
// Classes first, account last: if this is interrupted the account still
// exists, so doing it again finishes the job. Throws with .removed attached.
async function purgeTeacher(rec, classes) {
  const removed = { classes: 0, tasks: 0, submissions: 0, blobs: 0, blobErrors: [] };
  try {
    for (const { id, rec: c } of classes) {
      const r = await purgeClass(id, c, deleteBlob);
      removed.classes += 1;
      removed.tasks += r.tasks;
      removed.submissions += r.submissions;
      removed.blobs += r.blobs;
      removed.blobErrors.push(...r.blobErrors);
    }
    await kv.del(teacherClassesKey(rec.code));
    await kv.del(teacherKey(rec.nameKey));
    await kv.srem(TEACHER_INDEX_KEY, rec.nameKey);
  } catch (err) {
    err.removed = removed;
    throw err;
  }
  return removed;
}

async function newInvite(record) {
  const token = randomBytes(24).toString('base64url');
  await kv.set(inviteKey(token), { ...record, createdAt: Date.now() }, { ex: INVITE_SECONDS });
  return { invite: token, expiresAt: Date.now() + INVITE_SECONDS * 1000 };
}

async function readInvite(token) {
  if (typeof token !== 'string' || !INVITE_RE.test(token)) return null;
  const rec = await kv.get(inviteKey(token));
  return rec && (rec.kind === 'new' || rec.kind === 'reset') ? rec : null;
}

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }

  if (req.method === 'GET') {
    if (!(await requireOwner(req, res))) return;
    try {
      const keys = (await kv.smembers(TEACHER_INDEX_KEY)) || [];
      const teachers = [];
      for (const nk of keys) {
        const rec = await kv.get(teacherKey(nk));
        if (!rec) continue;
        const ids = (await kv.get(teacherClassesKey(rec.code))) || [];
        teachers.push({ name: rec.name, createdAt: rec.createdAt, classes: ids.length });
      }
      teachers.sort((a, b) => a.name.localeCompare(b.name));
      res.status(200).json({ teachers });
    } catch (err) {
      console.error('Listing teachers failed:', err);
      res.status(500).json({ error: 'Could not list teacher accounts. Please try again.' });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).json({ error: `Method ${req.method} not allowed.` });
    return;
  }

  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  const action = body.action;

  // ---------- the invited teacher's side ----------
  if (action === 'check-invite' || action === 'accept-invite') {
    if (!passphraseConfigured()) {
      res.status(503).json({ error: 'Teacher accounts are not switched on for this site.' });
      return;
    }
    if (!(await rateLimit(res, 'invite', clientIp(req), 20, 3600))) return;
    let inv;
    try { inv = await readInvite(body.invite); }
    catch (err) {
      console.error('KV failed reading invite:', err);
      res.status(500).json({ error: 'Could not check that link. Please try again.' });
      return;
    }
    if (!inv) {
      res.status(404).json({ error: 'This link has expired or has already been used. Ask for a new one.' });
      return;
    }
    let resetRec = null;
    if (inv.kind === 'reset') {
      resetRec = await kv.get(teacherKey(inv.nameKey));
      if (!resetRec) {
        res.status(404).json({ error: 'The account this link was for no longer exists.' });
        return;
      }
    }

    if (action === 'check-invite') {
      res.status(200).json({ kind: inv.kind, name: resetRec ? resetRec.name : null });
      return;
    }

    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD || password.length > 200) {
      res.status(400).json({ error: `Choose a password of at least ${MIN_PASSWORD} characters.` });
      return;
    }

    let rec;
    if (inv.kind === 'new') {
      const name = cleanTeacherName(body.name);
      if (!name) {
        res.status(400).json({ error: 'Use 2–40 letters, numbers or spaces for your name.' });
        return;
      }
      const nk = nameKeyOf(name);
      const { salt, hash } = await hashPassword(password);
      rec = { name, nameKey: nk, code: randomUUID(), salt, hash, pv: 1, createdAt: Date.now() };
      // nx: never overwrite an existing account with the same name.
      const ok = await kv.set(teacherKey(nk), rec, { nx: true });
      if (!ok) {
        res.status(409).json({ error: 'Someone already has that name. Add an initial or your surname.' });
        return;
      }
    } else {
      const { salt, hash } = await hashPassword(password);
      rec = { ...resetRec, salt, hash, pv: (resetRec.pv || 1) + 1 };
    }

    // Used up only now that the details were good, so a typo doesn't burn the
    // link. del() returning 0 means another tab got there first.
    const consumed = await kv.del(inviteKey(body.invite));
    if (!consumed) {
      if (inv.kind === 'new') await kv.del(teacherKey(rec.nameKey));
      res.status(404).json({ error: 'This link has already been used. Ask for a new one.' });
      return;
    }
    if (inv.kind === 'new') await kv.sadd(TEACHER_INDEX_KEY, rec.nameKey);
    else await kv.set(teacherKey(rec.nameKey), rec);

    const token = await teacherSessionToken(rec);
    res.status(200).json({ token, expiresAt: Date.now() + SESSION_SECONDS * 1000,
                           teacherCode: rec.code, role: 'teacher', name: rec.name });
    return;
  }

  // ---------- a teacher deleting their own account ----------
  if (action === 'delete-self') {
    if (!passphraseConfigured()) {
      res.status(503).json({ error: 'Teacher accounts are not switched on for this site.' });
      return;
    }
    // Password guesses are what this has to slow down.
    if (!(await rateLimit(res, 'delete-self', clientIp(req), 10, 3600))) return;
    const session = await resolveSession(bearer(req));
    if (!session) {
      res.status(401).json({ error: 'Teacher sign-in required.', needsUnlock: true });
      return;
    }
    if (session.role !== 'teacher') {
      // The owner's sign-in is the site's passphrase, not an account.
      res.status(403).json({ error: 'The site owner’s sign-in is not an account and can’t be deleted here.' });
      return;
    }
    let rec;
    try { rec = await kv.get(teacherKey(nameKeyOf(session.name))); }
    catch (err) {
      console.error('KV failed reading account:', err);
      res.status(500).json({ error: 'Could not look up your account. Please try again.' });
      return;
    }
    if (!rec || rec.code !== session.code) {
      res.status(404).json({ error: 'This account no longer exists.' });
      return;
    }
    let found;
    try { found = await countTeacherData(rec); }
    catch (err) {
      console.error('Reading classes failed:', err);
      res.status(500).json({ error: 'Could not read your classes. Please try again.' });
      return;
    }
    if (body.dryRun) {
      res.status(200).json({ dryRun: true, name: rec.name, ...found.counts,
                             classIds: found.classes.map(c => c.id) });
      return;
    }
    if (!(await checkPassword(body.password, rec))) {
      res.status(403).json({ error: 'That password isn’t right.' });
      return;
    }
    try {
      const removed = await purgeTeacher(rec, found.classes);
      res.status(200).json({ ok: true, name: rec.name, ...removed });
    } catch (err) {
      console.error('Deleting own account failed:', err);
      res.status(500).json({ error: 'Deleting stopped partway. Please try again to finish it.', removed: err.removed });
    }
    return;
  }

  // ---------- the owner's side ----------
  if (!(await requireOwner(req, res))) return;

  if (action === 'invite') {
    try { res.status(200).json(await newInvite({ kind: 'new' })); }
    catch (err) {
      console.error('Creating invite failed:', err);
      res.status(500).json({ error: 'Could not create an invite. Please try again.' });
    }
    return;
  }

  const name = cleanTeacherName(body.name);
  const rec = name ? await kv.get(teacherKey(nameKeyOf(name))) : null;
  if (!rec) {
    res.status(404).json({ error: 'There is no teacher account with that name.' });
    return;
  }

  if (action === 'reset') {
    try { res.status(200).json({ name: rec.name, ...(await newInvite({ kind: 'reset', nameKey: rec.nameKey })) }); }
    catch (err) {
      console.error('Creating reset link failed:', err);
      res.status(500).json({ error: 'Could not create a reset link. Please try again.' });
    }
    return;
  }

  if (action === 'remove') {
    // Irreversible and it destroys students' work, so the count comes first.
    let found;
    try { found = await countTeacherData(rec); }
    catch (err) {
      console.error('Reading classes failed:', err);
      res.status(500).json({ error: 'Could not read that teacher’s classes. Please try again.' });
      return;
    }
    if (body.dryRun) {
      res.status(200).json({ dryRun: true, name: rec.name, ...found.counts });
      return;
    }
    try {
      const removed = await purgeTeacher(rec, found.classes);
      res.status(200).json({ ok: true, name: rec.name, ...removed });
    } catch (err) {
      console.error('Removing teacher failed:', err);
      res.status(500).json({ error: 'Removal stopped partway. Please try again.', removed: err.removed });
    }
    return;
  }

  res.status(400).json({ error: 'Unknown action.' });
}
