// POST /api/teacher/unlock { name?, passphrase, adoptTeacherCode? }
//   With no name: the site owner. Checks the passphrase against
//   TEACHER_PASSPHRASE (set in the Vercel dashboard, never in this repo).
//   With a name: an invited teacher, checked against their own password
//   (see api/teacher/accounts.js for how those accounts are made).
//   Either way it returns a short-lived signed token that every teacher-only
//   endpoint requires, tied to that teacher's own classes.
// GET  /api/teacher/unlock — tells the page whether the lock is even switched
//   on yet, so it can warn the teacher if it isn't. Reveals nothing else.
//
// The first successful unlock adopts the teacher code the browser is already
// using, so the classes, tasks and submissions that exist today keep the owner
// they already have and no stored record is touched.

import { kv, noKvResponse, ID_RE, readJsonBody } from '../_lib/kv.js';
import { passphraseConfigured, checkPassphrase, signToken, adminCode,
         clientIp, rateLimit, resolveSession, SESSION_SECONDS,
         cleanTeacherName, nameKeyOf, teacherKey, checkPassword,
         teacherSessionToken } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }

  if (req.method === 'GET') {
    res.status(200).json({ configured: passphraseConfigured() });
    return;
  }

  if (req.method === 'POST') {
    // Ten tries an hour from one address: a human who has forgotten it gets
    // plenty, a script gets nowhere.
    if (!(await rateLimit(res, 'unlock', clientIp(req), 10, 3600))) return;

    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    if (!passphraseConfigured()) {
      res.status(503).json({
        error: 'No teacher passphrase has been set for this deployment yet. ' +
               'Add TEACHER_PASSPHRASE in the Vercel dashboard (Settings → Environment Variables) and redeploy.',
        configured: false
      });
      return;
    }
    // An invited teacher. The same reply for an unknown name and a wrong
    // password, so the sign-in box can't be used to find out who has an account.
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    if (rawName) {
      const name = cleanTeacherName(rawName);
      let rec = null;
      try { rec = name ? await kv.get(teacherKey(nameKeyOf(name))) : null; }
      catch (err) {
        console.error('KV failed during unlock:', err);
        res.status(500).json({ error: 'Could not complete sign-in. Please try again.' });
        return;
      }
      if (!(await checkPassword(body.passphrase, rec))) {
        res.status(401).json({ error: "That name and password don't match." });
        return;
      }
      const token = await teacherSessionToken(rec);
      res.status(200).json({ token, expiresAt: Date.now() + SESSION_SECONDS * 1000,
                             teacherCode: rec.code, role: 'teacher', name: rec.name });
      return;
    }

    if (!checkPassphrase(body.passphrase)) {
      res.status(401).json({ error: "That passphrase doesn't match." });
      return;
    }

    let code;
    try {
      code = await adminCode(body.adoptTeacherCode);
      if (!code) {
        res.status(409).json({
          error: 'No teacher identity is bound to this deployment yet. Open this page in the browser ' +
                 'you already use for teaching, so its existing classes can be adopted.'
        });
        return;
      }
    } catch (err) {
      console.error('KV failed during unlock:', err);
      res.status(500).json({ error: 'Could not complete sign-in. Please try again.' });
      return;
    }

    const token = await signToken({ role: 'admin', code }, SESSION_SECONDS);
    res.status(200).json({ token, expiresAt: Date.now() + SESSION_SECONDS * 1000, teacherCode: code,
                           role: 'owner', name: null });
    return;
  }

  if (req.method === 'PUT') {
    // A cheap "am I still signed in?" for the page to call on load.
    const session = await resolveSession((req.body && req.body.token) || '');
    res.status(200).json({ valid: !!session, role: session ? session.role : null });
    return;
  }

  res.setHeader('Allow', ['GET', 'POST', 'PUT']);
  res.status(405).json({ error: `Method ${req.method} not allowed.` });
}
