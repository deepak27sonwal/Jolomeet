-- =============================================================================
-- JoloMeet — initial database schema
--
-- Covers: profiles & privacy, interests, presence, settings, blocks,
-- connections, conversations & messages, random matchmaking, call sessions,
-- reports, rate limiting, storage buckets and Realtime authorization.
--
-- Conventions
--   * public.*   tables + RPCs exposed through the Supabase Data API
--   * private.*  helper / trigger functions (NOT exposed through the API)
--   * Every table has Row Level Security enabled.
--   * Writes that need cross-row guarantees (matchmaking, starting chats,
--     calls) only happen through SECURITY DEFINER RPCs, never direct inserts.
--   * Custom error codes (SQLSTATE) returned to the frontend:
--       JM400 invalid input      JM401 not authenticated   JM403 forbidden
--       JM404 not found          JM409 conflict / busy     JM429 rate limited
-- =============================================================================

create schema if not exists private;
grant usage on schema private to authenticated;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.profile_visibility as enum ('public', 'connections', 'private');
create type public.contact_permission as enum ('everyone', 'connections', 'nobody');
create type public.chat_mode          as enum ('text', 'video');
create type public.connection_status  as enum ('pending', 'accepted', 'declined');
create type public.conversation_kind  as enum ('direct', 'random');
create type public.participant_status as enum ('active', 'request', 'left');
create type public.message_kind       as enum ('text', 'image', 'system');
create type public.session_source     as enum ('random', 'direct');
create type public.session_status     as enum ('ringing', 'active', 'ended');
create type public.report_context     as enum ('profile', 'message', 'text_chat', 'video_call');
create type public.report_reason      as enum ('spam', 'harassment', 'hate', 'nudity', 'violence',
                                               'underage', 'scam', 'impersonation', 'other');
create type public.report_status      as enum ('open', 'reviewing', 'actioned', 'dismissed');
create type public.app_role           as enum ('user', 'moderator', 'admin');

-- -----------------------------------------------------------------------------
-- Utility functions
-- -----------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function private.try_uuid(p_value text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return p_value::uuid;
exception when others then
  return null;
end $$;

-- =============================================================================
-- Tables
-- =============================================================================

-- Interest catalogue ("What's your vibe?") -----------------------------------
create table public.interests (
  slug        text primary key check (slug ~ '^[a-z0-9-]{2,30}$'),
  label       text not null check (char_length(label) between 1 and 40),
  sort_order  smallint not null default 100,
  is_featured boolean not null default false,   -- shown as a chip before "More"
  is_active   boolean not null default true
);

-- Public profile (one row per auth user) -------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  username            text unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name        text not null check (char_length(btrim(display_name)) between 1 and 40),
  bio                 text check (char_length(bio) <= 300),
  avatar_path         text check (avatar_path is null or avatar_path like id::text || '/%'),
  cover_path          text check (cover_path is null or cover_path like id::text || '/%'),
  languages           text[] not null default '{}'
                      check (cardinality(languages) <= 5
                             and array_to_string(languages, ',') ~ '^([a-z]{2,3}(,[a-z]{2,3})*)?$'),
  show_age            boolean not null default false,
  visibility          public.profile_visibility not null default 'public',
  show_online_status  boolean not null default true,
  allow_messages_from public.contact_permission not null default 'everyone',
  allow_video_from    public.contact_permission not null default 'connections',
  is_guest            boolean not null default false,   -- Supabase anonymous sign-in
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index profiles_display_name_idx on public.profiles (lower(display_name));

-- Private account data: never readable by other users ------------------------
create table public.user_private (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  birth_date        date,
  age_confirmed_at  timestamptz,
  terms_accepted_at timestamptz,
  role              public.app_role not null default 'user',
  banned_until      timestamptz,
  ban_reason        text,
  created_at        timestamptz not null default now()
);

-- Per-user preferences (chat, notifications, video) --------------------------
create table public.user_settings (
  user_id                    uuid primary key references auth.users (id) on delete cascade,
  notify_messages            boolean not null default true,
  notify_connection_requests boolean not null default true,
  notify_matches             boolean not null default true,
  sound_enabled              boolean not null default true,
  enter_to_send              boolean not null default true,
  show_read_receipts         boolean not null default true,
  show_typing_indicator      boolean not null default true,
  video_quality              text not null default 'auto'
                             check (video_quality in ('auto', 'low', 'medium', 'high')),
  mirror_self_view           boolean not null default true,
  updated_at                 timestamptz not null default now()
);

-- Last-seen timestamp (live presence itself uses Realtime Presence) ----------
create table public.user_presence (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
create index user_presence_last_seen_idx on public.user_presence (last_seen_at desc);

-- User ↔ interest ------------------------------------------------------------
create table public.user_interests (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  interest_slug text not null references public.interests (slug) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (user_id, interest_slug)
);
create index user_interests_slug_idx on public.user_interests (interest_slug);

-- Blocks ---------------------------------------------------------------------
create table public.blocks (
  blocker_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks (blocked_id);

-- Connections (friend requests) ----------------------------------------------
create table public.connections (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       public.connection_status not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);
create unique index connections_pair_uidx
  on public.connections (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index connections_addressee_idx on public.connections (addressee_id, status);
create index connections_requester_idx on public.connections (requester_id, status);

-- Conversations --------------------------------------------------------------
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  kind            public.conversation_kind not null,
  direct_key      text unique,  -- "<smaller uuid>:<larger uuid>" for direct chats
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  check ((kind = 'direct') = (direct_key is not null))
);

create table public.conversation_participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  status          public.participant_status not null default 'active',
  is_favorite     boolean not null default false,
  is_muted        boolean not null default false,
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz,
  primary key (conversation_id, user_id)
);
create index conversation_participants_user_idx on public.conversation_participants (user_id, status);

-- Messages -------------------------------------------------------------------
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid default auth.uid() references public.profiles (id) on delete set null,
  client_id       uuid not null,  -- generated by the browser; makes "retry" idempotent
  kind            public.message_kind not null default 'text',
  body            text check (char_length(body) <= 2000),
  attachment_path text,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (sender_id, client_id),
  check (
    deleted_at is not null
    or (kind in ('text', 'system') and char_length(btrim(body)) > 0 and attachment_path is null)
    or (kind = 'image' and attachment_path is not null)
  )
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at desc);

-- Matchmaking queue (one row per waiting user) -------------------------------
create table public.match_queue (
  user_id           uuid primary key references public.profiles (id) on delete cascade,
  mode              public.chat_mode not null,
  interests         text[] not null default '{}',
  languages         text[] not null default '{}',
  enqueued_at       timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now()
);
create index match_queue_mode_idx on public.match_queue (mode, enqueued_at);

-- Random matches and direct calls --------------------------------------------
create table public.match_sessions (
  id              uuid primary key default gen_random_uuid(),
  source          public.session_source not null,
  mode            public.chat_mode not null,
  status          public.session_status not null,
  conversation_id uuid references public.conversations (id) on delete set null,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  ended_at        timestamptz,
  ended_by        uuid references public.profiles (id) on delete set null,
  end_reason      text check (end_reason in ('ended', 'next', 'disconnected', 'declined',
                                             'timeout', 'blocked', 'reported'))
);
create index match_sessions_conversation_idx on public.match_sessions (conversation_id);
create index match_sessions_open_idx on public.match_sessions (status) where status <> 'ended';

create table public.match_session_participants (
  session_id   uuid not null references public.match_sessions (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  is_initiator boolean not null default false,  -- the initiator sends the WebRTC offer
  joined_at    timestamptz not null default now(),
  left_at      timestamptz,
  primary key (session_id, user_id)
);
-- A user can be in at most ONE open (ringing/active) session at a time.
create unique index match_session_participants_one_open_uidx
  on public.match_session_participants (user_id) where left_at is null;

-- Reports --------------------------------------------------------------------
create table public.reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_id      uuid default auth.uid() references public.profiles (id) on delete set null,
  reported_user_id uuid not null references public.profiles (id) on delete cascade,
  context          public.report_context not null,
  reason           public.report_reason not null,
  details          text check (char_length(details) <= 1000),
  message_id       uuid references public.messages (id) on delete set null,
  conversation_id  uuid references public.conversations (id) on delete set null,
  session_id       uuid references public.match_sessions (id) on delete set null,
  evidence         jsonb,   -- snapshot taken server-side when the report is filed
  status           public.report_status not null default 'open',
  moderator_notes  text,
  resolved_by      uuid references public.profiles (id) on delete set null,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index reports_status_idx   on public.reports (status, created_at);
create index reports_reported_idx on public.reports (reported_user_id);

-- Rate limiting log (internal, no client access) -----------------------------
create table public.rate_limit_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  action     text not null,
  created_at timestamptz not null default now()
);
create index rate_limit_events_lookup_idx on public.rate_limit_events (user_id, action, created_at desc);

-- =============================================================================
-- Private helper functions (used by RLS policies, triggers and RPCs)
-- =============================================================================

create function private.is_banned(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_private
    where user_id = p_user and banned_until is not null and banned_until > now()
  );
$$;

create function private.is_guest(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select is_guest from public.profiles where id = p_user), true);
$$;

create function private.is_adult(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_private
    where user_id = p_user
      and birth_date is not null
      and birth_date <= (current_date - interval '18 years')::date
  );
$$;

create function private.age_of(p_user uuid)
returns int language sql stable security definer set search_path = '' as $$
  select extract(year from age(current_date, birth_date))::int
  from public.user_private where user_id = p_user;
$$;

create function private.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_private
    where user_id = auth.uid() and role in ('moderator', 'admin')
  );
$$;

create function private.is_blocked_between(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a)
  );
$$;

create function private.are_connected(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.connections
    where status = 'accepted'
      and least(requester_id, addressee_id) = least(p_a, p_b)
      and greatest(requester_id, addressee_id) = greatest(p_a, p_b)
  );
$$;

create function private.shares_conversation(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.conversation_participants x
    join public.conversation_participants y on y.conversation_id = x.conversation_id
    where x.user_id = p_a and y.user_id = p_b
  ) or exists (
    select 1
    from public.match_session_participants x
    join public.match_session_participants y on y.session_id = x.session_id
    where x.user_id = p_a and y.user_id = p_b
  );
$$;

-- Can p_viewer see p_target's profile at all?
create function private.can_view_profile(p_viewer uuid, p_target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_viewer is not null and (
    p_viewer = p_target
    or (
      not private.is_blocked_between(p_viewer, p_target)
      and not private.is_banned(p_target)
      and exists (
        select 1 from public.profiles pr
        where pr.id = p_target and (
          pr.visibility = 'public'
          or (pr.visibility = 'connections' and private.are_connected(p_viewer, p_target))
          or private.shares_conversation(p_viewer, p_target)
        )
      )
    )
  );
$$;

create function private.can_see_presence(p_viewer uuid, p_target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_viewer = p_target or (
    private.can_view_profile(p_viewer, p_target)
    and coalesce((select show_online_status from public.profiles where id = p_target), false)
  );
$$;

-- Does p_target's contact permission allow p_viewer?
create function private.permission_allows(p_permission public.contact_permission, p_viewer uuid, p_target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_permission
    when 'everyone'    then true
    when 'connections' then private.are_connected(p_viewer, p_target)
    else false
  end;
$$;

create function private.is_conversation_member(p_conversation uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.conversation_participants
    where conversation_id = p_conversation and user_id = p_user and status in ('active', 'request')
  );
$$;

create function private.is_session_participant(p_session uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.match_session_participants
    where session_id = p_session and user_id = p_user
  );
$$;

-- Server-side rule for "may the current user post into this conversation?"
create function private.can_send_message(p_conversation uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select
    auth.uid() is not null
    and not private.is_banned(auth.uid())
    -- caller is an active participant (a pending request must be accepted first)
    and exists (
      select 1 from public.conversation_participants
      where conversation_id = p_conversation and user_id = auth.uid() and status = 'active'
    )
    -- nobody in the conversation has blocked / been blocked by the caller
    and not exists (
      select 1 from public.conversation_participants o
      where o.conversation_id = p_conversation and o.user_id <> auth.uid()
        and private.is_blocked_between(auth.uid(), o.user_id)
    )
    -- message requests: at most 3 messages until the recipient accepts
    and (
      not exists (
        select 1 from public.conversation_participants o
        where o.conversation_id = p_conversation and o.user_id <> auth.uid() and o.status = 'request'
      )
      or (select count(*) from public.messages
          where conversation_id = p_conversation and sender_id = auth.uid()) < 3
    )
    -- random chats only accept messages while their match session is live
    and (
      (select kind from public.conversations where id = p_conversation) = 'direct'
      or exists (
        select 1 from public.match_sessions
        where conversation_id = p_conversation and status = 'active'
      )
    );
$$;

-- Simple sliding-window rate limiter. Raises JM429 when exceeded.
create function private.enforce_rate_limit(p_action text, p_max int, p_window interval)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = 'JM401';
  end if;
  select count(*) into v_count
  from public.rate_limit_events
  where user_id = v_uid and action = p_action and created_at > now() - p_window;
  if v_count >= p_max then
    raise exception 'Too many requests, please slow down' using errcode = 'JM429', detail = p_action;
  end if;
  insert into public.rate_limit_events (user_id, action) values (v_uid, p_action);
end $$;

-- Realtime channel authorization. Topics:
--   match:<session_id>         WebRTC signaling (offer/answer/ICE) + in-call events
--   conversation:<id>          typing indicators
--   user:<user_id>             personal notifications
create function private.can_access_realtime_topic(p_topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_kind text := split_part(p_topic, ':', 1);
  v_id   uuid := private.try_uuid(split_part(p_topic, ':', 2));
begin
  if auth.uid() is null or v_id is null then
    return false;
  end if;
  if v_kind = 'match' then
    return exists (
      select 1 from public.match_session_participants
      where session_id = v_id and user_id = auth.uid() and left_at is null
    );
  elsif v_kind = 'conversation' then
    return private.is_conversation_member(v_id, auth.uid());
  elsif v_kind = 'user' then
    return v_id = auth.uid();
  end if;
  return false;
end $$;

-- Ends ringing calls that were never answered and sessions whose participants
-- stopped sending heartbeats (closed tab, lost network).
create function private.expire_stale_sessions(p_user uuid)
returns void language sql security definer set search_path = '' as $$
  update public.match_sessions s
  set status = 'ended',
      ended_at = now(),
      end_reason = case when s.status = 'ringing' then 'timeout' else 'disconnected' end
  where s.status <> 'ended'
    and exists (
      select 1 from public.match_session_participants sp
      where sp.session_id = s.id and sp.user_id = p_user and sp.left_at is null
    )
    and (
      (s.status = 'ringing' and s.created_at < now() - interval '45 seconds')
      or (s.status = 'active' and exists (
            select 1
            from public.match_session_participants sp
            join public.user_presence up on up.user_id = sp.user_id
            where sp.session_id = s.id and up.last_seen_at < now() - interval '90 seconds'))
    );
$$;

-- =============================================================================
-- Triggers
-- =============================================================================

-- New auth user → profile, private data, settings, presence.
create function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_meta  jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_guest boolean := coalesce(new.is_anonymous, false);
  v_name  text := nullif(btrim(v_meta ->> 'display_name'), '');
  v_birth date;
begin
  begin
    v_birth := (v_meta ->> 'birth_date')::date;
  exception when others then
    v_birth := null;
  end;
  if v_birth is not null and v_birth > (current_date - interval '18 years')::date then
    raise exception 'You must be 18 or older to use JoloMeet' using errcode = 'JM403';
  end if;

  -- guests are hidden from discovery; matched partners can still see them
  insert into public.profiles (id, display_name, is_guest, visibility)
  values (
    new.id,
    left(coalesce(v_name, case when v_guest then 'Guest-' else 'User-' end
                          || left(replace(new.id::text, '-', ''), 6)), 40),
    v_guest,
    case when v_guest then 'private' else 'public' end::public.profile_visibility
  );
  insert into public.user_private (user_id, birth_date, age_confirmed_at, terms_accepted_at)
  values (
    new.id,
    v_birth,
    case when v_birth is not null then now() end,
    case when v_meta ->> 'accepted_terms' = 'true' then now() end
  );
  insert into public.user_settings (user_id) values (new.id);
  insert into public.user_presence (user_id) values (new.id);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Guest upgraded to a full account (anonymous user linked an email).
create function private.handle_user_updated()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set is_guest = coalesce(new.is_anonymous, false) where id = new.id;
  return new;
end $$;

create trigger on_auth_user_updated
  after update of is_anonymous on auth.users
  for each row when (old.is_anonymous is distinct from new.is_anonymous)
  execute function private.handle_user_updated();

create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger user_settings_updated_at before update on public.user_settings
  for each row execute function private.set_updated_at();

-- Max 10 interests per user.
create function private.limit_user_interests()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.user_interests where user_id = new.user_id) >= 10 then
    raise exception 'You can select up to 10 interests' using errcode = 'JM400';
  end if;
  return new;
end $$;

create trigger user_interests_limit before insert on public.user_interests
  for each row execute function private.limit_user_interests();

-- Blocking: rate limit, then remove the connection and end shared live sessions.
create function private.before_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.enforce_rate_limit('block', 60, interval '1 hour');
  return new;
end $$;

create function private.after_block()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.connections
  where least(requester_id, addressee_id) = least(new.blocker_id, new.blocked_id)
    and greatest(requester_id, addressee_id) = greatest(new.blocker_id, new.blocked_id);

  update public.match_sessions s
  set status = 'ended', ended_at = now(), ended_by = new.blocker_id, end_reason = 'blocked'
  where s.status <> 'ended'
    and exists (select 1 from public.match_session_participants
                where session_id = s.id and user_id = new.blocker_id and left_at is null)
    and exists (select 1 from public.match_session_participants
                where session_id = s.id and user_id = new.blocked_id and left_at is null);
  return new;
end $$;

create trigger blocks_before_insert before insert on public.blocks
  for each row execute function private.before_block();
create trigger blocks_after_insert after insert on public.blocks
  for each row execute function private.after_block();

-- Connections: rate limit requests; only the addressee may respond.
create function private.before_connection_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.enforce_rate_limit('connection_request', 30, interval '1 hour');
  new.status := 'pending';
  new.created_at := now();
  new.responded_at := null;
  return new;
end $$;

create function private.before_connection_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'pending' then
    raise exception 'This request has already been answered' using errcode = 'JM409';
  end if;
  if new.status = 'pending' then
    raise exception 'Invalid status' using errcode = 'JM400';
  end if;
  new.responded_at := now();
  return new;
end $$;

create trigger connections_before_insert before insert on public.connections
  for each row execute function private.before_connection_insert();
create trigger connections_before_update before update on public.connections
  for each row execute function private.before_connection_update();

-- Participants may accept a request or leave, but never become a "request" again.
create function private.before_participant_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status = 'request' then
    raise exception 'Invalid status' using errcode = 'JM400';
  end if;
  if new.last_read_at is not null and new.last_read_at > now() then
    new.last_read_at := now();
  end if;
  return new;
end $$;

create trigger conversation_participants_before_update before update on public.conversation_participants
  for each row execute function private.before_participant_update();

-- Messages: rate limit + server timestamps; soft delete wipes content.
create function private.before_message_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.enforce_rate_limit('message', 30, interval '1 minute');
  new.created_at := now();
  new.deleted_at := null;
  if new.kind = 'image'
     and new.attachment_path not like new.conversation_id::text || '/' || new.sender_id::text || '/%' then
    raise exception 'Invalid attachment path' using errcode = 'JM400';
  end if;
  return new;
end $$;

create function private.after_message_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  -- a new message re-surfaces a direct chat the other person had removed
  update public.conversation_participants cp
  set status = 'active'
  from public.conversations c
  where c.id = new.conversation_id and c.kind = 'direct'
    and cp.conversation_id = new.conversation_id and cp.status = 'left';
  -- the sender has obviously read everything up to their own message
  update public.conversation_participants
  set last_read_at = new.created_at
  where conversation_id = new.conversation_id and user_id = new.sender_id;
  return new;
end $$;

create function private.before_message_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.deleted_at is not null then
    raise exception 'Message already deleted' using errcode = 'JM409';
  end if;
  if new.deleted_at is not null then
    new.deleted_at := now();
    new.body := null;
    new.attachment_path := null;
  end if;
  return new;
end $$;

create trigger messages_before_insert before insert on public.messages
  for each row execute function private.before_message_insert();
create trigger messages_after_insert after insert on public.messages
  for each row execute function private.after_message_insert();
create trigger messages_before_update before update on public.messages
  for each row execute function private.before_message_update();

-- Ending a session closes it for every participant.
create function private.after_session_ended()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.match_session_participants
  set left_at = coalesce(new.ended_at, now())
  where session_id = new.id and left_at is null;
  return new;
end $$;

create trigger match_sessions_after_end after update of status on public.match_sessions
  for each row when (new.status = 'ended' and old.status <> 'ended')
  execute function private.after_session_ended();

-- Reports: validate references and snapshot evidence for moderators.
create function private.before_report_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_msg public.messages%rowtype;
begin
  perform private.enforce_rate_limit('report', 10, interval '1 hour');
  new.reporter_id := auth.uid();
  new.status := 'open';
  new.created_at := now();
  new.moderator_notes := null;
  new.resolved_by := null;
  new.resolved_at := null;

  if new.message_id is not null then
    select * into v_msg from public.messages where id = new.message_id;
    if not found
       or v_msg.sender_id is distinct from new.reported_user_id
       or not private.is_conversation_member(v_msg.conversation_id, auth.uid()) then
      raise exception 'Invalid message reference' using errcode = 'JM400';
    end if;
    new.conversation_id := v_msg.conversation_id;
    new.evidence := jsonb_build_object('message_body', v_msg.body,
                                       'message_kind', v_msg.kind,
                                       'message_created_at', v_msg.created_at,
                                       'attachment_path', v_msg.attachment_path);
  elsif new.conversation_id is not null then
    if not private.is_conversation_member(new.conversation_id, auth.uid()) then
      raise exception 'Invalid conversation reference' using errcode = 'JM400';
    end if;
  end if;

  if new.session_id is not null
     and not (private.is_session_participant(new.session_id, auth.uid())
              and private.is_session_participant(new.session_id, new.reported_user_id)) then
    raise exception 'Invalid session reference' using errcode = 'JM400';
  end if;
  return new;
end $$;

create trigger reports_before_insert before insert on public.reports
  for each row execute function private.before_report_insert();

-- =============================================================================
-- RPCs (public API, called with supabase.rpc(...))
-- =============================================================================

-- Self-declared age gate for guests / OAuth users who skipped it at sign-up.
create function public.confirm_age(p_birth_date date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'JM401';
  end if;
  if p_birth_date is null or p_birth_date < date '1900-01-01' or p_birth_date > current_date then
    raise exception 'Invalid birth date' using errcode = 'JM400';
  end if;
  if p_birth_date > (current_date - interval '18 years')::date then
    raise exception 'You must be 18 or older to use JoloMeet' using errcode = 'JM403';
  end if;
  update public.user_private
  set birth_date = p_birth_date, age_confirmed_at = now()
  where user_id = auth.uid() and birth_date is null;
  if not found then
    raise exception 'Birth date is already set' using errcode = 'JM409';
  end if;
end $$;

-- Heartbeat: call every ~30s (every ~10s while waiting in the queue).
create function public.touch_presence()
returns void language sql security definer set search_path = '' as $$
  update public.user_presence set last_seen_at = now() where user_id = auth.uid();
  update public.match_queue set last_heartbeat_at = now() where user_id = auth.uid();
$$;

-- Random matchmaking. Call when the user taps "Start Text/Video Chat" or
-- "Next", then again every few seconds while status = 'waiting' (and listen on
-- Realtime for match_session_participants inserts for your user id).
create function public.request_match(
  p_mode      public.chat_mode,
  p_interests text[] default '{}',
  p_languages text[] default '{}'
)
returns table (
  status          text,     -- 'waiting' | 'matched' | 'ringing'
  session_id      uuid,
  conversation_id uuid,
  partner_id      uuid,
  is_initiator    boolean,
  mode            public.chat_mode,
  shared_interests text[]
)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid       uuid := auth.uid();
  v_interests text[];
  v_languages text[];
  v_partner   uuid;
  v_session   uuid;
  v_conv      uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = 'JM401';
  end if;
  if private.is_banned(v_uid) then
    raise exception 'Your account is restricted' using errcode = 'JM403';
  end if;
  if not private.is_adult(v_uid) then
    raise exception 'Please confirm your age first' using errcode = 'JM403', detail = 'age_required';
  end if;
  perform private.enforce_rate_limit('match_request', 60, interval '1 minute');

  select coalesce(array_agg(distinct i.slug), '{}') into v_interests
  from public.interests i
  where i.is_active and i.slug = any (coalesce(p_interests, '{}'));
  select coalesce(array_agg(distinct l), '{}') into v_languages
  from unnest(coalesce(p_languages, '{}')) l
  where l ~ '^[a-z]{2,3}$';

  -- Serialize matching so two users can never grab the same partner.
  perform pg_advisory_xact_lock(hashtext('jolomeet:matchmaking'));

  perform private.expire_stale_sessions(v_uid);
  update public.user_presence set last_seen_at = now() where user_id = v_uid;

  -- Already matched (e.g. by the partner while we were polling)? Return it.
  return query
    select case when s.status = 'ringing' then 'ringing' else 'matched' end,
           s.id, s.conversation_id, o.user_id, me.is_initiator, s.mode,
           array(select ui.interest_slug from public.user_interests ui where ui.user_id = o.user_id
                 intersect select unnest(v_interests))
    from public.match_session_participants me
    join public.match_sessions s on s.id = me.session_id
    left join public.match_session_participants o on o.session_id = s.id and o.user_id <> v_uid
    where me.user_id = v_uid and me.left_at is null and s.status <> 'ended'
    limit 1;
  if found then
    delete from public.match_queue where user_id = v_uid;
    return;
  end if;

  select q.user_id into v_partner
  from public.match_queue q
  where q.mode = p_mode
    and q.user_id <> v_uid
    and q.last_heartbeat_at > now() - interval '20 seconds'
    and not private.is_banned(q.user_id)
    and not private.is_blocked_between(v_uid, q.user_id)
    and (cardinality(v_languages) = 0 or cardinality(q.languages) = 0 or q.languages && v_languages)
    and not exists (select 1 from public.match_session_participants x
                    where x.user_id = q.user_id and x.left_at is null)
    -- don't immediately re-pair people who just skipped each other
    and not exists (
      select 1
      from public.match_session_participants a
      join public.match_session_participants b on b.session_id = a.session_id
      join public.match_sessions s on s.id = a.session_id
      where a.user_id = v_uid and b.user_id = q.user_id
        and s.created_at > now() - interval '10 minutes'
    )
  order by cardinality(array(select unnest(q.interests) intersect select unnest(v_interests))) desc,
           q.enqueued_at
  limit 1
  for update of q skip locked;

  if v_partner is null then
    insert into public.match_queue as mq (user_id, mode, interests, languages)
    values (v_uid, p_mode, v_interests, v_languages)
    on conflict (user_id) do update
      set mode = excluded.mode,
          interests = excluded.interests,
          languages = excluded.languages,
          enqueued_at = case when mq.mode = excluded.mode then mq.enqueued_at else now() end,
          last_heartbeat_at = now();
    return query select 'waiting'::text, null::uuid, null::uuid, null::uuid, null::boolean,
                        p_mode, '{}'::text[];
    return;
  end if;

  delete from public.match_queue where user_id in (v_uid, v_partner);

  insert into public.conversations (kind, created_by) values ('random', v_uid)
  returning id into v_conv;
  insert into public.conversation_participants (conversation_id, user_id)
  values (v_conv, v_uid), (v_conv, v_partner);

  insert into public.match_sessions (source, mode, status, conversation_id, created_by, started_at)
  values ('random', p_mode, 'active', v_conv, v_uid, now())
  returning id into v_session;
  insert into public.match_session_participants (session_id, user_id, is_initiator)
  values (v_session, v_uid, true), (v_session, v_partner, false);

  return query
    select 'matched'::text, v_session, v_conv, v_partner, true, p_mode,
           array(select ui.interest_slug from public.user_interests ui where ui.user_id = v_partner
                 intersect select unnest(v_interests));
end $$;

create function public.leave_match_queue()
returns void language sql security definer set search_path = '' as $$
  delete from public.match_queue where user_id = auth.uid();
$$;

-- End Call / Next / Skip. Either participant may end immediately.
create function public.end_match_session(p_session_id uuid, p_reason text default 'ended')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_reason not in ('ended', 'next', 'disconnected', 'declined', 'reported') then
    raise exception 'Invalid reason' using errcode = 'JM400';
  end if;
  if not exists (select 1 from public.match_session_participants
                 where session_id = p_session_id and user_id = auth.uid()) then
    raise exception 'Session not found' using errcode = 'JM404';
  end if;
  update public.match_sessions
  set status = 'ended', ended_at = now(), ended_by = auth.uid(), end_reason = p_reason
  where id = p_session_id and status <> 'ended';
end $$;

-- Open (or reuse) a 1:1 chat with someone from Explore / their profile.
create function public.start_direct_conversation(p_other_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_key  text;
  v_conv uuid;
  v_perm public.contact_permission;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = 'JM401';
  end if;
  if p_other_user is null or p_other_user = v_uid then
    raise exception 'Invalid user' using errcode = 'JM400';
  end if;
  if private.is_guest(v_uid) then
    raise exception 'Create an account to message people directly' using errcode = 'JM403', detail = 'guest';
  end if;
  if private.is_banned(v_uid) then
    raise exception 'Your account is restricted' using errcode = 'JM403';
  end if;

  v_key := least(v_uid, p_other_user)::text || ':' || greatest(v_uid, p_other_user)::text;
  select id into v_conv from public.conversations where direct_key = v_key;
  if v_conv is not null then
    if private.is_blocked_between(v_uid, p_other_user) then
      raise exception 'You cannot message this user' using errcode = 'JM403';
    end if;
    update public.conversation_participants set status = 'active'
    where conversation_id = v_conv and user_id = v_uid and status = 'left';
    return v_conv;
  end if;

  select allow_messages_from into v_perm from public.profiles where id = p_other_user;
  if v_perm is null
     or private.is_guest(p_other_user)
     or not private.can_view_profile(v_uid, p_other_user)
     or not private.permission_allows(v_perm, v_uid, p_other_user) then
    raise exception 'This user is not accepting messages from you' using errcode = 'JM403';
  end if;
  perform private.enforce_rate_limit('direct_conversation', 20, interval '1 hour');

  insert into public.conversations (kind, direct_key, created_by)
  values ('direct', v_key, v_uid)
  on conflict (direct_key) do nothing
  returning id into v_conv;
  if v_conv is null then  -- created concurrently by the other person
    select id into v_conv from public.conversations where direct_key = v_key;
    return v_conv;
  end if;

  insert into public.conversation_participants (conversation_id, user_id, status)
  values (v_conv, v_uid, 'active'),
         (v_conv, p_other_user,
          case when private.are_connected(v_uid, p_other_user) then 'active' else 'request' end::public.participant_status);
  return v_conv;
end $$;

-- Ring someone for a 1:1 video call ("Start Video" on a profile).
create function public.start_direct_call(p_other_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_perm    public.contact_permission;
  v_conv    uuid;
  v_session uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = 'JM401';
  end if;
  if p_other_user is null or p_other_user = v_uid then
    raise exception 'Invalid user' using errcode = 'JM400';
  end if;
  if private.is_guest(v_uid) or private.is_banned(v_uid) or not private.is_adult(v_uid) then
    raise exception 'You cannot start calls' using errcode = 'JM403';
  end if;

  select allow_video_from into v_perm from public.profiles where id = p_other_user;
  if v_perm is null
     or private.is_guest(p_other_user)
     or not private.is_adult(p_other_user)
     or not private.can_view_profile(v_uid, p_other_user)
     or not private.permission_allows(v_perm, v_uid, p_other_user) then
    raise exception 'This user is not accepting video calls from you' using errcode = 'JM403';
  end if;
  perform private.enforce_rate_limit('direct_call', 10, interval '10 minutes');

  perform pg_advisory_xact_lock(hashtext('jolomeet:matchmaking'));
  perform private.expire_stale_sessions(v_uid);
  perform private.expire_stale_sessions(p_other_user);
  delete from public.match_queue where user_id in (v_uid, p_other_user);

  select id into v_conv from public.conversations
  where direct_key = least(v_uid, p_other_user)::text || ':' || greatest(v_uid, p_other_user)::text;

  insert into public.match_sessions (source, mode, status, conversation_id, created_by)
  values ('direct', 'video', 'ringing', v_conv, v_uid)
  returning id into v_session;
  begin
    insert into public.match_session_participants (session_id, user_id, is_initiator)
    values (v_session, v_uid, true), (v_session, p_other_user, false);
  exception when unique_violation then
    raise exception 'User is busy' using errcode = 'JM409', detail = 'busy';
  end;
  return v_session;
end $$;

create function public.respond_to_call(p_session_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.match_session_participants sp
    join public.match_sessions s on s.id = sp.session_id
    where sp.session_id = p_session_id and sp.user_id = auth.uid() and not sp.is_initiator
      and s.status = 'ringing'
  ) then
    raise exception 'Call not found' using errcode = 'JM404';
  end if;
  if p_accept then
    update public.match_sessions
    set status = 'active', started_at = now()
    where id = p_session_id and created_at > now() - interval '45 seconds';
    if not found then
      update public.match_sessions set status = 'ended', ended_at = now(), end_reason = 'timeout'
      where id = p_session_id;
      raise exception 'The call has expired' using errcode = 'JM409';
    end if;
  else
    update public.match_sessions
    set status = 'ended', ended_at = now(), ended_by = auth.uid(), end_reason = 'declined'
    where id = p_session_id;
  end if;
end $$;

-- Chat sidebar list. p_filter: 'all' | 'favorites' | 'requests'.
-- Keyset pagination: pass the last row's sort_at as p_before.
create function public.list_my_conversations(
  p_filter text default 'all',
  p_limit  int default 30,
  p_before timestamptz default null
)
returns table (
  conversation_id     uuid,
  kind                public.conversation_kind,
  my_status           public.participant_status,
  is_favorite         boolean,
  is_muted            boolean,
  sort_at             timestamptz,
  last_message_body   text,
  last_message_kind   public.message_kind,
  last_message_sender uuid,
  unread_count        int,
  partner_id          uuid,
  partner_name        text,
  partner_avatar_path text,
  partner_last_read_at timestamptz,
  session_live        boolean
)
language sql stable security definer set search_path = '' as $$
  select c.id, c.kind, me.status, me.is_favorite, me.is_muted,
         coalesce(c.last_message_at, c.created_at),
         lm.body, lm.kind, lm.sender_id,
         (select count(*) from public.messages m
          where m.conversation_id = c.id
            and m.created_at > coalesce(me.last_read_at, '-infinity'::timestamptz)
            and m.sender_id is distinct from me.user_id
            and m.deleted_at is null)::int,
         op.user_id, pr.display_name, pr.avatar_path,
         -- respect the partner's "show read receipts" setting
         case when coalesce((select us.show_read_receipts from public.user_settings us
                             where us.user_id = op.user_id), true)
              then op.last_read_at end,
         exists (select 1 from public.match_sessions s
                 where s.conversation_id = c.id and s.status = 'active')
  from public.conversation_participants me
  join public.conversations c on c.id = me.conversation_id
  left join lateral (
    select m.body, m.kind, m.sender_id from public.messages m
    where m.conversation_id = c.id
    order by m.created_at desc limit 1
  ) lm on true
  left join lateral (
    select p.user_id, p.last_read_at from public.conversation_participants p
    where p.conversation_id = c.id and p.user_id <> me.user_id
    limit 1
  ) op on true
  left join public.profiles pr on pr.id = op.user_id
  where me.user_id = auth.uid()
    and case p_filter
          when 'requests'  then me.status = 'request'
          when 'favorites' then me.status = 'active' and me.is_favorite
          else me.status = 'active'
        end
    and (p_before is null or coalesce(c.last_message_at, c.created_at) < p_before)
    -- hide random chats where nothing was ever said
    and (c.kind = 'direct' or c.last_message_at is not null
         or exists (select 1 from public.match_sessions s
                    where s.conversation_id = c.id and s.status = 'active'))
  order by coalesce(c.last_message_at, c.created_at) desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

-- Explore page search. Only public, non-guest, non-banned, non-blocked users.
create function public.explore_profiles(
  p_search      text    default null,
  p_interests   text[]  default null,
  p_languages   text[]  default null,
  p_online_only boolean default false,
  p_sort        text    default 'recommended',   -- 'recommended' | 'recent'
  p_limit       int     default 24,
  p_offset      int     default 0
)
returns table (
  id               uuid,
  username         text,
  display_name     text,
  bio              text,
  avatar_path      text,
  age              int,
  languages        text[],
  interests        text[],
  shared_interests text[],
  is_online        boolean,      -- null when the user hides their status
  last_seen_at     timestamptz,  -- null when the user hides their status
  can_message      boolean,
  can_video        boolean
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid     uuid := auth.uid();
  v_mine    text[];
  v_pattern text;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = 'JM401';
  end if;
  select coalesce(array_agg(ui.interest_slug), '{}') into v_mine
  from public.user_interests ui where ui.user_id = v_uid;

  if nullif(btrim(p_search), '') is not null then
    v_pattern := '%' || replace(replace(replace(left(btrim(p_search), 50),
                   '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  with candidates as (
    select p.*,
           case when p.show_online_status then pres.last_seen_at end as seen,
           coalesce((select array_agg(ui.interest_slug order by ui.interest_slug)
                     from public.user_interests ui where ui.user_id = p.id), '{}') as ints
    from public.profiles p
    join public.user_presence pres on pres.user_id = p.id
    where p.id <> v_uid
      and not p.is_guest
      and p.visibility = 'public'
      and not private.is_banned(p.id)
      and not private.is_blocked_between(v_uid, p.id)
      and (v_pattern is null or p.display_name ilike v_pattern or p.username ilike v_pattern)
      and (p_languages is null or cardinality(p_languages) = 0 or p.languages && p_languages)
  )
  select c.id, c.username, c.display_name, c.bio, c.avatar_path,
         case when c.show_age then private.age_of(c.id) end,
         c.languages, c.ints,
         array(select unnest(c.ints) intersect select unnest(v_mine)),
         case when c.seen is not null then c.seen > now() - interval '2 minutes' end,
         c.seen,
         private.permission_allows(c.allow_messages_from, v_uid, c.id),
         private.permission_allows(c.allow_video_from, v_uid, c.id)
  from candidates c
  where (p_interests is null or cardinality(p_interests) = 0 or c.ints && p_interests)
    and (not p_online_only or c.seen > now() - interval '2 minutes')
  order by
    case when p_sort = 'recent' then c.seen end desc nulls last,
    cardinality(array(select unnest(c.ints) intersect select unnest(v_mine))) desc,
    c.seen desc nulls last,
    c.created_at desc,
    c.id
  limit least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- Profile page. Returns no row when the viewer may not see the profile.
create function public.get_profile(p_user_id uuid)
returns table (
  id                 uuid,
  username           text,
  display_name       text,
  bio                text,
  avatar_path        text,
  cover_path         text,
  age                int,
  languages          text[],
  interests          text[],
  shared_interests   text[],
  is_guest           boolean,
  is_owner           boolean,
  is_online          boolean,
  last_seen_at       timestamptz,
  joined_at          timestamptz,
  connection_status  text,    -- 'self' | 'none' | 'outgoing' | 'incoming' | 'connected' | 'declined'
  is_blocked_by_me   boolean,
  connection_count   int,
  mutual_connections int,
  can_message        boolean,
  can_video          boolean
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if not private.can_view_profile(v_uid, p_user_id) then
    return;
  end if;
  return query
  with ints as (
    select coalesce(array_agg(ui.interest_slug order by ui.interest_slug), '{}') as list
    from public.user_interests ui where ui.user_id = p_user_id
  ), mine as (
    select coalesce(array_agg(ui.interest_slug), '{}') as list
    from public.user_interests ui where ui.user_id = v_uid
  ), friends as (
    select case when requester_id = p_user_id then addressee_id else requester_id end as friend_id
    from public.connections
    where status = 'accepted' and p_user_id in (requester_id, addressee_id)
  ), my_friends as (
    select case when requester_id = v_uid then addressee_id else requester_id end as friend_id
    from public.connections
    where status = 'accepted' and v_uid in (requester_id, addressee_id)
  ), conn as (
    select * from public.connections
    where least(requester_id, addressee_id) = least(v_uid, p_user_id)
      and greatest(requester_id, addressee_id) = greatest(v_uid, p_user_id)
  ), seen as (
    select case when private.can_see_presence(v_uid, p_user_id) then last_seen_at end as at
    from public.user_presence where user_id = p_user_id
  )
  select p.id, p.username, p.display_name, p.bio, p.avatar_path, p.cover_path,
         case when p.show_age or p.id = v_uid then private.age_of(p.id) end,
         p.languages,
         (select list from ints),
         array(select unnest((select list from ints)) intersect select unnest((select list from mine))),
         p.is_guest,
         p.id = v_uid,
         (select at > now() - interval '2 minutes' from seen),
         (select at from seen),
         p.created_at,
         case
           when p.id = v_uid then 'self'
           when not exists (select 1 from conn) then 'none'
           when (select status from conn) = 'accepted' then 'connected'
           when (select status from conn) = 'declined' then 'declined'
           when (select requester_id from conn) = v_uid then 'outgoing'
           else 'incoming'
         end,
         exists (select 1 from public.blocks b where b.blocker_id = v_uid and b.blocked_id = p.id),
         (select count(*) from friends)::int,
         case when p.id = v_uid then 0
              else (select count(*) from friends f join my_friends m using (friend_id))::int end,
         p.id <> v_uid and not p.is_guest
           and private.permission_allows(p.allow_messages_from, v_uid, p.id),
         p.id <> v_uid and not p.is_guest
           and private.permission_allows(p.allow_video_from, v_uid, p.id)
  from public.profiles p
  where p.id = p_user_id;
end $$;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.interests                  enable row level security;
alter table public.profiles                   enable row level security;
alter table public.user_private               enable row level security;
alter table public.user_settings              enable row level security;
alter table public.user_presence              enable row level security;
alter table public.user_interests             enable row level security;
alter table public.blocks                     enable row level security;
alter table public.connections                enable row level security;
alter table public.conversations              enable row level security;
alter table public.conversation_participants  enable row level security;
alter table public.messages                   enable row level security;
alter table public.match_queue                enable row level security;
alter table public.match_sessions             enable row level security;
alter table public.match_session_participants enable row level security;
alter table public.reports                    enable row level security;
alter table public.rate_limit_events          enable row level security;  -- no policies: internal only

-- interests
create policy "Anyone can read interests" on public.interests
  for select to anon, authenticated using (true);

-- profiles
create policy "Visible profiles are readable" on public.profiles
  for select to authenticated using (private.can_view_profile((select auth.uid()), id));
create policy "Users update their own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- user_private
create policy "Users read their own private data" on public.user_private
  for select to authenticated using (user_id = (select auth.uid()));

-- user_settings
create policy "Users read their own settings" on public.user_settings
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Users update their own settings" on public.user_settings
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- user_presence
create policy "Presence follows privacy settings" on public.user_presence
  for select to authenticated using (private.can_see_presence((select auth.uid()), user_id));

-- user_interests
create policy "Interests of visible profiles are readable" on public.user_interests
  for select to authenticated using (private.can_view_profile((select auth.uid()), user_id));
create policy "Users add their own interests" on public.user_interests
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users remove their own interests" on public.user_interests
  for delete to authenticated using (user_id = (select auth.uid()));

-- blocks
create policy "Users see who they blocked" on public.blocks
  for select to authenticated using (blocker_id = (select auth.uid()));
create policy "Users block others" on public.blocks
  for insert to authenticated with check (blocker_id = (select auth.uid()));
create policy "Users unblock" on public.blocks
  for delete to authenticated using (blocker_id = (select auth.uid()));

-- connections
create policy "Parties see their connections" on public.connections
  for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));
create policy "Members send connection requests" on public.connections
  for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and not private.is_guest((select auth.uid()))
    and not private.is_guest(addressee_id)
    and not private.is_banned((select auth.uid()))
    and private.can_view_profile((select auth.uid()), addressee_id)
  );
create policy "Addressee answers requests" on public.connections
  for update to authenticated
  using (addressee_id = (select auth.uid()))
  with check (addressee_id = (select auth.uid()) and status in ('accepted', 'declined'));
create policy "Parties remove connections" on public.connections
  for delete to authenticated
  using (
    ((select auth.uid()) in (requester_id, addressee_id) and status <> 'declined')
    or (status = 'declined' and addressee_id = (select auth.uid()))
  );

-- conversations (created only via RPCs)
create policy "Members read conversations" on public.conversations
  for select to authenticated using (private.is_conversation_member(id, (select auth.uid())));

-- conversation_participants
create policy "Members see participants" on public.conversation_participants
  for select to authenticated
  using (private.is_conversation_member(conversation_id, (select auth.uid())));
create policy "Users update their own participation" on public.conversation_participants
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- messages
create policy "Members read messages" on public.messages
  for select to authenticated
  using (private.is_conversation_member(conversation_id, (select auth.uid())));
create policy "Members send messages" on public.messages
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and kind <> 'system'
    and private.can_send_message(conversation_id)
  );
create policy "Senders delete their messages" on public.messages
  for update to authenticated
  using (sender_id = (select auth.uid())) with check (sender_id = (select auth.uid()));

-- matchmaking (writes only via RPCs)
create policy "Users see their own queue entry" on public.match_queue
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Participants read their sessions" on public.match_sessions
  for select to authenticated using (private.is_session_participant(id, (select auth.uid())));
create policy "Participants read session members" on public.match_session_participants
  for select to authenticated
  using (private.is_session_participant(session_id, (select auth.uid())));

-- reports
create policy "Users file reports" on public.reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid()) and reported_user_id <> (select auth.uid()));
create policy "Reporters and staff read reports" on public.reports
  for select to authenticated
  using (reporter_id = (select auth.uid()) or private.is_staff());
create policy "Staff update reports" on public.reports
  for update to authenticated using (private.is_staff()) with check (private.is_staff());

-- =============================================================================
-- Privileges (column-level where clients may write)
-- =============================================================================
revoke all on all tables in schema public from anon, authenticated;

grant select on public.interests to anon, authenticated;

grant select on public.profiles to authenticated;
grant update (username, display_name, bio, avatar_path, cover_path, languages, show_age,
              visibility, show_online_status, allow_messages_from, allow_video_from)
  on public.profiles to authenticated;

grant select on public.user_private to authenticated;

grant select on public.user_settings to authenticated;
grant update (notify_messages, notify_connection_requests, notify_matches, sound_enabled,
              enter_to_send, show_read_receipts, show_typing_indicator, video_quality,
              mirror_self_view)
  on public.user_settings to authenticated;

grant select on public.user_presence to authenticated;

grant select, delete on public.user_interests to authenticated;
grant insert (user_id, interest_slug) on public.user_interests to authenticated;

grant select, delete on public.blocks to authenticated;
grant insert (blocker_id, blocked_id) on public.blocks to authenticated;

grant select, delete on public.connections to authenticated;
grant insert (requester_id, addressee_id) on public.connections to authenticated;
grant update (status) on public.connections to authenticated;

grant select on public.conversations to authenticated;

grant select on public.conversation_participants to authenticated;
grant update (status, is_favorite, is_muted, last_read_at)
  on public.conversation_participants to authenticated;

grant select on public.messages to authenticated;
grant insert (conversation_id, client_id, kind, body, attachment_path)
  on public.messages to authenticated;
grant update (deleted_at) on public.messages to authenticated;

grant select on public.match_queue, public.match_sessions, public.match_session_participants
  to authenticated;

grant select on public.reports to authenticated;
grant insert (reported_user_id, context, reason, details, message_id, conversation_id, session_id)
  on public.reports to authenticated;
grant update (status, moderator_notes, resolved_by, resolved_at) on public.reports to authenticated;

-- Functions: nothing is executable by default; then grant what is needed.
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on all functions in schema public  from public, anon, authenticated;

-- Helpers referenced inside RLS policies must be executable by the caller.
-- They live in the private schema, so they cannot be called through the API.
grant execute on function
  private.can_view_profile(uuid, uuid),
  private.can_see_presence(uuid, uuid),
  private.is_conversation_member(uuid, uuid),
  private.is_session_participant(uuid, uuid),
  private.can_send_message(uuid),
  private.is_guest(uuid),
  private.is_banned(uuid),
  private.is_staff(),
  private.try_uuid(text),
  private.can_access_realtime_topic(text)
to authenticated;

grant execute on function
  public.confirm_age(date),
  public.touch_presence(),
  public.request_match(public.chat_mode, text[], text[]),
  public.leave_match_queue(),
  public.end_match_session(uuid, text),
  public.start_direct_conversation(uuid),
  public.start_direct_call(uuid),
  public.respond_to_call(uuid, boolean),
  public.list_my_conversations(text, int, timestamptz),
  public.explore_profiles(text, text[], text[], boolean, text, int, int),
  public.get_profile(uuid)
to authenticated;

-- =============================================================================
-- Storage buckets & policies
--   avatars / covers:   <user_id>/<file>                  (public read)
--   chat-attachments:   <conversation_id>/<user_id>/<file> (members only)
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars',          'avatars',          true,  2097152, array['image/jpeg', 'image/png', 'image/webp']),
  ('covers',           'covers',           true,  5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('chat-attachments', 'chat-attachments', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create policy "Owners read their profile images" on storage.objects
  for select to authenticated
  using (bucket_id in ('avatars', 'covers')
         and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Members upload profile images" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('avatars', 'covers')
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and not private.is_guest((select auth.uid())));
create policy "Owners replace profile images" on storage.objects
  for update to authenticated
  using (bucket_id in ('avatars', 'covers')
         and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id in ('avatars', 'covers')
              and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Owners delete profile images" on storage.objects
  for delete to authenticated
  using (bucket_id in ('avatars', 'covers')
         and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Members read chat attachments" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-attachments'
         and private.is_conversation_member(private.try_uuid((storage.foldername(name))[1]),
                                            (select auth.uid())));
create policy "Members upload chat attachments" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-attachments'
              and (storage.foldername(name))[2] = (select auth.uid())::text
              and private.can_send_message(private.try_uuid((storage.foldername(name))[1])));
create policy "Senders delete chat attachments" on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-attachments'
         and (storage.foldername(name))[2] = (select auth.uid())::text);

-- =============================================================================
-- Realtime
--   * Postgres Changes (RLS-filtered) for messages, participants, sessions,
--     connections.
--   * Private Broadcast/Presence channels authorized by topic (see
--     private.can_access_realtime_topic). Clients must join with
--     { config: { private: true } }.
-- =============================================================================
alter publication supabase_realtime add table
  public.messages,
  public.conversation_participants,
  public.match_sessions,
  public.match_session_participants,
  public.connections;

create policy "JoloMeet members receive channel messages" on realtime.messages
  for select to authenticated
  using (private.can_access_realtime_topic((select realtime.topic())));
create policy "JoloMeet members send channel messages" on realtime.messages
  for insert to authenticated
  with check (private.can_access_realtime_topic((select realtime.topic())));

-- =============================================================================
-- Seed data: interest catalogue
-- =============================================================================
insert into public.interests (slug, label, sort_order, is_featured) values
  ('music',       'Music',        10, true),
  ('gaming',      'Gaming',       20, true),
  ('movies',      'Movies',       30, true),
  ('travel',      'Travel',       40, true),
  ('fitness',     'Fitness',      50, true),
  ('memes',       'Memes',        60, true),
  ('food',        'Food',         70, true),
  ('photography', 'Photography',  80, true),
  ('anime',       'Anime',        90, true),
  ('sports',      'Sports',      100, true),
  ('art',         'Art',         110, false),
  ('books',       'Books',       120, false),
  ('coding',      'Coding',      130, false),
  ('dance',       'Dance',       140, false),
  ('fashion',     'Fashion',     150, false),
  ('k-pop',       'K-Pop',       160, false),
  ('nature',      'Nature',      170, false),
  ('pets',        'Pets',        180, false),
  ('podcasts',    'Podcasts',    190, false),
  ('science',     'Science',     200, false),
  ('tech',        'Tech',        210, false),
  ('writing',     'Writing',     220, false)
on conflict (slug) do nothing;
