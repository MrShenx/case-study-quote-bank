// Shared helpers for the class/task/submission serverless functions.
// Deliberately mirrors api/project/[id].js's own resolveEnvVar/kv-client setup
// (same Vercel KV database, same env-var-name-resolution needed because a
// marketplace integration may prefix the var names) rather than introducing a
// second way of talking to the same store. Files/folders prefixed with "_" are
// not deployed as routes by Vercel, so this is safe to import from but never
// itself reachable as an endpoint.

import { createClient } from '@vercel/kv';

export function resolveEnvVar(name) {
  if (process.env[name]) return process.env[name];
  const key = Object.keys(process.env).find((k) => k.endsWith('_' + name));
  return key ? process.env[key] : undefined;
}

const KV_URL = resolveEnvVar('KV_REST_API_URL');
const KV_TOKEN = resolveEnvVar('KV_REST_API_TOKEN');
export const kv = KV_URL && KV_TOKEN ? createClient({ url: KV_URL, token: KV_TOKEN }) : null;

export function noKvResponse(res) {
  res.status(500).json({
    error: 'No database is connected to this deployment yet (or it was connected after the last ' +
           'deploy — try redeploying). Check the Storage tab in the Vercel dashboard.'
  });
}

// Same shape as the existing student "cloud code" — crypto.randomUUID() —
// so id validation stays consistent across every endpoint in this app.
export const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

// Class/task join codes are short enough for a student to type by hand, so
// they're generated and validated separately from the long UUID-style ids.
export const JOIN_CODE_RE = /^[A-Z0-9]{5,8}$/;

// Same margin below Vercel KV's real per-value ceiling used throughout this
// app (see api/project/[id].js) — keeps a runaway payload a fast, friendly
// 413 instead of a confusing server error.
export const MAX_BYTES = 900 * 1024;

export function byteSize(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

export async function readJsonBody(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: 'Request body was not valid JSON.' });
      return undefined;
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'Request body must be a JSON object.' });
    return undefined;
  }
  return body;
}

// Generates a short, human-typable join code (no 0/O/1/I — easy to misread
// off a whiteboard or a printed handout) and retries on the rare collision.
const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateJoinCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return out;
}

export function classKey(id) { return `class:${id}`; }
export function joinCodeKey(code) { return `joincode:${code.toUpperCase()}`; }
export function taskKey(id) { return `task:${id}`; }
export function submissionsKey(taskId) { return `submissions:${taskId}`; }

export function teacherClassesKey(teacherCode) { return `teacherclasses:${teacherCode}`; }

// Deleting a task means deleting everything that hangs off it: the students'
// submissions, and the score PDF, which lives in Blob storage rather than KV.
// Blob deletion is best-effort and reported rather than fatal — a PDF that
// outlives its task is waste, but failing the whole delete over it would
// leave the task and its submissions in place, which is worse. Returns what
// it removed so the caller can tell the teacher.
export async function purgeTask(taskId, blobDeleter) {
  const result = { taskId, submissions: 0, blobDeleted: false, blobError: null };
  let task = null;
  try { task = await kv.get(taskKey(taskId)); } catch { /* treat as already gone */ }
  try {
    const subs = await kv.get(submissionsKey(taskId));
    result.submissions = Array.isArray(subs) ? subs.length : 0;
  } catch { /* count is informational only */ }
  await kv.del(submissionsKey(taskId));
  await kv.del(taskKey(taskId));
  if (task && task.pdfBlobUrl && blobDeleter) {
    try { await blobDeleter(task.pdfBlobUrl); result.blobDeleted = true; }
    catch (err) { result.blobError = String(err && err.message || err); }
  }
  return result;
}

// The one place that knows how this project authenticates to Blob storage:
// OIDC, not a static BLOB_READ_WRITE_TOKEN (see api/task/upload.js for why).
// The SDK picks the OIDC credential up from the function's environment, so
// del() needs no token passed by hand.
export async function deleteBlob(url) {
  const { del } = await import('@vercel/blob');
  await del(url);
}
