// GET /api/task/<id> — fetches one task's full content (PDF url, video,
// question, any teacher pre-tagging) so a student's browser can hydrate it
// into a normal local project. Same trust model as the rest of this app
// (an unguessable random id is the only "access control" — see
// api/project/[id].js) rather than a new kind of check.
// PUT /api/task/<id> — a teacher updates their own pre-tagging (bar markers,
// systems, groups) on an already-created task, e.g. after using the
// existing Studio tagging UI on their own local copy. Requires the
// teacherCode matching the task's owning class — updating in place (rather
// than creating a new task, which api/task/index.js's POST is for) so
// students who already joined via this task's id keep working.

import { kv, noKvResponse, ID_RE, MAX_BYTES, byteSize, readJsonBody,
         classKey, taskKey } from '../_lib/kv.js';

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }

  const id = req.query && req.query.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid or missing task id.' });
    return;
  }

  if (req.method === 'GET') {
    let task;
    try {
      task = await kv.get(taskKey(id));
    } catch (err) {
      console.error('KV get failed:', err);
      res.status(500).json({ error: 'Could not load this task. Please try again.' });
      return;
    }
    if (!task) {
      res.status(404).json({ error: 'This task no longer exists.' });
      return;
    }
    res.status(200).json(task);
    return;
  }

  if (req.method === 'PUT') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const { teacherCode, title, questionText, videoId, pdfBlobUrl, pdfName,
            markersByPage, pageSystems, groups, barCounter } = body;
    if (typeof teacherCode !== 'string' || !ID_RE.test(teacherCode)) {
      res.status(400).json({ error: 'Missing or invalid teacherCode.' });
      return;
    }

    let task, classRec;
    try {
      task = await kv.get(taskKey(id));
      if (!task) { res.status(404).json({ error: 'This task no longer exists.' }); return; }
      classRec = await kv.get(classKey(task.classId));
    } catch (err) {
      console.error('KV get failed:', err);
      res.status(500).json({ error: 'Could not look up this task. Please try again.' });
      return;
    }
    if (!classRec || classRec.teacherCode !== teacherCode) {
      res.status(403).json({ error: "That teacher code doesn't match the owner of this task." });
      return;
    }

    const updated = {
      ...task,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : task.title,
      questionText: typeof questionText === 'string' ? questionText.slice(0, 4000) : task.questionText,
      videoId: typeof videoId === 'string' ? videoId.slice(0, 64) : (videoId === null ? null : task.videoId),
      pdfBlobUrl: typeof pdfBlobUrl === 'string' ? pdfBlobUrl : task.pdfBlobUrl,
      pdfName: typeof pdfName === 'string' ? pdfName.slice(0, 200) : task.pdfName,
      markersByPage: markersByPage && typeof markersByPage === 'object' ? markersByPage : task.markersByPage,
      pageSystems: pageSystems && typeof pageSystems === 'object' ? pageSystems : task.pageSystems,
      groups: Array.isArray(groups) ? groups : task.groups,
      barCounter: typeof barCounter === 'number' ? barCounter : task.barCounter
    };

    if (byteSize(updated) > MAX_BYTES) {
      res.status(413).json({ error: 'This task\'s tagging/notes data is too large to store (limit ~900KB).' });
      return;
    }

    try {
      await kv.set(taskKey(id), updated);
    } catch (err) {
      console.error('KV write failed:', err);
      res.status(500).json({ error: 'Could not save the task. Please try again.' });
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  res.setHeader('Allow', ['GET', 'PUT']);
  res.status(405).json({ error: `Method ${req.method} not allowed.` });
}
