// POST /api/task/<id>/submissions — a student submits their Practice Mode
// response + the self-check result already computed by practiceRunSelfCheck
// (index.html) back to the task's class. No new grading logic lives here —
// this only stores what the client already produced.
// GET  /api/task/<id>/submissions?teacherCode=... — teacher-only: lists every
// submission for this task, gated by the teacherCode matching the task's
// owning class (same ownership check as api/task/index.js POST).

import { randomUUID } from 'node:crypto';
import { kv, noKvResponse, ID_RE, MAX_BYTES, byteSize, readJsonBody,
         classKey, taskKey, submissionsKey } from '../../_lib/kv.js';

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }

  const id = req.query && req.query.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    res.status(400).json({ error: 'Invalid or missing task id.' });
    return;
  }

  if (req.method === 'GET') {
    const teacherCode = req.query && req.query.teacherCode;
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
      res.status(500).json({ error: 'Could not load submissions. Please try again.' });
      return;
    }
    if (!classRec || classRec.teacherCode !== teacherCode) {
      res.status(403).json({ error: "That teacher code doesn't match the owner of this task." });
      return;
    }
    let submissions;
    try {
      submissions = (await kv.get(submissionsKey(id))) || [];
    } catch (err) {
      console.error('KV get failed:', err);
      res.status(500).json({ error: 'Could not load submissions. Please try again.' });
      return;
    }
    submissions.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
    res.status(200).json({ submissions });
    return;
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const { displayName, questionText, paragraphs, selfCheckResult } = body;
    let task;
    try {
      task = await kv.get(taskKey(id));
    } catch (err) {
      console.error('KV get failed:', err);
      res.status(500).json({ error: 'Could not submit right now. Please try again.' });
      return;
    }
    if (!task) {
      res.status(404).json({ error: 'This task no longer exists.' });
      return;
    }

    const submission = {
      id: randomUUID(),
      displayName: (typeof displayName === 'string' ? displayName : '').trim().slice(0, 80) || 'Anonymous',
      questionText: typeof questionText === 'string' ? questionText.slice(0, 4000) : '',
      paragraphs: Array.isArray(paragraphs) ? paragraphs.slice(0, 20) : [],
      selfCheckResult: selfCheckResult && typeof selfCheckResult === 'object' ? selfCheckResult : null,
      submittedAt: Date.now()
    };
    if (byteSize(submission) > MAX_BYTES) {
      res.status(413).json({ error: 'This response is too large to submit (limit ~900KB).' });
      return;
    }

    try {
      const existing = (await kv.get(submissionsKey(id))) || [];
      const updated = [...existing, submission];
      if (byteSize(updated) > MAX_BYTES * 20) {
        // A generous ceiling on total submissions per task (dozens of full
        // responses) — protects the store from unbounded growth without
        // getting in the way of a normal class size.
        res.status(413).json({
          error: 'This task has reached its submission storage limit. Ask your teacher to start a new task.'
        });
        return;
      }
      await kv.set(submissionsKey(id), updated);
    } catch (err) {
      console.error('KV write failed:', err);
      res.status(500).json({ error: 'Could not save your submission. Please try again.' });
      return;
    }

    res.status(200).json({ ok: true, id: submission.id, submittedAt: submission.submittedAt });
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: `Method ${req.method} not allowed.` });
}
