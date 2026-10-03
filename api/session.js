// GET  /api/session                      → { role } or 401
// POST /api/session { action:'login', code } → checks the code, sets the cookie
// POST /api/session { action:'member' }      → drop back from captain/admin to member
// POST /api/session { action:'logout' }      → clears the cookie

import { getSession, roleForCode, issueSession, clearSession, ROLE_RANK } from './_lib/auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const s = getSession(req);
    return s ? res.status(200).json(s) : res.status(401).json({ error: 'No session' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, code } = req.body || {};

  if (action === 'login') {
    if (typeof code !== 'string' || code.length > 100) {
      return res.status(400).json({ error: 'Please enter a code.' });
    }
    const role = roleForCode(code);
    if (!role) {
      await sleep(800); // slow down guessing
      return res.status(401).json({ error: "That code isn't right." });
    }
    // Typing the plain club code while already a captain shouldn't demote you
    // by accident — keep the higher role.
    const current = getSession(req);
    const keep = current && ROLE_RANK[current.role] > ROLE_RANK[role] ? current.role : role;
    issueSession(res, keep);
    return res.status(200).json({ role: keep });
  }

  if (action === 'member') {
    if (!getSession(req)) return res.status(401).json({ error: 'No session' });
    issueSession(res, 'member');
    return res.status(200).json({ role: 'member' });
  }

  if (action === 'logout') {
    clearSession(res);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
