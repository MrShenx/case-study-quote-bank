// Shared pieces for the share-link endpoints (api/share/index.js creates a
// link, api/share/[code].js reads, updates and removes one).
//
// A share is a frozen copy of one project's analysis — notes, headings, bar
// tags, video link — stored under a short code. Anyone with the code can READ
// it and make their own copy; only the person who created it can change or
// remove it, by presenting the edit key they were handed at creation. That is
// the difference from the cloud-backup code (api/project/[id].js), where
// holding the code is enough to overwrite it — which is why a backup code
// must never be passed around as a way of sharing.
//
// Never stored here: the score PDF. The recipient adds their own copy and the
// bar tags line up with it, exactly as with a cloud backup.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Same alphabet as class join codes: no 0/O/1/I, so it can be read off a
// whiteboard. Eight characters is ~10^12 codes — far past what the miss
// rate-limit lets anyone walk.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SHARE_CODE_LENGTH = 8;
export const SHARE_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

// A link nobody updates for a year quietly lapses rather than living in the
// database forever; every update starts the year again.
export const SHARE_TTL_SECONDS = 365 * 24 * 60 * 60;

export function shareKey(code) { return `share:${code}`; }

// Accepts "k7m4-qx9p", "K7M4 QX9P", a pasted link — anything with the eight
// characters in it — and returns the bare upper-case code, or null.
export function normalizeShareCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return SHARE_CODE_RE.test(code) ? code : null;
}

export function generateShareCode() {
  let out = '';
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function generateEditKey() { return randomBytes(24).toString('hex'); }
export function hashEditKey(key) { return createHash('sha256').update(String(key)).digest('hex'); }
export function editKeyMatches(given, storedHash) {
  if (typeof given !== 'string' || !given || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashEditKey(given), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Only the fields a project's analysis is made of are kept — whatever else a
// client sends is dropped, so a share can never carry anything unexpected
// into the copies made from it.
export function cleanSharePayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const arr = (v) => Array.isArray(v) ? v : [];
  return {
    name: (typeof p.name === 'string' ? p.name : '').trim().slice(0, 200) || 'Shared notes',
    pdfName: typeof p.pdfName === 'string' ? p.pdfName.slice(0, 300) : null,
    markersByPage: obj(p.markersByPage),
    pageSystems: obj(p.pageSystems),
    notes: arr(p.notes),
    groups: arr(p.groups),
    barCounter: Number.isFinite(p.barCounter) ? p.barCounter : 0,
    videoId: typeof p.videoId === 'string' && /^[\w-]{11}$/.test(p.videoId) ? p.videoId : null
  };
}

// What a reader gets back: never the edit-key hash.
export function publicShare(rec) {
  return { code: rec.code, payload: rec.payload, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
}
