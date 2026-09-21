// GET  /api/maintenance?teacherCode=... — an inventory of what this app is
//   actually storing, and which of it is orphaned: records nothing points at
//   any more.
// POST /api/maintenance  {teacherCode, confirm:true} — deletes those orphans.
//
// Why this exists: until the delete routes were added, nothing in this app
// could ever remove anything from the server, so KV and Blob could only grow.
// A delete can also be interrupted half-way (a function timing out between
// two writes), and that leaves exactly the kind of debris this reports.
//
// Scope is deliberately narrow. It only ever deletes records that are already
// unreachable from any class — a task whose class is gone, submissions whose
// task is gone, a join code pointing at nothing, a score PDF no task refers
// to. Anything still reachable is left alone, however old it looks.
//
// Student cloud backups (project:*) are COUNTED AND NEVER DELETED. The server
// has no way to know whether a backup's owner still has the project on their
// device — that's the entire point of a backup — so "orphaned" is not a
// question this endpoint can answer about them, and guessing would destroy a
// student's only remaining copy of their work.
//
// Auth is the same teacher code used everywhere else, and it must already own
// at least one class, so this isn't reachable with a freshly minted code. The
// report deliberately returns no backup codes or student names — counts only.

import { kv, noKvResponse, ID_RE, readJsonBody, classKey, taskKey,
         submissionsKey, joinCodeKey, teacherClassesKey, deleteBlob } from './_lib/kv.js';

async function allKeys(pattern) {
  const out = [];
  let cursor = 0;
  do {
    const [next, batch] = await kv.scan(cursor, { match: pattern, count: 500 });
    out.push(...batch);
    cursor = Number(next);
  } while (cursor !== 0);
  return [...new Set(out)];
}

async function knownTeacher(teacherCode) {
  const ids = await kv.get(teacherClassesKey(teacherCode));
  return Array.isArray(ids) && ids.length > 0;
}

// Walks the whole store and works out what is still reachable from a class.
async function survey() {
  const classKeys = await allKeys('class:*');
  const taskKeys = await allKeys('task:*');
  const subKeys = await allKeys('submissions:*');
  const joinKeys = await allKeys('joincode:*');
  const projectKeys = await allKeys('project:*');

  const classes = [];
  const liveTaskIds = new Set();
  const liveJoinCodes = new Set();
  for (const k of classKeys) {
    const id = k.slice('class:'.length);
    const rec = await kv.get(k);
    if (!rec) continue;
    classes.push({ id, name: rec.name, joinCode: rec.joinCode, tasks: (rec.taskIds || []).length });
    (rec.taskIds || []).forEach((t) => liveTaskIds.add(t));
    if (rec.joinCode) liveJoinCodes.add(rec.joinCode.toUpperCase());
  }

  const orphanTasks = [];
  const liveBlobUrls = new Set();
  let liveSubmissionCount = 0;
  for (const k of taskKeys) {
    const id = k.slice('task:'.length);
    const rec = await kv.get(k);
    if (!rec) continue;
    if (liveTaskIds.has(id)) {
      if (rec.pdfBlobUrl) liveBlobUrls.add(rec.pdfBlobUrl);
    } else {
      orphanTasks.push({ id, title: rec.title || null, pdfBlobUrl: rec.pdfBlobUrl || null });
    }
  }

  const orphanSubmissions = [];
  for (const k of subKeys) {
    const taskId = k.slice('submissions:'.length);
    const list = await kv.get(k);
    const count = Array.isArray(list) ? list.length : 0;
    if (liveTaskIds.has(taskId)) liveSubmissionCount += count;
    else orphanSubmissions.push({ taskId, count });
  }

  const orphanJoinCodes = [];
  for (const k of joinKeys) {
    const code = k.slice('joincode:'.length);
    const pointer = await kv.get(k);
    const cls = pointer && pointer.classId ? await kv.get(classKey(pointer.classId)) : null;
    if (!cls || !liveJoinCodes.has(code.toUpperCase())) orphanJoinCodes.push({ code });
  }

  // Blobs are listed separately from KV, so a PDF can outlive every record
  // that ever referred to it.
  let orphanBlobs = [];
  let blobListError = null;
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list();
    orphanBlobs = blobs
      .filter((b) => !liveBlobUrls.has(b.url))
      .map((b) => ({ url: b.url, pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt }));
  } catch (err) {
    blobListError = String((err && err.message) || err);
  }

  return {
    live: {
      classes: classes.length,
      tasks: liveTaskIds.size,
      submissions: liveSubmissionCount,
      scorePdfs: liveBlobUrls.size,
      classList: classes
    },
    // Counted, never touched — see the note at the top of this file.
    studentCloudBackups: projectKeys.length,
    orphans: { tasks: orphanTasks, submissions: orphanSubmissions, joinCodes: orphanJoinCodes, blobs: orphanBlobs },
    blobListError
  };
}

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }

  const src = req.method === 'GET' ? (req.query || {}) : ((await readJsonBody(req, res)) || {});
  if (req.method !== 'GET' && src === undefined) return;
  const teacherCode = src.teacherCode;
  if (typeof teacherCode !== 'string' || !ID_RE.test(teacherCode)) {
    res.status(400).json({ error: 'Missing or invalid teacherCode.' });
    return;
  }
  try {
    if (!(await knownTeacher(teacherCode))) {
      res.status(403).json({ error: 'That teacher code does not own any classes.' });
      return;
    }
  } catch (err) {
    console.error('KV get failed:', err);
    res.status(500).json({ error: 'Could not verify that teacher code.' });
    return;
  }

  let report;
  try {
    report = await survey();
  } catch (err) {
    console.error('Survey failed:', err);
    res.status(500).json({ error: 'Could not survey stored data: ' + ((err && err.message) || err) });
    return;
  }

  if (req.method === 'GET') {
    res.status(200).json({ report });
    return;
  }

  if (req.method === 'POST') {
    if (src.confirm !== true) {
      res.status(400).json({ error: 'Pass confirm:true to delete the orphaned records this reports.' });
      return;
    }
    const deleted = { tasks: 0, submissionRecords: 0, submissions: 0, joinCodes: 0, blobs: 0, errors: [] };
    try {
      for (const t of report.orphans.tasks) {
        await kv.del(taskKey(t.id));
        deleted.tasks += 1;
      }
      for (const s of report.orphans.submissions) {
        await kv.del(submissionsKey(s.taskId));
        deleted.submissionRecords += 1;
        deleted.submissions += s.count;
      }
      for (const j of report.orphans.joinCodes) {
        await kv.del(joinCodeKey(j.code));
        deleted.joinCodes += 1;
      }
      for (const b of report.orphans.blobs) {
        try { await deleteBlob(b.url); deleted.blobs += 1; }
        catch (err) { deleted.errors.push(b.pathname + ': ' + ((err && err.message) || err)); }
      }
    } catch (err) {
      console.error('Sweep failed:', err);
      res.status(500).json({ error: 'Sweep stopped partway: ' + ((err && err.message) || err), deleted });
      return;
    }
    res.status(200).json({ ok: true, deleted, reportBefore: report });
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: `Method ${req.method} not allowed.` });
}
