// GET /api/class/<joinCode> — public lookup a student uses once to join a
// class: resolves the short code they were given to the class name and its
// list of tasks (id + title only — full score/video/question content is
// fetched per-task via /api/task/[id] only once a student actually opens it).

import { kv, noKvResponse, JOIN_CODE_RE, joinCodeKey, classKey, taskKey } from '../_lib/kv.js';
import { signToken, clientIp, rateLimit } from '../_lib/auth.js';

// A year: a class runs for one, and a student shouldn't be asked to re-enter
// the code every term.
const MEMBERSHIP_SECONDS = 365 * 24 * 60 * 60;

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
  // Six characters from a 32-letter alphabet is about a billion codes, which
  // is only unguessable while guessing is cheap. Counted per address and only
  // on MISSES, so a class refreshing its task list all lesson is never
  // throttled while someone walking the code space is stopped at 20.
  const ip = clientIp(req);

  let pointer, classRec;
  try {
    pointer = await kv.get(joinCodeKey(joinCode));
    if (!pointer) {
      if (!(await rateLimit(res, 'joinmiss', ip, 20, 3600))) return;
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
    if (!(await rateLimit(res, 'joinmiss', ip, 20, 3600))) return;
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

  // Proof of membership, handed out to anyone who can produce the class code —
  // which is exactly the group the code is meant to admit. Submitting work
  // requires it, so a stranger holding only a task id can no longer post into
  // a class. A student who joined before tokens existed picks one up silently
  // the next time their class list refreshes.
  const classToken = await signToken({ role: 'student', classId: pointer.classId }, MEMBERSHIP_SECONDS);
  res.status(200).json({ classId: pointer.classId, className: classRec.name, tasks, classToken });
}
