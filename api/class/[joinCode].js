// GET /api/class/<joinCode> — public lookup a student uses once to join a
// class: resolves the short code they were given to the class name and its
// list of tasks (id + title only — full score/video/question content is
// fetched per-task via /api/task/[id] only once a student actually opens it).

import { kv, noKvResponse, JOIN_CODE_RE, joinCodeKey, classKey, taskKey } from '../_lib/kv.js';

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(405).json({ error: `Method ${req.method} not allowed.` });
    return;
  }

  const joinCode = req.query && req.query.joinCode;
  if (typeof joinCode !== 'string' || !JOIN_CODE_RE.test(joinCode.toUpperCase())) {
    res.status(400).json({ error: 'Invalid class code — double-check it and try again.' });
    return;
  }

  let pointer, classRec;
  try {
    pointer = await kv.get(joinCodeKey(joinCode));
    if (!pointer) {
      res.status(404).json({ error: "No class found for that code — double-check it's typed correctly." });
      return;
    }
    classRec = await kv.get(classKey(pointer.classId));
  } catch (err) {
    console.error('KV get failed:', err);
    res.status(500).json({ error: 'Could not look up that class. Please try again.' });
    return;
  }
  if (!classRec) {
    res.status(404).json({ error: 'That class no longer exists.' });
    return;
  }

  const tasks = [];
  for (const id of classRec.taskIds || []) {
    let task;
    try {
      task = await kv.get(taskKey(id));
    } catch {
      continue;
    }
    if (!task) continue;
    tasks.push({ id, title: task.title, questionText: task.questionText, createdAt: task.createdAt });
  }
  tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  res.status(200).json({ classId: pointer.classId, className: classRec.name, tasks });
}
