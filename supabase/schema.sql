-- Wymondham Chess Club scheduler — database schema (as applied to Supabase
-- by migration "chess_scheduler_init").
--
-- Security model
-- --------------
-- * Tables are prefixed chess_ so they can share a Supabase project for now and
--   move to a club-owned project later without renaming.
-- * RLS is enabled with NO policies and all grants revoked: the API roles can't
--   touch the tables directly.
-- * The Vercel functions call four SECURITY DEFINER functions with the public
--   publishable key. Each (except chess_ping) requires p_key, whose sha256 is
--   stored in chess_config. So the scheduler never holds a secret/service key,
--   and a leaked CHESS_DB_KEY exposes only the chess_ tables.
--
-- Setting / rotating the key (generate a long random string, e.g.
--   python -c "import secrets;print(secrets.token_urlsafe(32))"):
--   insert into chess_config (id, key_hash)
--   values (1, encode(extensions.digest('<the key>', 'sha256'), 'hex'))
--   on conflict (id) do update set key_hash = excluded.key_hash;
-- then set CHESS_DB_KEY to the same value in Vercel and redeploy.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.chess_members (
  id bigint generated always as identity primary key,
  name text not null check (length(trim(name)) between 1 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.chess_fixtures (
  id bigint generated always as identity primary key,
  match_date date not null,
  team text not null check (length(trim(team)) between 1 and 40),
  opponent text not null check (length(trim(opponent)) between 1 and 60),
  home_away text not null check (home_away in ('H','A')),
  notes text check (notes is null or length(notes) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists chess_fixtures_date_idx on public.chess_fixtures (match_date);
-- Non-Friday dates that get a column (tournaments etc.). Fixture dates get a
-- column automatically.
create table if not exists public.chess_extra_dates (
  id bigint generated always as identity primary key,
  event_date date not null unique,
  label text check (label is null or length(label) <= 60),
  created_at timestamptz not null default now()
);
create table if not exists public.chess_availability (
  member_id bigint not null references public.chess_members(id) on delete cascade,
  event_date date not null,
  status text not null check (status in ('scheduled','available','undecided','unavailable')),
  updated_at timestamptz not null default now(),
  updated_by text,  -- "<role>:<chosen name>" — light audit trail
  primary key (member_id, event_date)
);
create index if not exists chess_availability_date_idx on public.chess_availability (event_date);
create table if not exists public.chess_config (
  id int primary key default 1 check (id = 1),
  key_hash text not null
);

alter table public.chess_members enable row level security;
alter table public.chess_fixtures enable row level security;
alter table public.chess_extra_dates enable row level security;
alter table public.chess_availability enable row level security;
alter table public.chess_config enable row level security;
revoke all on public.chess_members, public.chess_fixtures, public.chess_extra_dates, public.chess_availability, public.chess_config from anon, authenticated;

comment on table public.chess_members is 'Wymondham Chess Club scheduler (scheduler.wymondhamchess.com). Accessed only via chess_* RPC functions.';
comment on table public.chess_config is 'Scheduler: sha256 of the CHESS_DB_KEY the Vercel functions present. Locked; never exposed.';

-- Internal: verify the scheduler key. Not callable by API roles.
create or replace function public.chess_auth(p_key text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_key is null or not exists (
    select 1 from public.chess_config where key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
  ) then
    raise exception 'chess: unauthorised' using errcode = '28000';
  end if;
end $$;

create or replace function public.chess_get_data(p_key text, p_from date, p_to date, p_include_inactive boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.chess_auth(p_key);
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'active', active) order by name)
                         from public.chess_members where active or p_include_inactive), '[]'::jsonb),
    'fixtures', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'match_date', match_date, 'team', team, 'opponent', opponent,
                                                              'home_away', home_away, 'notes', notes) order by match_date, team)
                          from public.chess_fixtures where match_date between p_from and p_to), '[]'::jsonb),
    'extraDates', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'event_date', event_date, 'label', label) order by event_date)
                            from public.chess_extra_dates where event_date between p_from and p_to), '[]'::jsonb),
    'availability', coalesce((select jsonb_agg(jsonb_build_object('member_id', member_id, 'event_date', event_date, 'status', status))
                              from public.chess_availability where event_date between p_from and p_to), '[]'::jsonb)
  );
end $$;

create or replace function public.chess_set_status(p_key text, p_member bigint, p_date date, p_status text, p_by text, p_allow_inactive boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_match boolean; v_extra boolean;
begin
  perform public.chess_auth(p_key);
  if not exists (select 1 from public.chess_members where id = p_member and (active or p_allow_inactive)) then
    return jsonb_build_object('error', 'Unknown member.');
  end if;
  v_match := exists (select 1 from public.chess_fixtures where match_date = p_date);
  v_extra := exists (select 1 from public.chess_extra_dates where event_date = p_date);
  if extract(isodow from p_date) <> 5 and not v_match and not v_extra then
    return jsonb_build_object('error', 'That date isn''t on the schedule.');
  end if;
  if p_status is null then
    delete from public.chess_availability where member_id = p_member and event_date = p_date;
    return jsonb_build_object('ok', true);
  end if;
  if p_status not in ('scheduled','available','undecided','unavailable') then
    return jsonb_build_object('error', 'Bad status.');
  end if;
  if p_status = 'scheduled' and not v_match then
    return jsonb_build_object('error', '"Scheduled to play" is only for match dates.');
  end if;
  insert into public.chess_availability (member_id, event_date, status, updated_at, updated_by)
  values (p_member, p_date, p_status, now(), left(p_by, 80))
  on conflict (member_id, event_date) do update
    set status = excluded.status, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.chess_admin(p_key text, p_action text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb;
begin
  perform public.chess_auth(p_key);
  case p_action
    when 'addMember' then
      insert into public.chess_members (name) values (p_args->>'name')
      returning jsonb_build_object('id', id, 'name', name, 'active', active) into r;
    when 'updateMember' then
      update public.chess_members
         set name = coalesce(p_args->>'name', name),
             active = coalesce((p_args->>'active')::boolean, active)
       where id = (p_args->>'id')::bigint
      returning jsonb_build_object('id', id, 'name', name, 'active', active) into r;
    when 'addFixture' then
      insert into public.chess_fixtures (match_date, team, opponent, home_away, notes)
      values ((p_args->>'date')::date, p_args->>'team', p_args->>'opponent', p_args->>'homeAway', nullif(p_args->>'notes', ''))
      returning jsonb_build_object('id', id, 'match_date', match_date) into r;
    when 'deleteFixture' then
      delete from public.chess_fixtures where id = (p_args->>'id')::bigint;
      r := jsonb_build_object('ok', true);
    when 'addDate' then
      insert into public.chess_extra_dates (event_date, label)
      values ((p_args->>'date')::date, nullif(p_args->>'label', ''))
      on conflict (event_date) do update set label = excluded.label
      returning jsonb_build_object('id', id, 'event_date', event_date) into r;
    when 'deleteDate' then
      delete from public.chess_extra_dates where id = (p_args->>'id')::bigint;
      r := jsonb_build_object('ok', true);
    else
      return jsonb_build_object('error', 'Unknown action.');
  end case;
  return coalesce(r, jsonb_build_object('error', 'Not found.'));
end $$;

-- Keep-alive for the daily Vercel cron; touches nothing sensitive.
create or replace function public.chess_ping() returns boolean
language sql security definer set search_path = public as $$ select true $$;

revoke all on function public.chess_auth(text) from public, anon, authenticated;
revoke all on function public.chess_get_data(text, date, date, boolean) from public, authenticated;
revoke all on function public.chess_set_status(text, bigint, date, text, text, boolean) from public, authenticated;
revoke all on function public.chess_admin(text, text, jsonb) from public, authenticated;
revoke all on function public.chess_ping() from public, authenticated;
grant execute on function public.chess_get_data(text, date, date, boolean) to anon;
grant execute on function public.chess_set_status(text, bigint, date, text, text, boolean) to anon;
grant execute on function public.chess_admin(text, text, jsonb) to anon;
grant execute on function public.chess_ping() to anon;

-- Then set the key — see the header comment.

-- ---------------------------------------------------------------------------
-- Migration "chess_fixture_competition": cup fixtures.
-- competition is null for league matches; otherwise the cup name (e.g.
-- "Williamson Cup"), shown with a 🏆 instead of ♞. The two functions below
-- replace the earlier versions above.
-- ---------------------------------------------------------------------------
alter table public.chess_fixtures add column if not exists competition text
  check (competition is null or length(competition) <= 60);

create or replace function public.chess_get_data(p_key text, p_from date, p_to date, p_include_inactive boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.chess_auth(p_key);
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'active', active) order by name)
                         from public.chess_members where active or p_include_inactive), '[]'::jsonb),
    'fixtures', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'match_date', match_date, 'team', team, 'opponent', opponent,
                                                              'home_away', home_away, 'notes', notes, 'competition', competition) order by match_date, team)
                          from public.chess_fixtures where match_date between p_from and p_to), '[]'::jsonb),
    'extraDates', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'event_date', event_date, 'label', label) order by event_date)
                            from public.chess_extra_dates where event_date between p_from and p_to), '[]'::jsonb),
    'availability', coalesce((select jsonb_agg(jsonb_build_object('member_id', member_id, 'event_date', event_date, 'status', status))
                              from public.chess_availability where event_date between p_from and p_to), '[]'::jsonb)
  );
end $$;

create or replace function public.chess_admin(p_key text, p_action text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb;
begin
  perform public.chess_auth(p_key);
  case p_action
    when 'addMember' then
      insert into public.chess_members (name) values (p_args->>'name')
      returning jsonb_build_object('id', id, 'name', name, 'active', active) into r;
    when 'updateMember' then
      update public.chess_members
         set name = coalesce(p_args->>'name', name),
             active = coalesce((p_args->>'active')::boolean, active)
       where id = (p_args->>'id')::bigint
      returning jsonb_build_object('id', id, 'name', name, 'active', active) into r;
    when 'addFixture' then
      insert into public.chess_fixtures (match_date, team, opponent, home_away, notes, competition)
      values ((p_args->>'date')::date, p_args->>'team', p_args->>'opponent', p_args->>'homeAway',
              nullif(p_args->>'notes', ''), nullif(p_args->>'competition', ''))
      returning jsonb_build_object('id', id, 'match_date', match_date) into r;
    when 'deleteFixture' then
      delete from public.chess_fixtures where id = (p_args->>'id')::bigint;
      r := jsonb_build_object('ok', true);
    when 'addDate' then
      insert into public.chess_extra_dates (event_date, label)
      values ((p_args->>'date')::date, nullif(p_args->>'label', ''))
      on conflict (event_date) do update set label = excluded.label
      returning jsonb_build_object('id', id, 'event_date', event_date) into r;
    when 'deleteDate' then
      delete from public.chess_extra_dates where id = (p_args->>'id')::bigint;
      r := jsonb_build_object('ok', true);
    else
      return jsonb_build_object('error', 'Unknown action.');
  end case;
  return coalesce(r, jsonb_build_object('error', 'Not found.'));
end $$;

revoke all on function public.chess_get_data(text, date, date, boolean) from public, authenticated;
revoke all on function public.chess_admin(text, text, jsonb) from public, authenticated;
grant execute on function public.chess_get_data(text, date, date, boolean) to anon;
grant execute on function public.chess_admin(text, text, jsonb) to anon;

-- ---------------------------------------------------------------------------
-- Migration "chess_team_captains": one captain per team, shown as ♚.
-- Display only — edit rights still come from the captain code. The two
-- functions below are the CURRENT definitions of chess_get_data and
-- chess_admin (they supersede the earlier copies above).
-- ---------------------------------------------------------------------------
create table if not exists public.chess_captains (
  team text primary key check (length(trim(team)) between 1 and 40),
  member_id bigint not null references public.chess_members(id) on delete cascade,
  updated_at timestamptz not null default now()
);
alter table public.chess_captains enable row level security;
revoke all on public.chess_captains from anon, authenticated;

CREATE OR REPLACE FUNCTION public.chess_admin(p_key text, p_action text, p_args jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare r jsonb;
begin
  perform public.chess_auth(p_key);
  case p_action
    when 'addMember' then
      insert into public.chess_members (name) values (p_args->>'name')
      returning jsonb_build_object('id', id, 'name', name, 'active', active) into r;
    when 'updateMember' then
      update public.chess_members
         set name = coalesce(p_args->>'name', name),
             active = coalesce((p_args->>'active')::boolean, active)
       where id = (p_args->>'id')::bigint
      returning jsonb_build_object('id', id, 'name', name, 'active', active) into r;
    when 'addFixture' then
      insert into public.chess_fixtures (match_date, team, opponent, home_away, notes, competition)
      values ((p_args->>'date')::date, p_args->>'team', p_args->>'opponent', p_args->>'homeAway',
              nullif(p_args->>'notes', ''), nullif(p_args->>'competition', ''))
      returning jsonb_build_object('id', id, 'match_date', match_date) into r;
    when 'deleteFixture' then
      delete from public.chess_fixtures where id = (p_args->>'id')::bigint;
      r := jsonb_build_object('ok', true);
    when 'addDate' then
      insert into public.chess_extra_dates (event_date, label)
      values ((p_args->>'date')::date, nullif(p_args->>'label', ''))
      on conflict (event_date) do update set label = excluded.label
      returning jsonb_build_object('id', id, 'event_date', event_date) into r;
    when 'deleteDate' then
      delete from public.chess_extra_dates where id = (p_args->>'id')::bigint;
      r := jsonb_build_object('ok', true);
    when 'setCaptain' then
      if p_args->>'memberId' is null then
        delete from public.chess_captains where team = p_args->>'team';
      else
        if not exists (select 1 from public.chess_members where id = (p_args->>'memberId')::bigint) then
          return jsonb_build_object('error', 'Unknown member.');
        end if;
        insert into public.chess_captains (team, member_id, updated_at)
        values (p_args->>'team', (p_args->>'memberId')::bigint, now())
        on conflict (team) do update set member_id = excluded.member_id, updated_at = excluded.updated_at;
      end if;
      r := jsonb_build_object('ok', true);
    else
      return jsonb_build_object('error', 'Unknown action.');
  end case;
  return coalesce(r, jsonb_build_object('error', 'Not found.'));
end $function$
;

CREATE OR REPLACE FUNCTION public.chess_get_data(p_key text, p_from date, p_to date, p_include_inactive boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  perform public.chess_auth(p_key);
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'active', active) order by name)
                         from public.chess_members where active or p_include_inactive), '[]'::jsonb),
    'fixtures', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'match_date', match_date, 'team', team, 'opponent', opponent,
                                                              'home_away', home_away, 'notes', notes, 'competition', competition) order by match_date, team)
                          from public.chess_fixtures where match_date between p_from and p_to), '[]'::jsonb),
    'extraDates', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'event_date', event_date, 'label', label) order by event_date)
                            from public.chess_extra_dates where event_date between p_from and p_to), '[]'::jsonb),
    'availability', coalesce((select jsonb_agg(jsonb_build_object('member_id', member_id, 'event_date', event_date, 'status', status))
                              from public.chess_availability where event_date between p_from and p_to), '[]'::jsonb),
    'captains', coalesce((select jsonb_agg(jsonb_build_object('team', team, 'member_id', member_id) order by team)
                          from public.chess_captains), '[]'::jsonb),
    'teams', coalesce((select jsonb_agg(t order by t) from (select distinct team t from public.chess_fixtures) x), '[]'::jsonb)
  );
end $function$
;

revoke all on function public.chess_get_data(text, date, date, boolean) from public, authenticated;
revoke all on function public.chess_admin(text, text, jsonb) from public, authenticated;
grant execute on function public.chess_get_data(text, date, date, boolean) to anon;
grant execute on function public.chess_admin(text, text, jsonb) to anon;
