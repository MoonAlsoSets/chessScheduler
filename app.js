// Wymondham Chess Club — scheduler front end. Plain JS, no build step.
'use strict';

/* ---------- Constants ---------- */
const STATUS = {
  scheduled:   { glyph: '♞', rank: 0, match: 'Scheduled to play' },
  available:   { glyph: '✓', rank: 1, match: 'Available to play', night: 'Coming along' },
  undecided:   { glyph: '?', rank: 2, match: 'Undecided',         night: 'Undecided' },
  unavailable: { glyph: '✗', rank: 3, match: 'Not available',     night: 'Not coming' },
};
const NO_ANSWER_RANK = 4;
const PIECES = ['♚', '♛', '♜', '♝', '♞', '♟'];
const PIECE_NAMES = { '♚': 'King', '♛': 'Queen', '♜': 'Rook', '♝': 'Bishop', '♞': 'Knight', '♟': 'Pawn' };
const DEFAULT_PIECE = '♞';
const ROLE_RANK = { member: 1, captain: 2, admin: 3 };
const HORIZON_WEEKS = 26;
const REFRESH_MS = 60000;
const ME_KEY = 'wcs-me';

/* ---------- State ---------- */
const S = {
  role: null,
  today: null,
  from: null,
  members: [],
  fixtures: [],
  extraDates: [],
  captains: [],       // [{ team, member_id }]
  teamIcons: {},      // team -> chess piece
  schedTeam: new Map(), // "memberId|date" -> team they're scheduled for
  teams: [],          // every team name used in fixtures
  avail: new Map(),   // "memberId|date" -> status
  me: null,           // member id (number)
  focus: null,        // date string
  showPast: false,
};

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const key = (id, date) => id + '|' + date;
const elevated = () => ROLE_RANK[S.role] >= ROLE_RANK.captain;

// All date maths in UTC on YYYY-MM-DD strings, so local time zones and
// clock changes can never shift a column by a day.
function parseD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function fmtD(dt) { return dt.toISOString().slice(0, 10); }
function addDays(s, n) { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return fmtD(d); }
const isFri = (s) => parseD(s).getUTCDay() === 5;
const fmt = (s, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(parseD(s));

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } }

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

async function api(path, body) {
  const r = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    const err = new Error((data && data.error) || 'Request failed');
    err.status = r.status;
    throw err;
  }
  return data;
}

/* ---------- Data ---------- */
async function load() {
  const d = await api('/api/data');
  S.role = d.role;
  S.today = d.today;
  S.from = d.from;
  S.members = d.members;
  S.fixtures = d.fixtures;
  S.extraDates = d.extraDates;
  S.captains = d.captains || [];
  S.teams = d.teams || [];
  S.avail = new Map(d.availability.map((a) => [key(a.member_id, a.event_date), a.status]));
  S.schedTeam = new Map(d.availability.filter((a) => a.team).map((a) => [key(a.member_id, a.event_date), a.team]));
  S.teamIcons = d.teamIcons || {};

  const stored = Number(lsGet(ME_KEY));
  S.me = activeMembers().some((m) => m.id === stored) ? stored : null;
}

const activeMembers = () => S.members.filter((m) => m.active);
const captainOf = (memberId) => S.captains.filter((c) => c.member_id === memberId).map((c) => c.team);

const teamIcon = (team) => S.teamIcons[team] || DEFAULT_PIECE;
const colTeams = (c) => [...new Set(c.fixtures.map((f) => f.team))];

/** Which team a scheduled player is down for: stored, or the only team playing that day. */
function schedTeamFor(memberId, c) {
  const t = S.schedTeam.get(key(memberId, c.date));
  if (t) return t;
  const teams = colTeams(c);
  return teams.length === 1 ? teams[0] : null;
}

/** Name cell content: the name, plus the team's piece for each team they captain. */
function nameHtml(m) {
  const caps = captainOf(m.id).map((t) =>
    `<span class="cap" title="Captain: ${esc(t)}" aria-label="Captain of ${esc(t)}">${S.teamIcons[t] || '♚'}</span>`).join('');
  return `<div class="nameIn"><span class="nm">${esc(m.name)}</span>${caps}</div>`;
}

/** Every Friday in the window + fixture dates + extra dates. */
function columns() {
  const byDate = new Map();
  const col = (date) => {
    if (!byDate.has(date)) byDate.set(date, { date, fixtures: [], extra: null });
    return byDate.get(date);
  };

  let end = addDays(S.today, HORIZON_WEEKS * 7);
  for (const f of S.fixtures) if (f.match_date > end) end = f.match_date;
  for (const x of S.extraDates) if (x.event_date > end) end = x.event_date;

  // first Friday on/after the window start
  let d = S.from;
  while (parseD(d).getUTCDay() !== 5) d = addDays(d, 1);
  for (; d <= end; d = addDays(d, 7)) col(d);

  for (const f of S.fixtures) col(f.match_date).fixtures.push(f);
  for (const x of S.extraDates) col(x.event_date).extra = x.label || 'Extra date';

  return [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((c) => ({ ...c, past: c.date < S.today, isMatch: c.fixtures.length > 0 }));
}

function canEdit(memberId, col) {
  if (col.past && !elevated()) return false;
  return elevated() || memberId === S.me;
}

/* ---------- Rendering ---------- */
function renderHeader() {
  const me = S.members.find((m) => m.id === S.me);
  $('who').hidden = false;
  $('whoName').textContent = me ? me.name : 'Not picked yet';
  $('changeMe').textContent = me ? 'change' : 'pick';
  const chip = $('roleChip');
  chip.hidden = !elevated();
  chip.textContent = S.role === 'admin' ? 'Admin' : 'Captain';
  $('elevate').hidden = S.role === 'admin';
  $('elevate').textContent = elevated() ? 'Admin code' : 'Captain / admin';
  $('demote').hidden = !elevated();
  $('openAdmin').hidden = S.role !== 'admin';
}

function renderPicker(force = false) {
  const show = force || !S.me;
  $('picker').hidden = !show;
  if (!show) return;
  const sel = $('pickerSelect');
  sel.innerHTML = '<option value="">Choose your name…</option>' +
    activeMembers().map((m) => `<option value="${m.id}"${m.id === S.me ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
}

function colHeadHtml(c, nextDate) {
  const tags = [];
  for (const f of c.fixtures) {
    const icon = f.competition ? '🏆' : teamIcon(f.team);
    const comp = f.competition ? esc(f.competition) + ': ' : '';
    tags.push(`<div class="tag fx${f.competition ? ' cup' : ''}" title="${comp}${esc(f.team)} v ${esc(f.opponent)} (${f.home_away === 'H' ? 'home' : 'away'})${f.notes ? ' — ' + esc(f.notes) : ''}">${icon} ${esc(f.team)} (${f.home_away})<small>v ${esc(f.opponent)}</small></div>`);
  }
  if (c.extra) tags.push(`<div class="tag xt">${esc(c.extra)}</div>`);
  if (!tags.length) tags.push('<div class="tag cn">Club night</div>');
  const cls = ['colHead'];
  if (isFri(c.date)) cls.push('fri');
  if (c.past) cls.push('past');
  if (c.date === S.focus) cls.push('focus');
  if (c.date === nextDate) cls.push('today');
  return `<th class="${cls.join(' ')}" data-date="${c.date}" scope="col" tabindex="0">
    <div class="dow">${fmt(c.date, { weekday: 'short' })}</div>
    <div class="dm">${fmt(c.date, { day: 'numeric', month: 'short' })}</div>
    ${tags.join('')}
  </th>`;
}

function cellHtml(m, c) {
  const st = S.avail.get(key(m.id, c.date));
  const cls = ['cell'];
  if (isFri(c.date)) cls.push('fri');
  if (st) cls.push('s-' + st);
  if (c.past) cls.push('past');
  if (c.date === S.focus) cls.push('focus');
  const sTeam = st === 'scheduled' ? schedTeamFor(m.id, c) : null;
  const glyph = !st ? '' : st === 'scheduled' ? (sTeam ? teamIcon(sTeam) : STATUS.scheduled.glyph) : STATUS[st].glyph;
  const label = !st ? 'No answer'
    : st === 'scheduled' ? `Scheduled to play${sTeam ? ' for ' + esc(sTeam) : ''}`
    : (c.isMatch ? STATUS[st].match : (STATUS[st].night || STATUS[st].match));
  const inner = canEdit(m.id, c)
    ? `<button class="cellBtn" type="button" data-m="${m.id}" data-d="${c.date}" aria-label="${esc(m.name)}, ${fmt(c.date, { day: 'numeric', month: 'short' })}: ${label}">${glyph}</button>`
    : `<span class="cellView" title="${label}">${glyph}</span>`;
  return `<td class="${cls.join(' ')}">${inner}</td>`;
}

function sortedOthers(cols) {
  const rank = (m) => {
    const st = S.avail.get(key(m.id, S.focus));
    return st ? STATUS[st].rank : NO_ANSWER_RANK;
  };
  return activeMembers()
    .filter((m) => m.id !== S.me)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en-GB'));
}

function renderGrid() {
  const all = columns();
  const nextDate = (all.find((c) => !c.past) || {}).date;
  if (!S.focus || !all.some((c) => c.date === S.focus)) S.focus = nextDate;
  const cols = S.showPast ? all : all.filter((c) => !c.past);
  const pastCount = all.filter((c) => c.past).length;

  $('togglePast').textContent = S.showPast ? 'Hide past weeks' : `Show past weeks${pastCount ? ` (${pastCount})` : ''}`;
  $('togglePast').hidden = pastCount === 0;
  $('focusNote').textContent = S.focus ? `Sorted by ${fmt(S.focus, { weekday: 'short', day: 'numeric', month: 'short' })}` : '';

  const me = S.members.find((m) => m.id === S.me && m.active);
  const others = sortedOthers(cols);

  const head = `<thead><tr><th class="name" scope="col">${activeMembers().length} members</th>${cols.map((c) => colHeadHtml(c, nextDate)).join('')}</tr></thead>`;

  const row = (m, cls = '') => `<tr class="${cls}"><th class="name" scope="row" title="${esc(m.name)}${captainOf(m.id).length ? ' — captain: ' + esc(captainOf(m.id).join(', ')) : ''}">${nameHtml(m)}</th>${cols.map((c) => cellHtml(m, c)).join('')}</tr>`;
  let body = '';
  if (me) body += row(me, 'me') + `<tr class="divider"><td colspan="${cols.length + 1}"></td></tr>`;
  body += others.map((m) => row(m)).join('');

  const foot = `<tfoot><tr><td class="name">Totals</td>${cols.map((c) => {
    const n = { scheduled: 0, available: 0, undecided: 0, unavailable: 0 };
    const perTeam = {};
    for (const m of activeMembers()) {
      const st = S.avail.get(key(m.id, c.date));
      if (st) n[st]++;
      if (st === 'scheduled') { const t = schedTeamFor(m.id, c); if (t) perTeam[t] = (perTeam[t] || 0) + 1; }
    }
    const parts = [];
    if (c.isMatch) for (const t of colTeams(c)) parts.push(`<span class="ts" title="${esc(t)}: scheduled to play">${teamIcon(t)}${perTeam[t] || 0}</span>`);
    parts.push(`<span class="ta" title="${c.isMatch ? 'Available' : 'Coming'}">✓${n.available}</span>`);
    if (n.undecided) parts.push(`<span class="tu" title="Undecided">?${n.undecided}</span>`);
    return `<td class="tot${isFri(c.date) ? ' fri' : ''}${c.past ? ' past' : ''}${c.date === S.focus ? ' focus' : ''}">${parts.join(' ')}</td>`;
  }).join('')}</tr></tfoot>`;

  $('grid').innerHTML = head + `<tbody>${body}</tbody>` + foot;

  // Legend: one entry per team, showing its piece.
  const legendTeams = [...new Set([...S.teams, ...Object.keys(S.teamIcons)])].sort((a, b) => a.localeCompare(b, 'en-GB'));
  $('teamLegend').innerHTML = legendTeams.map((t) => `<span class="lt"><span class="g s-scheduled">${teamIcon(t)}</span>${esc(t)}</span>`).join('');
}

function renderAll() {
  renderHeader();
  renderPicker();
  renderGrid();
}

function scrollToFocus() {
  const wrap = $('gridWrap');
  const th = wrap.querySelector(`th.colHead[data-date="${S.focus}"]`);
  const nameW = wrap.querySelector('thead th.name')?.offsetWidth || 0;
  if (th) wrap.scrollLeft = Math.max(0, th.offsetLeft - nameW - 4);
}

/* ---------- Status menu ---------- */
let menuCtx = null;

function openMenu(btn) {
  const memberId = Number(btn.dataset.m);
  const date = btn.dataset.d;
  const col = columns().find((c) => c.date === date);
  const member = S.members.find((m) => m.id === memberId);
  if (!col || !member) return;
  const current = S.avail.get(key(memberId, date));
  const curTeam = current === 'scheduled' ? schedTeamFor(memberId, col) : null;

  // One "scheduled" option per team of ours playing that day.
  const teams = colTeams(col);
  const opts = teams.map((t) => `<button type="button" role="menuitem" data-s="scheduled" data-team="${esc(t)}" class="${current === 'scheduled' && curTeam === t ? 'on' : ''}"><span class="g s-scheduled">${teamIcon(t)}</span>${teams.length > 1 ? 'Playing for ' + esc(t) : 'Scheduled to play (' + esc(t) + ')'}</button>`);
  opts.push(...Object.entries(STATUS)
    .filter(([k]) => k !== 'scheduled')
    .map(([k, v]) => `<button type="button" role="menuitem" data-s="${k}" class="${k === current ? 'on' : ''}"><span class="g s-${k}">${v.glyph}</span>${col.isMatch ? v.match : v.night}</button>`));
  if (current) opts.push('<button type="button" role="menuitem" data-s="" class="clear"><span class="g">–</span>Clear</button>');

  const menu = $('menu');
  const who = member.id === S.me ? '' : esc(member.name) + ' · ';
  menu.innerHTML = `<div class="mHead">${who}${fmt(date, { weekday: 'long', day: 'numeric', month: 'long' })}</div>` + opts.join('');
  menu.hidden = false;

  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';

  menuCtx = { memberId, date, btn };
  menu.querySelector('button')?.focus();
}

function closeMenu() {
  $('menu').hidden = true;
  if (menuCtx?.btn?.isConnected) menuCtx.btn.focus();
  menuCtx = null;
}

async function setStatus(memberId, date, status, team = null) {
  const k = key(memberId, date);
  const before = S.avail.get(k);
  const beforeTeam = S.schedTeam.get(k);
  if (status) S.avail.set(k, status); else S.avail.delete(k);
  if (status === 'scheduled' && team) S.schedTeam.set(k, team); else S.schedTeam.delete(k);
  renderGrid();
  try {
    const me = S.members.find((m) => m.id === S.me);
    await api('/api/status', { memberId, date, status: status || null, team: status === 'scheduled' ? team : null, actor: me ? me.name : '' });
  } catch (err) {
    if (before) S.avail.set(k, before); else S.avail.delete(k);
    if (beforeTeam) S.schedTeam.set(k, beforeTeam); else S.schedTeam.delete(k);
    renderGrid();
    handleError(err);
  }
}

/* ---------- Admin ---------- */
function renderAdmin() {
  const teams = [...new Set(S.fixtures.map((f) => f.team))].sort();
  $('teamList').innerHTML = teams.map((t) => `<option value="${esc(t)}">`).join('');
  const comps = [...new Set(S.fixtures.map((f) => f.competition).filter(Boolean))].sort();
  $('compList').innerHTML = comps.map((c) => `<option value="${esc(c)}">`).join('');

  const upcoming = S.fixtures.filter((f) => f.match_date >= S.today);
  $('fxList').innerHTML = upcoming.length ? upcoming.map((f) => `<li>
      <span class="grow"><strong>${fmt(f.match_date, { weekday: 'short', day: 'numeric', month: 'short' })}</strong> — ${f.competition ? '🏆 ' + esc(f.competition) + ': ' : ''}${esc(f.team)} v ${esc(f.opponent)} (${f.home_away})${f.notes ? ' · ' + esc(f.notes) : ''}</span>
      <button class="btn ghost" type="button" data-del-fx="${f.id}">Remove</button></li>`).join('')
    : '<li class="hint">No upcoming fixtures yet.</li>';

  const dates = S.extraDates.filter((x) => x.event_date >= S.today);
  $('dtList').innerHTML = dates.length ? dates.map((x) => `<li>
      <span class="grow"><strong>${fmt(x.event_date, { weekday: 'short', day: 'numeric', month: 'short' })}</strong>${x.label ? ' — ' + esc(x.label) : ''}</span>
      <button class="btn ghost" type="button" data-del-dt="${x.id}">Remove</button></li>`).join('')
    : '<li class="hint">No extra dates.</li>';

  const capTeams = [...new Set([...S.teams, ...S.captains.map((c) => c.team)])].sort((a, b) => a.localeCompare(b, 'en-GB'));
  const opts = (sel) => '<option value="">— none —</option>' + activeMembers()
    .map((m) => `<option value="${m.id}"${m.id === sel ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  const pieceOpts = (team) => {
    const cur = S.teamIcons[team] || '';
    const usedBy = (p) => Object.entries(S.teamIcons).filter(([t, i]) => i === p && t !== team).map(([t]) => t);
    return `<option value=""${cur ? '' : ' selected'}>${DEFAULT_PIECE} (default)</option>` + PIECES.map((p) => {
      const u = usedBy(p);
      return `<option value="${p}"${p === cur ? ' selected' : ''}>${p} ${PIECE_NAMES[p]}${u.length ? ' (' + esc(u.join(', ')) + ')' : ''}</option>`;
    }).join('');
  };
  $('capList').innerHTML = capTeams.length ? capTeams.map((t) => {
    const cur = S.captains.find((c) => c.team === t);
    return `<li><span class="grow"><strong>${esc(t)}</strong></span>
      <select class="piece" data-icon-team="${esc(t)}" aria-label="Piece for ${esc(t)}">${pieceOpts(t)}</select>
      <select data-cap-team="${esc(t)}" aria-label="Captain of ${esc(t)}">${opts(cur ? cur.member_id : null)}</select></li>`;
  }).join('') : '<li class="hint">Add fixtures first — teams come from the fixture list.</li>';

  const members = [...S.members].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'en-GB'));
  $('mbList').innerHTML = members.length ? members.map((m) => `<li class="${m.active ? '' : 'off'}">
      <input value="${esc(m.name)}" data-name-for="${m.id}" aria-label="Name">
      <button class="btn ghost" type="button" data-rename="${m.id}">Save</button>
      <button class="btn ghost" type="button" data-toggle="${m.id}">${m.active ? 'Hide' : 'Restore'}</button></li>`).join('')
    : '<li class="hint">No members yet — add the first one above.</li>';
}

async function adminDo(body) {
  $('adminError').textContent = '';
  try {
    await api('/api/admin', body);
    await load();
    renderAll();
    renderAdmin();
    return true;
  } catch (err) {
    if (err.status === 401 || err.status === 403) return handleError(err);
    $('adminError').textContent = err.message;
    return false;
  }
}

/* ---------- Errors / session ---------- */
function handleError(err) {
  if (err.status === 401) {
    showGate("Please enter the club code again — it may have changed.");
    return false;
  }
  if (err.status === 403) {
    toast(err.message);
    refresh();
    return false;
  }
  toast(err.message || 'Something went wrong.');
  return false;
}

function showGate(msg = '') {
  $('app').hidden = true;
  $('who').hidden = true;
  $('gate').hidden = false;
  $('gateError').textContent = msg;
  $('gateCode').focus();
}

async function enterApp() {
  await load();
  $('gate').hidden = true;
  $('app').hidden = false;
  renderAll();
  scrollToFocus();
}

async function refresh() {
  try {
    await load();
    renderAll();
  } catch (err) {
    handleError(err);
  }
}

/* ---------- Wiring ---------- */
function wire() {
  $('gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('gateError').textContent = '';
    try {
      await api('/api/session', { action: 'login', code: $('gateCode').value });
      $('gateCode').value = '';
      await enterApp();
    } catch (err) {
      $('gateError').textContent = err.message;
    }
  });

  $('pickerSave').addEventListener('click', () => {
    const id = Number($('pickerSelect').value);
    if (!id) return;
    S.me = id;
    lsSet(ME_KEY, String(id));
    renderAll();
  });
  $('changeMe').addEventListener('click', () => {
    renderPicker(true);
    $('pickerSelect').focus();
  });

  $('togglePast').addEventListener('click', () => {
    S.showPast = !S.showPast;
    renderGrid();
    if (!S.showPast) scrollToFocus();
  });
  $('refresh').addEventListener('click', () => refresh().then(() => toast('Up to date')));

  // Column header → focus/sort; cell → status menu
  $('grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.cellBtn');
    if (btn) { e.stopPropagation(); openMenu(btn); return; }
    const th = e.target.closest('th.colHead');
    if (th) { S.focus = th.dataset.date; renderGrid(); }
  });
  $('grid').addEventListener('keydown', (e) => {
    const th = e.target.closest('th.colHead');
    if (th && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      S.focus = th.dataset.date;
      renderGrid();
      $('grid').querySelector(`th.colHead[data-date="${S.focus}"]`)?.focus();
    }
  });

  $('menu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b || !menuCtx) return;
    const { memberId, date } = menuCtx;
    closeMenu();
    setStatus(memberId, date, b.dataset.s || null, b.dataset.team || null);
  });
  document.addEventListener('click', (e) => {
    if (menuCtx && !e.target.closest('#menu')) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuCtx) closeMenu(); });
  $('gridWrap').addEventListener('scroll', () => { if (menuCtx) closeMenu(); }, { passive: true });
  window.addEventListener('resize', () => { if (menuCtx) closeMenu(); });

  // Captain / admin
  $('elevate').addEventListener('click', () => {
    $('elevateError').textContent = '';
    $('elevateCode').value = '';
    $('elevateDlg').showModal();
  });
  $('elevateCancel').addEventListener('click', () => $('elevateDlg').close());
  $('elevateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/session', { action: 'login', code: $('elevateCode').value });
      if (!ROLE_RANK[r.role] || ROLE_RANK[r.role] < ROLE_RANK.captain) {
        $('elevateError').textContent = "That's the club code — you need the captain or admin code.";
        return;
      }
      $('elevateDlg').close();
      await refresh();
      toast(r.role === 'admin' ? 'Admin mode on' : 'Captain mode on — you can edit anyone');
    } catch (err) {
      $('elevateError').textContent = err.message;
    }
  });
  $('demote').addEventListener('click', async () => {
    try {
      await api('/api/session', { action: 'member' });
      await refresh();
      toast('Back to member view');
    } catch (err) { handleError(err); }
  });

  // Admin dialog
  $('openAdmin').addEventListener('click', () => {
    $('adminError').textContent = '';
    renderAdmin();
    $('adminDlg').showModal();
  });
  $('adminClose').addEventListener('click', () => $('adminDlg').close());

  $('fxForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await adminDo({
      action: 'addFixture',
      date: $('fxDate').value,
      team: $('fxTeam').value,
      opponent: $('fxOpp').value,
      homeAway: $('fxHA').value,
      notes: $('fxNotes').value,
      competition: $('fxComp').value,
    });
    if (ok) { $('fxOpp').value = ''; $('fxNotes').value = ''; }
  });
  $('dtForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await adminDo({ action: 'addDate', date: $('dtDate').value, label: $('dtLabel').value })) {
      $('dtDate').value = ''; $('dtLabel').value = '';
    }
  });
  $('mbForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await adminDo({ action: 'addMember', name: $('mbName').value })) {
      $('mbName').value = '';
      $('mbName').focus();
    }
  });
  $('adminDlg').addEventListener('change', (e) => {
    const icon = e.target.closest('select[data-icon-team]');
    if (icon) return adminDo({ action: 'setTeamIcon', team: icon.dataset.iconTeam, icon: icon.value || null });
    const sel = e.target.closest('select[data-cap-team]');
    if (!sel) return;
    adminDo({ action: 'setCaptain', team: sel.dataset.capTeam, memberId: sel.value ? Number(sel.value) : null });
  });
  $('adminDlg').addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.delFx) adminDo({ action: 'deleteFixture', id: Number(t.dataset.delFx) });
    else if (t.dataset.delDt) adminDo({ action: 'deleteDate', id: Number(t.dataset.delDt) });
    else if (t.dataset.rename) {
      const input = $('mbList').querySelector(`input[data-name-for="${t.dataset.rename}"]`);
      adminDo({ action: 'updateMember', id: Number(t.dataset.rename), name: input.value });
    } else if (t.dataset.toggle) {
      const m = S.members.find((x) => x.id === Number(t.dataset.toggle));
      if (m) adminDo({ action: 'updateMember', id: m.id, active: !m.active });
    }
  });

  // Gentle background refresh while the tab is visible and nobody is mid-edit
  setInterval(() => {
    if (document.visibilityState !== 'visible' || $('app').hidden) return;
    if (menuCtx || $('adminDlg').open || $('elevateDlg').open) return;
    refresh();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('app').hidden && !menuCtx) refresh();
  });
}

/* ---------- Boot ---------- */
(async function init() {
  wire();
  try {
    await enterApp();
  } catch (err) {
    if (err.status === 401) showGate();
    else showGate('Could not load the schedule — please try again shortly.');
  }
})();
