// POST /api/task/upload — the server half of Vercel Blob's client-upload
// flow. The teacher's browser uploads the score PDF straight to Blob storage
// (see @vercel/blob/client's uploadPresigned() call in index.html's Teacher
// mode); this endpoint only ever issues a short-lived signed token, the file
// bytes never pass through a serverless function. Deliberately separate from
// api/task/index.js (which stores the small task metadata, including the
// resulting blob URL) — mirrors this app's existing rule that the score PDF
// and the analysis data are always handled on two different paths (see the
// comment at the top of api/project/[id].js).
//
// Uses the *presigned* flow (handleUploadPresigned/issueSignedToken), not
// the older handleUpload/upload() pair — this Vercel project's Blob store
// is connected via OIDC (BLOB_STORE_ID + an auto-rotated VERCEL_OIDC_TOKEN,
// see the store's Connections tab), which handleUpload's token generation
// does not support: it hard-requires the older static BLOB_READ_WRITE_TOKEN,
// which this project was never issued. handleUploadPresigned/issueSignedToken
// work with either OIDC or a static token, so no store reconfiguration is
// needed.

import { issueSignedToken } from '@vercel/blob';
import { handleUploadPresigned } from '@vercel/blob/client';
import { ID_RE } from '../_lib/kv.js';

export default async function handler(request, response) {
  const body = request.body;
  try {
    const jsonResponse = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async (pathname, clientPayload) => {
        let teacherCode = null;
        try { teacherCode = JSON.parse(clientPayload || '{}').teacherCode; } catch { /* ignore */ }
        if (typeof teacherCode !== 'string' || !ID_RE.test(teacherCode)) {
          throw new Error('Missing or invalid teacherCode.');
        }
        return {
          token: await issueSignedToken({
            pathname,
            operations: ['put'],
            allowedContentTypes: ['application/pdf'],
            maximumSizeInBytes: 25 * 1024 * 1024
          }),
          urlOptions: {
            allowedContentTypes: ['application/pdf'],
            addRandomSuffix: true
          }
        };
      }
      // No onUploadCompleted callback: the client already gets the finished
      // blob URL back from uploadPresigned() directly and sends it on to
      // /api/task itself.
    });
    response.status(200).json(jsonResponse);
  } catch (error) {
    // The @vercel/blob/client upload helpers wrap ANY non-2xx response from
    // this endpoint in their own generic error message and do not surface
    // this response body back to the caller — so the real cause only shows
    // up here, in server logs.
    console.error('Blob upload token request failed:', error);
    response.status(400).json({ error: error.message });
  }
}
