// /api/share/<code>
//   GET    — anyone with the code: the shared copy, to preview and add to
//            their own projects. Never returns the edit-key hash.
//   PUT    — the creator only (X-Share-Key header): replace the shared copy
//            with the project's current analysis. Restarts the one-year expiry.
//   DELETE — the creator only: stop sharing. Idempotent — an already-gone
//            share is a success, since the goal is "this must not exist".

import { kv, noKvResponse, MAX_BYTES, byteSize, readJsonBody } from '../_lib/kv.js';
import { clientIp, rateLimit } from '../_lib/auth.js';
import { shareKey, normalizeShareCode, editKeyMatches, cleanSharePayload,
         publicShare, SHARE_TTL_SECONDS } from '../_lib/share.js';

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }

  const code = normalizeShareCode(req.query && req.query.code);
  if (!code) {
    res.status(400).json({ error: "That isn't a share code — it should be 8 letters and numbers, like K7M4-QX9P." });
    return;
  }
  const ip = clientIp(req);

  let rec;
  try {
    rec = await kv.get(shareKey(code));
  } catch (err) {
    console.error('KV get failed:', err);
    res.status(500).json({ error: 'Could not look up that share. Please try again.' });
    return;
  }

  if (req.method === 'GET') {
    if (!rec) {
      // Counted only on misses, like class codes: a class opening the same
      // link all at once is never throttled, while walking the code space is.
      if (!(await rateLimit(res, 'sharemiss', ip, 60, 3600))) return;
      res.status(404).json({ error: "No shared notes found for that code. It may have been typed wrong, or the person who shared it has stopped sharing." });
      return;
    }
    res.status(200).json(publicShare(rec));
    return;
  }

  if (req.method === 'PUT' || req.method === 'DELETE') {
    const given = req.headers && req.headers['x-share-key'];
    if (!rec) {
      if (req.method === 'DELETE') { res.status(200).json({ ok: true }); return; }
      res.status(404).json({ error: 'This share link no longer exists.' });
      return;
    }
    if (!editKeyMatches(given, rec.editKeyHash)) {
      if (!(await rateLimit(res, 'sharekey', ip, 30, 3600))) return;
      res.status(403).json({ error: 'Only the person who shared these notes can change or remove the link.' });
      return;
    }

    if (req.method === 'DELETE') {
      try {
        await kv.del(shareKey(code));
      } catch (err) {
        console.error('KV del failed:', err);
        res.status(500).json({ error: 'Could not stop sharing. Please try again.' });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const payload = cleanSharePayload(body.payload);
    if (!payload) {
      res.status(400).json({ error: 'Nothing to share was sent.' });
      return;
    }
    if (byteSize(payload) > MAX_BYTES) {
      res.status(413).json({ error: 'This project has too much analysis to share in one link (limit ~900KB of notes and tags).' });
      return;
    }
    const updated = { ...rec, payload, updatedAt: Date.now() };
    try {
      await kv.set(shareKey(code), updated, { ex: SHARE_TTL_SECONDS });
    } catch (err) {
      console.error('KV set failed:', err);
      res.status(500).json({ error: 'Could not update the share link. Please try again.' });
      return;
    }
    res.status(200).json({ ok: true, updatedAt: updated.updatedAt });
    return;
  }

  res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
  res.status(405).json({ error: `Method ${req.method} not allowed.` });
}
