// POST /api/status { memberId, date, status, actor }
//   status: 'scheduled' | 'available' | 'undecided' | 'unavailable' | null (clear)
//   actor:  the name the person picked as "who are you" (audit only)
//
// Note: "who are you" is trust-based — the club code proves you're a member,
// not *which* member. The page only offers your own row unless you hold the
// captain or admin code; captains/admins may edit anyone. Past dates are
// locked to captains/admins. The database function checks the date is on the
// schedule and that "scheduled" is only used on match dates.

import { requireRole, ROLE_RANK } from './_lib/auth.js';
import { rpc, isIsoDate, ukDate, fail } from './_lib/db.js';

const STATUSES = new Set(['scheduled', 'available', 'undecided', 'unavailable']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = requireRole(req, res, 'member');
  if (!session) return;

  const { memberId, date, status, actor } = req.body || {};
  const id = Number(memberId);

  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Unknown member.' });
  if (!isIsoDate(date)) return res.status(400).json({ error: 'Bad date.' });
  if (status !== null && !STATUSES.has(status)) return res.status(400).json({ error: 'Bad status.' });

  const elevated = ROLE_RANK[session.role] >= ROLE_RANK.captain;
  if (!elevated && date < ukDate(0)) {
    return res.status(403).json({ error: 'That date has passed — ask a captain to change it.' });
  }

  try {
    const who = typeof actor === 'string' ? actor.slice(0, 60) : '';
    const r = await rpc('chess_set_status', {
      p_member: id,
      p_date: date,
      p_status: status,
      p_by: `${session.role}:${who}`,
      p_allow_inactive: elevated,
    });
    if (r && r.error) return res.status(400).json({ error: r.error });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
}
