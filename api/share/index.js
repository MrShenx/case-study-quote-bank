// POST /api/share — turn one project's analysis into a share link.
// Body: { payload } (the same shape as a cloud backup).
// Returns: { code, editKey, createdAt, updatedAt }. The edit key is shown to
// nobody but the creator's browser, which keeps it on the project record; it
// is what lets them update or stop sharing later (see api/share/[code].js).

import { kv, noKvResponse, MAX_BYTES, byteSize, readJsonBody } from '../_lib/kv.js';
import { clientIp, rateLimit } from '../_lib/auth.js';
import { shareKey, generateShareCode, generateEditKey, hashEditKey,
         cleanSharePayload, SHARE_TTL_SECONDS } from '../_lib/share.js';

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({ error: `Method ${req.method} not allowed.` });
    return;
  }

  // Generous, because a whole class sits behind one school address; this only
  // stops a runaway script from filling the database.
  if (!(await rateLimit(res, 'sharecreate', clientIp(req), 200, 3600))) return;

  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  const payload = cleanSharePayload(body.payload);
  if (!payload) {
    res.status(400).json({ error: 'Nothing to share was sent.' });
    return;
  }
  if (byteSize(payload) > MAX_BYTES) {
    res.status(413).json({
      error: 'This project has too much analysis to share in one link (limit ~900KB of notes and tags). ' +
             'Splitting it into two projects will fix it.'
    });
    return;
  }

  const editKey = generateEditKey();
  const now = Date.now();
  // A fresh code is almost never taken, but set-if-absent makes sure two
  // shares can never land on the same one.
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateShareCode();
    const record = { code, payload, editKeyHash: hashEditKey(editKey), createdAt: now, updatedAt: now };
    let stored;
    try {
      stored = await kv.set(shareKey(code), record, { nx: true, ex: SHARE_TTL_SECONDS });
    } catch (err) {
      console.error('KV set failed:', err);
      res.status(500).json({ error: 'Could not create the share link. Please try again.' });
      return;
    }
    if (stored) {
      res.status(200).json({ code, editKey, createdAt: now, updatedAt: now });
      return;
    }
  }
  res.status(500).json({ error: 'Could not create the share link. Please try again.' });
}
