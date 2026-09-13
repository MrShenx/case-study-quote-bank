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
         generateJoinCode, classKey, joinCodeKey } from '../_lib/kv.js';

function teacherClassesKey(teacherCode) {
  return `teacherclasses:${teacherCode}`;
}

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

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: `Method ${req.method} not allowed.` });
}
