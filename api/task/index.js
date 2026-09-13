// POST /api/task — a teacher adds one task (score PDF + video + question) to
// a class they own. The PDF itself is uploaded straight from the teacher's
// browser to Vercel Blob first (see the client-upload flow wired up in
// index.html's Teacher mode) — this endpoint only ever receives the
// resulting blob URL, never the file bytes, so it stays well under any
// serverless function body-size limit.

import { randomUUID } from 'node:crypto';
import { kv, noKvResponse, ID_RE, MAX_BYTES, byteSize, readJsonBody,
         classKey, taskKey } from '../_lib/kv.js';

export default async function handler(req, res) {
  if (!kv) { noKvResponse(res); return; }
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({ error: `Method ${req.method} not allowed.` });
    return;
  }

  const body = await readJsonBody(req, res);
  if (body === undefined) return;

  const { teacherCode, classId, title, questionText, videoId, pdfBlobUrl, pdfName,
          markersByPage, pageSystems, groups, barCounter } = body;

  if (typeof teacherCode !== 'string' || !ID_RE.test(teacherCode)) {
    res.status(400).json({ error: 'Missing or invalid teacherCode.' });
    return;
  }
  if (typeof classId !== 'string' || !ID_RE.test(classId)) {
    res.status(400).json({ error: 'Missing or invalid classId.' });
    return;
  }
  const cleanTitle = (typeof title === 'string' ? title : '').trim().slice(0, 200);
  if (!cleanTitle) {
    res.status(400).json({ error: 'A task title is required.' });
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
  if (!classRec) {
    res.status(404).json({ error: 'That class no longer exists.' });
    return;
  }
  if (classRec.teacherCode !== teacherCode) {
    res.status(403).json({ error: "That teacher code doesn't match the owner of this class." });
    return;
  }

  const taskId = randomUUID();
  const record = {
    id: taskId,
    classId,
    title: cleanTitle,
    questionText: typeof questionText === 'string' ? questionText.slice(0, 4000) : '',
    videoId: typeof videoId === 'string' ? videoId.slice(0, 64) : null,
    pdfBlobUrl: typeof pdfBlobUrl === 'string' ? pdfBlobUrl : null,
    pdfName: typeof pdfName === 'string' ? pdfName.slice(0, 200) : null,
    // Same shape as a normal project's tagging data (see
    // normalizeProjectRecord in index.html) so a teacher can pre-tag bars
    // with the existing Studio UI and every student opens an already-tagged
    // score — no new tagging logic needed anywhere.
    markersByPage: markersByPage && typeof markersByPage === 'object' ? markersByPage : {},
    pageSystems: pageSystems && typeof pageSystems === 'object' ? pageSystems : {},
    groups: Array.isArray(groups) ? groups : [],
    barCounter: typeof barCounter === 'number' ? barCounter : 0,
    createdAt: Date.now()
  };

  if (byteSize(record) > MAX_BYTES) {
    res.status(413).json({
      error: 'This task\'s tagging/notes data is too large to store (limit ~900KB). ' +
             'The PDF itself is stored separately and never counts toward this limit.'
    });
    return;
  }

  try {
    await kv.set(taskKey(taskId), record);
    const updatedClass = { ...classRec, taskIds: [...(classRec.taskIds || []), taskId] };
    await kv.set(classKey(classId), updatedClass);
  } catch (err) {
    console.error('KV write failed:', err);
    res.status(500).json({ error: 'Could not save the task. Please try again.' });
    return;
  }

  res.status(200).json({ taskId });
}
