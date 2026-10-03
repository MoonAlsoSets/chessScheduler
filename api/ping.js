// GET /api/ping — called once a day by the Vercel cron in vercel.json so the
// Supabase free-tier project never sits idle long enough to be paused
// (e.g. over the summer break). Returns nothing sensitive.

import { rpc } from './_lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await rpc('chess_ping');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false });
  }
}
