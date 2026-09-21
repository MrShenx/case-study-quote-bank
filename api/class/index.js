// DELETE /api/class?teacherCode=...&classId=... — deletes a class and
//   everything that belongs to it: every task, every student submission on
//   those tasks, the score PDFs in Blob storage, and the join code. Pass
//   dryRun=1 to be told what would go without anything being deleted, which
//   is what the confirmation dialog in index.html shows the teacher.
// POST /api/class — a teacher creates a class, gets back a short join code
//   to hand to students (see index.html's "Join a class" flow).
// GET  /api/class?teacherCode=... — lists the classes owned by that teacher
//   code, for the Teacher mode "My classes" list.
//
// Auth model matches the rest of this app: no accounts, no passwords — a
// "teacher code" is just a crypto.randomUUID() generated client-side and
// kept in localStorage, exactly like the existing student cloud-code. Anyone
// holding that code can manage the classes it created; there is nothing more
// secret than that anywhere else in this app either (see api/project/[id].js).

import { randomUUID } from 'node:crypto';
import { kv, noKvResponse, ID_RE, MAX_BYTES, byteSize, readJsonBody,
         generateJoinCode, classKey, joinCodeKey, teacherClassesKey,
         purgeTask, deleteBlob } from '../_lib/kv.js';

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }

  if (req.method === 'GET') {
    const teacherCode = req.query && req.query.teacherCode;
    if (typeof teacherCode !== 'string' || !ID_RE.test(teacherCode)) {
      res.status(400).json({ error: 'Missing or invalid teacherCode.' });
      return;
    }
    let classIds;
    try {
      classIds = (await kv.get(teacherClassesKey(teacherCode))) || [];
    } catch (err) {
      console.error('KV get failed:', err);
      res.status(500).json({ error: 'Could not read your classes. Please try again.' });
      return;
    }
    const classes = [];
    for (const id of classIds) {
      let rec;
      try {
        rec = await kv.get(classKey(id));
      } catch {
        continue;
      }
      if (!rec) continue; // tolerate a class that was deleted out from under the index
      classes.push({
        id, name: rec.name, joinCode: rec.joinCode,
        taskCount: (rec.taskIds || []).length, createdAt: rec.createdAt
      });
    }
    classes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.status(200).json({ classes });
    return;
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const { teacherCode, name } = body;
    if (typeof teacherCode !== 'string' || !ID_RE.test(teacherCode)) {
      res.status(400).json({ error: 'Missing or invalid teacherCode.' });
      return;
    }
    const cleanName = (typeof name === 'string' ? name : '').trim().slice(0, 200);
    if (!cleanName) {
      res.status(400).json({ error: 'A class name is required.' });
      return;
    }

    const classId = randomUUID();
    let joinCode;
    try {
      // Collisions are astronomically unlikely at this scale, but check
      // anyway rather than ever silently overwriting another class's code.
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateJoinCode();
        if (!(await kv.get(joinCodeKey(candidate)))) { joinCode = candidate; break; }
      }
      if (!joinCode) {
        res.status(500).json({ error: 'Could not generate a unique join code. Please try again.' });
        return;
      }

      const record = { name: cleanName, joinCode, teacherCode, taskIds: [], createdAt: Date.now() };
      if (byteSize(record) > MAX_BYTES) {
        res.status(413).json({ error: 'That class name is too long.' });
        return;
      }
      await kv.set(classKey(classId), record);
      await kv.set(joinCodeKey(joinCode), { classId });

      const existingIds = (await kv.get(teacherClassesKey(teacherCode))) || [];
      await kv.set(teacherClassesKey(teacherCode), [...existingIds, classId]);
    } catch (err) {
      console.error('KV write failed:', err);
      res.status(500).json({ error: 'Could not create the class. Please try again.' });
      return;
    }

    res.status(200).json({ classId, joinCode });
    return;
  }

  // Irreversible, and it destroys work that belongs to students rather than
  // to the teacher, so it reports precisely what it removed — and, with
  // dryRun, what it would remove — instead of a bare ok:true.
  if (req.method === 'DELETE') {
    const teacherCode = req.query && req.query.teacherCode;
    const classId = req.query && req.query.classId;
    const dryRun = !!(req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true'));
    if (typeof teacherCode !== 'string' || !ID_RE.test(teacherCode)) {
      res.status(400).json({ error: 'Missing or invalid teacherCode.' });
      return;
    }
    if (typeof classId !== 'string' || !ID_RE.test(classId)) {
      res.status(400).json({ error: 'Missing or invalid classId.' });
      return;
    }

    let classRec;
    try {
      classRec = await kv.get(classKey(classId));
    } catch (err) {
      console.error('KV get failed:', err);
      res.status(500).json({ error: 'Could not look up that class. Please try again.' });
      return;
    }
    // Already gone is a success: the caller's goal is that it not exist.
    if (!classRec) {
      res.status(200).json({ ok: true, alreadyGone: true, className: null, tasks: 0, submissions: 0 });
      return;
    }
    if (classRec.teacherCode !== teacherCode) {
      res.status(403).json({ error: "That teacher code doesn't match the owner of this class." });
      return;
    }

    const taskIds = classRec.taskIds || [];

    if (dryRun) {
      let submissions = 0;
      for (const taskId of taskIds) {
        try {
          const subs = await kv.get(`submissions:${taskId}`);
          if (Array.isArray(subs)) submissions += subs.length;
        } catch { /* informational */ }
      }
      res.status(200).json({ dryRun: true, className: classRec.name, tasks: taskIds.length, submissions });
      return;
    }

    const removed = { tasks: 0, submissions: 0, blobs: 0, blobErrors: [] };
    try {
      for (const taskId of taskIds) {
        const r = await purgeTask(taskId, deleteBlob);
        removed.tasks += 1;
        removed.submissions += r.submissions;
        if (r.blobDeleted) removed.blobs += 1;
        if (r.blobError) removed.blobErrors.push(r.blobError);
      }
      if (classRec.joinCode) await kv.del(joinCodeKey(classRec.joinCode));
      await kv.del(classKey(classId));
      const ids = (await kv.get(teacherClassesKey(teacherCode))) || [];
      await kv.set(teacherClassesKey(teacherCode), ids.filter((x) => x !== classId));
    } catch (err) {
      console.error('KV delete failed:', err);
      res.status(500).json({ error: 'Could not finish deleting the class. Please try again.' });
      return;
    }

    res.status(200).json({ ok: true, className: classRec.name, ...removed });
    return;
  }

  res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
  res.status(405).json({ error: `Method ${req.method} not allowed.` });
}
