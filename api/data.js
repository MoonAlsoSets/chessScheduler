// GET /api/data → everything the grid needs, for anyone holding the club code.
//
// Window: the last 8 weeks (so recent nights can still be looked back on)
// through roughly a year ahead (a full season of fixtures).

import { requireRole } from './_lib/auth.js';
import { rpc, ukDate, fail } from './_lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = requireRole(req, res, 'member');
  if (!session) return;

  const from = ukDate(-56);
  try {
    const d = await rpc('chess_get_data', {
      p_from: from,
      p_to: ukDate(400),
      // Admins also see hidden members so they can restore them.
      p_include_inactive: session.role === 'admin',
    });
    return res.status(200).json({ role: session.role, today: ukDate(0), from, ...d });
  } catch (err) {
    return fail(res, err);
  }
}
