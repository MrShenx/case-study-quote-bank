// POST /api/task/upload — the server half of Vercel Blob's client-upload
// flow. The teacher's browser uploads the score PDF straight to Blob storage
// (see @vercel/blob/client's upload() call in index.html's Teacher mode);
// this endpoint only ever issues a short-lived upload token, the file bytes
// never pass through a serverless function. Deliberately separate from
// api/task/index.js (which stores the small task metadata, including the
// resulting blob URL) — mirrors this app's existing rule that the score PDF
// and the analysis data are always handled on two different paths (see the
// comment at the top of api/project/[id].js).

import { handleUpload } from '@vercel/blob/client';
import { ID_RE } from '../_lib/kv.js';

export default async function handler(request, response) {
  const body = request.body;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let teacherCode = null;
        try { teacherCode = JSON.parse(clientPayload || '{}').teacherCode; } catch { /* ignore */ }
        if (typeof teacherCode !== 'string' || !ID_RE.test(teacherCode)) {
          throw new Error('Missing or invalid teacherCode.');
        }
        return {
          allowedContentTypes: ['application/pdf'],
          maximumSizeInBytes: 25 * 1024 * 1024,
          addRandomSuffix: true
        };
      }
      // No onUploadCompleted webhook: it only fires for a publicly reachable
      // deployment, and the client already gets the finished blob URL back
      // from upload() directly and sends it on to /api/task itself.
    });
    response.status(200).json(jsonResponse);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
