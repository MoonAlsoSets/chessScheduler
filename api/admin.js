// POST /api/admin { action, ... }  — admin code only.
//
//   addMember     { name }
//   updateMember  { id, name?, active? }
//   addFixture    { date, team, opponent, homeAway: 'H'|'A', notes?, competition? }
//   deleteFixture { id }
//   addDate       { date, label? }
//   deleteDate    { id }
//   setCaptain    { team, memberId | null }   (null clears the captain)
//   setTeamIcon   { team, icon | null }       (one of ♚♛♜♝♞♟; null = default)

import { requireRole } from './_lib/auth.js';
import { rpc, isIsoDate, fail } from './_lib/db.js';

const clean = (s, max) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const posInt = (n) => Number.isInteger(Number(n)) && Number(n) > 0;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = requireRole(req, res, 'admin');
  if (!session) return;

  const b = req.body || {};
  const bad = (msg) => res.status(400).json({ error: msg });

  // Validate here; the database function does the write.
  let args;
  switch (b.action) {
    case 'addMember': {
      const name = clean(b.name, 60);
      if (!name) return bad('Please enter a name.');
      args = { name };
      break;
    }
    case 'updateMember': {
      if (!posInt(b.id)) return bad('Unknown member.');
      args = { id: Number(b.id) };
      if (b.name !== undefined) {
        args.name = clean(b.name, 60);
        if (!args.name) return bad('Please enter a name.');
      }
      if (b.active !== undefined) args.active = !!b.active;
      if (Object.keys(args).length < 2) return bad('Nothing to change.');
      break;
    }
    case 'addFixture': {
      const team = clean(b.team, 40);
      const opponent = clean(b.opponent, 60);
      if (!isIsoDate(b.date)) return bad('Please pick a date.');
      if (!team || !opponent) return bad('Please enter the team and opponent.');
      if (b.homeAway !== 'H' && b.homeAway !== 'A') return bad('Home or away?');
      // competition: blank = league fixture; otherwise e.g. "Williamson Cup" (shown with 🏆)
      args = { date: b.date, team, opponent, homeAway: b.homeAway, notes: clean(b.notes, 200), competition: clean(b.competition, 60) };
      break;
    }
    case 'deleteFixture':
    case 'deleteDate':
      if (!posInt(b.id)) return bad('Unknown item.');
      args = { id: Number(b.id) };
      break;
    case 'setCaptain': {
      const team = clean(b.team, 40);
      if (!team) return bad('Which team?');
      if (b.memberId !== null && !posInt(b.memberId)) return bad('Unknown member.');
      args = { team, memberId: b.memberId === null ? null : Number(b.memberId) };
      break;
    }
    case 'setTeamIcon': {
      const team = clean(b.team, 40);
      if (!team) return bad('Which team?');
      if (b.icon !== null && !['♚', '♛', '♜', '♝', '♞', '♟'].includes(b.icon)) return bad('Pick a chess piece.');
      args = { team, icon: b.icon };
      break;
    }
    case 'addDate':
      if (!isIsoDate(b.date)) return bad('Please pick a date.');
      args = { date: b.date, label: clean(b.label, 60) };
      break;
    default:
      return bad('Unknown action.');
  }

  try {
    const r = await rpc('chess_admin', { p_action: b.action, p_args: args });
    if (r && r.error) return bad(r.error);
    return res.status(200).json(r);
  } catch (err) {
    return fail(res, err);
  }
}
