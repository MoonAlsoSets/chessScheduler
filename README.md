# Wymondham Chess Club — Club Scheduler

Availability grid for club nights and league fixtures, intended for
`scheduler.wymondhamchess.com`. Members are listed down the side, dates across
the top (every Friday, plus fixture dates and any extra dates). Each member
marks each date as:

| | On a match date | On a club night |
|---|---|---|
| ♞ | Scheduled to play | — |
| ✓ | Available to play | Coming along |
| ? | Undecided | Undecided |
| ✗ | Not available | Not coming |

Your own row sits at the top. Everyone else is grouped by their answer for the
focused date (scheduled → available → undecided → not available → no answer),
alphabetically within each group. Tap a date header to focus a different date.

## How it fits together

- **Static page:** `index.html`, `style.css`, `app.js`. Plain JS with no build step, styled to match the main club site.
- **Vercel functions** in `api/`. These use plain `fetch` and have no dependencies, like the main site's contact form:
  - `api/session.js`: checks the access code and sets a signed, httpOnly cookie (valid for one year)
  - `api/data.js`: returns members, fixtures, extra dates and availability
  - `api/status.js`: sets or clears one member's status for one date
  - `api/admin.js`: adds and edits members, fixtures and extra dates
  - `api/ping.js`: hit daily by the Vercel cron in `vercel.json` so the Supabase free project never pauses
- **Database:** Supabase, currently `chess_` tables in the personal **electrum-hub** project (see `supabase/schema.sql`). The tables are fully locked. The functions call four `chess_*` Postgres functions using the public publishable key plus a scheduler-only `CHESS_DB_KEY`, so the scheduler **never holds the project's secret key**. A leak would expose the chess tables only, not anything else in electrum-hub. The browser never talks to Supabase.

## Access levels

| Code | Can do |
|---|---|
| Club code | View; edit **your own** row for today onwards |
| Captain code | Edit anyone's row, including past dates |
| Admin code | Captain rights, plus the **Manage** panel (members, fixtures, extra dates) |

Captains and admins enter their code through the "Captain / admin" link at the bottom of the page.

**Changing a code in Vercel signs out everyone who used the old one.**

The "who are you?" choice is on trust. The club code proves someone is a
member, not *which* member. That's fine for a club, but it's worth knowing.

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://eiqexjwnbhewguipnjvj.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | the project's publishable key (`sb_publishable_…`) |
| `CHESS_DB_KEY` | scheduler-only key; its sha256 is stored in `chess_config` (see `schema.sql` to rotate) |
| `CLUB_CODE` | e.g. a few short words; case, spaces, underscores and hyphens are ignored when checking |
| `CAPTAIN_CODE` | |
| `ADMIN_CODE` | |
| `SESSION_SECRET` | a long random string |

All of these are in your local, git-ignored `.env`.

## Setup

1. Database: already applied. For a fresh project, run `supabase/schema.sql` and set the key as described at the top of that file.
2. Import the repo into Vercel (Framework preset: **Other**, no build command). Add the environment variables above.
3. Domain: in Vercel add `scheduler.wymondhamchess.com`. In Cloudflare add a `CNAME scheduler → cname.vercel-dns.com`, set to **DNS only (grey cloud)**.
4. Open the site, enter the admin code, then use **Manage** to add members and fixtures.

## Local development

`vercel dev` runs the page and the functions together. It reads environment variables from **`.env`** (not `.env.local`), which is git-ignored.

## Moving to club ownership later

1. Transfer the GitHub repo to the club account.
2. Create a club-owned Supabase project, run `schema.sql`, set a new key, and copy the four data tables across. `chess_config` stays behind.
3. Update `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `CHESS_DB_KEY` in Vercel. No code changes are needed.
4. Drop the `chess_` tables and functions from electrum-hub.
