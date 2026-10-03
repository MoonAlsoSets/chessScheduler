// Supabase access for the scheduler — plain fetch, no dependencies.
//
// The scheduler never holds a Supabase secret/service key. It calls four
// SECURITY DEFINER functions (chess_get_data, chess_set_status, chess_admin,
// chess_ping) with the public publishable key, and each function (bar ping)
// checks CHESS_DB_KEY against a hash stored in chess_config. So even if these
// environment variables leaked, they'd reach the chess_ tables and nothing
// else in the database.
//
// Environment variables:
//   SUPABASE_URL              https://<project-ref>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  sb_publishable_… (public anyway)
//   CHESS_DB_KEY              scheduler-only key; its sha256 lives in chess_config

/** Call a chess_* Postgres function. Returns its JSON result. */
export async function rpc(fn, args = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !process.env.CHESS_DB_KEY) {
    throw new Error('Server is missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY or CHESS_DB_KEY');
  }
  const body = fn === 'chess_ping' ? {} : { p_key: process.env.CHESS_DB_KEY, ...args };
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase rpc ${fn} failed (${r.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

/** YYYY-MM-DD validator (a real calendar date). */
export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Today's date in UK time as YYYY-MM-DD, offset by `days`. */
export function ukDate(days = 0) {
  const now = new Date(Date.now() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
}

export function fail(res, err) {
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong — please try again shortly.' });
}
