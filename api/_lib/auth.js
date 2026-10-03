// Access-code sessions held in a signed, httpOnly cookie.
//
// Files under api/_lib are not exposed as routes by Vercel (leading underscore).
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   CLUB_CODE       code every member uses
//   CAPTAIN_CODE    unlocks editing anyone's row
//   ADMIN_CODE      captain rights + managing members, fixtures and dates
//   SESSION_SECRET  long random string used to sign the cookie
//
// The signature covers the *current* code for the role, so changing a code in
// Vercel instantly invalidates every cookie issued with the old one.

import crypto from 'node:crypto';

const COOKIE = 'wcs_session';
const MAX_AGE = 60 * 60 * 24 * 365; // one year

export const ROLE_RANK = { member: 1, captain: 2, admin: 3 };

function codeFor(role) {
  return {
    member: process.env.CLUB_CODE,
    captain: process.env.CAPTAIN_CODE,
    admin: process.env.ADMIN_CODE,
  }[role];
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload, role) {
  const secret = process.env.SESSION_SECRET;
  const code = codeFor(role);
  if (!secret || !code) throw new Error('Server is missing SESSION_SECRET or the code for ' + role);
  return b64url(crypto.createHmac('sha256', secret).update(payload + '|' + code).digest());
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Normalise what people type: ignore case, spaces, underscores and hyphens,
// so "Dawn Knight", "dawn_knight" and "dawnknight" all match.
function norm(code) {
  return String(code || '').toLowerCase().replace(/[\s_-]+/g, '');
}

/** Which role (if any) does this typed code unlock? Highest role wins. */
export function roleForCode(typed) {
  const t = norm(typed);
  if (!t) return null;
  for (const role of ['admin', 'captain', 'member']) {
    const c = codeFor(role);
    if (c && safeEqual(t, norm(c))) return role;
  }
  return null;
}

export function issueSession(res, role) {
  const payload = b64url(JSON.stringify({ role, iat: Date.now() }));
  const value = payload + '.' + sign(payload, role);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${value}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Returns { role } for a valid cookie, otherwise null. */
export function getSession(req) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || !ROLE_RANK[data.role]) return null;
  try {
    if (!safeEqual(sig, sign(payload, data.role))) return null;
  } catch {
    return null;
  }
  return { role: data.role };
}

/**
 * Guard for handlers. Sends 401/403 and returns null if the caller lacks the
 * role; otherwise returns the session.
 */
export function requireRole(req, res, minRole) {
  const s = getSession(req);
  if (!s) {
    res.status(401).json({ error: 'Please enter the club code.' });
    return null;
  }
  if (ROLE_RANK[s.role] < ROLE_RANK[minRole]) {
    res.status(403).json({ error: 'That needs the ' + minRole + ' code.' });
    return null;
  }
  return s;
}
