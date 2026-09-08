// Vercel serverless function — one project's cloud backup.
// File location is the route: this file answers GET/PUT requests to
// /api/project/<id>, where <id> is whatever the student's browser generated
// as their "cloud code" (see saveToCloud()/loadFromCloud() in index.html).
//
// Storage: Vercel KV (a hosted Redis-compatible key/value store). This file
// only runs once a KV database has been created in the Vercel dashboard and
// "Connected" to this project — that step injects KV_REST_API_URL /
// KV_REST_API_TOKEN (or a database-name-prefixed version of those same
// names, e.g. "mydb_KV_REST_API_URL" — Vercel's marketplace integrations do
// this automatically to avoid collisions when a project has more than one
// database connected). resolveEnvVar() below finds either form, so nothing
// needs to be renamed by hand in the dashboard.
//
// Deliberately NOT stored here: the PDF itself, or video timestamps' audio —
// this only backs up the analysis (bar tags, notes, headings). The PDF is
// the shared score file and can always be re-uploaded; re-uploading it is
// far cheaper than the size/cost of storing a multi-MB file per student per
// save. Keeping this endpoint's payload small also keeps it fast and cheap.

import { createClient } from '@vercel/kv';

// Finds an env var by its plain name (e.g. "KV_REST_API_URL"), or, failing
// that, any var ending in "_" + that name (e.g. "casestudyquotes_KV_REST_API_URL")
// — whichever form the connected database's integration happened to use.
function resolveEnvVar(name) {
  if (process.env[name]) return process.env[name];
  const key = Object.keys(process.env).find((k) => k.endsWith('_' + name));
  return key ? process.env[key] : undefined;
}

const KV_URL = resolveEnvVar('KV_REST_API_URL');
const KV_TOKEN = resolveEnvVar('KV_REST_API_TOKEN');
const kv = KV_URL && KV_TOKEN ? createClient({ url: KV_URL, token: KV_TOKEN }) : null;

// cloud codes are generated client-side via crypto.randomUUID() (see
// index.html) — this just guards against anything else being thrown at the
// endpoint (typos, probing, accidental garbage in the URL).
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

// Vercel KV (backed by Upstash Redis) rejects values much above 1MB; keep a
// clear margin so partially-large-but-legitimate projects (many notes, long
// analysis text) still fit, while a runaway payload fails fast with a
// friendly message instead of a confusing server error.
const MAX_BYTES = 900 * 1024;

function keyFor(id) {
  return `project:${id}`;
}

export default async function handler(req, res) {
  if (!kv) {
    res.status(500).json({
      error: 'No database is connected to this deployment yet (or it was connected after the last ' +
             'deploy — try redeploying). Check the Storage tab in the Vercel dashboard.'
    });
    return;
  }

  const id = req.query && req.query.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid or missing project id.' });
    return;
  }

  if (req.method === 'GET') {
    let data;
    try {
      data = await kv.get(keyFor(id));
    } catch (err) {
      console.error('KV get failed:', err);
      res.status(500).json({ error: 'Could not read from cloud storage. Please try again.' });
      return;
    }
    if (data == null) {
      res.status(404).json({ error: "No cloud backup found for that code — double-check it's typed correctly." });
      return;
    }
    res.status(200).json(data);
    return;
  }

  if (req.method === 'PUT') {
    let body = req.body;
    // Vercel parses a JSON body automatically when Content-Type is
    // application/json, but guard in case it ever arrives unparsed.
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        res.status(400).json({ error: 'Request body was not valid JSON.' });
        return;
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Request body must be a JSON object.' });
      return;
    }

    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (size > MAX_BYTES) {
      res.status(413).json({
        error: 'This project is too large to back up to the cloud (limit ~900KB of notes/tags). ' +
               'The score PDF itself is never included in cloud backups, so this usually means ' +
               'an unusually large amount of analysis text — consider splitting it into two projects.'
      });
      return;
    }

    const record = { ...body, savedAt: Date.now() };
    try {
      await kv.set(keyFor(id), record);
    } catch (err) {
      console.error('KV set failed:', err);
      res.status(500).json({ error: 'Could not save to cloud storage. Please try again.' });
      return;
    }
    res.status(200).json({ ok: true, savedAt: record.savedAt });
    return;
  }

  res.setHeader('Allow', ['GET', 'PUT']);
  res.status(405).json({ error: `Method ${req.method} not allowed.` });
}
