-- Signature features: voice notes, mutual "Stay in touch".
-- Written to run as one script (the SQL Editor runs it in a single
-- transaction): the new 'voice' enum value is only ever compared as text here,
-- which Postgres allows in the same transaction that adds it.

-- ---------------------------------------------------------------------------
-- Voice notes in chat
-- ---------------------------------------------------------------------------
alter type public.message_kind add value if not exists 'voice';

-- image and voice messages carry a file; a voice message's body is its length in seconds
alter table public.messages drop constraint if exists messages_check;
alter table public.messages add constraint messages_check check (
  deleted_at is not null
  or (kind::text in ('text', 'system') and char_length(btrim(body)) > 0 and attachment_path is null)
  or (kind::text = 'image' and attachment_path is not null)
  or (kind::text = 'voice' and attachment_path is not null and body ~ '^[0-9]{1,3}$')
);

-- Messages: rate limit + server timestamps; attachments must live in the sender's folder.
create or replace function private.before_message_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.enforce_rate_limit('message', 30, interval '1 minute');
  new.created_at := now();
  new.deleted_at := null;
  if new.kind::text in ('image', 'voice')
     and new.attachment_path not like new.conversation_id::text || '/' || new.sender_id::text || '/%' then
    raise exception 'Invalid attachment path' using errcode = 'JM400';
  end if;
  return new;
end $$;

-- the private chat bucket also accepts recorded audio (5 MB is about 10 minutes; notes stop at 2)
update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif',
                               'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']
where id = 'chat-attachments';

-- ---------------------------------------------------------------------------
-- Mutual "Stay in touch"
-- A like is private: nobody learns about a one-sided like. When both people
-- in a random match like each other, they become connected.
-- ---------------------------------------------------------------------------
create table if not exists public.match_likes (
  session_id uuid not null references public.match_sessions (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

alter table public.match_likes enable row level security;
drop policy if exists "Users see their own likes" on public.match_likes;
create policy "Users see their own likes" on public.match_likes
  for select to authenticated using (user_id = (select auth.uid()));
grant select on public.match_likes to authenticated;  -- writes only through stay_in_touch()

-- Connection requests: rate-limit what people send; connections the database
-- makes itself (e.g. a mutual match while someone signs up, when there is no
-- signed-in user) are not limited. People can only insert rows as themselves.
create or replace function private.before_connection_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    perform private.enforce_rate_limit('connection_request', 30, interval '1 hour');
  end if;
  new.status := 'pending';
  new.created_at := now();
  new.responded_at := null;
  return new;
end $$;

-- Accepted connection between two members, whatever state their pair was in.
create or replace function private.connect_users(p_a uuid, p_b uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_id     uuid;
  v_status public.connection_status;
begin
  select id, status into v_id, v_status from public.connections
  where least(requester_id, addressee_id) = least(p_a, p_b)
    and greatest(requester_id, addressee_id) = greatest(p_a, p_b);

  if v_status = 'accepted' then
    return;
  elsif v_status = 'declined' then
    delete from public.connections where id = v_id;  -- a mutual like overrides an old "no"
    v_id := null;
  end if;

  if v_id is null then
    -- the insert trigger always creates a pending request
    insert into public.connections (requester_id, addressee_id) values (p_a, p_b)
    returning id into v_id;
  end if;
  update public.connections set status = 'accepted' where id = v_id;
end $$;

-- Returns 'waiting' (only you so far), 'mutual' (now connected) or
-- 'mutual_needs_account' (both said yes, but someone has no account yet;
-- they're connected automatically once that person signs up).
create or replace function public.stay_in_touch(p_session_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_partner uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = 'JM401';
  end if;
  select o.user_id into v_partner
  from public.match_session_participants me
  join public.match_session_participants o on o.session_id = me.session_id and o.user_id <> v_uid
  where me.session_id = p_session_id and me.user_id = v_uid;
  if v_partner is null then
    raise exception 'Session not found' using errcode = 'JM404';
  end if;
  if private.is_blocked_between(v_uid, v_partner) then
    raise exception 'You can''t stay in touch with this person' using errcode = 'JM403';
  end if;
  perform private.enforce_rate_limit('stay_in_touch', 60, interval '1 hour');

  insert into public.match_likes (session_id, user_id) values (p_session_id, v_uid)
  on conflict do nothing;

  if not exists (select 1 from public.match_likes where session_id = p_session_id and user_id = v_partner) then
    return 'waiting';
  end if;
  if private.is_guest(v_uid) or private.is_guest(v_partner) then
    return 'mutual_needs_account';
  end if;
  perform private.connect_users(v_uid, v_partner);
  return 'mutual';
end $$;

revoke execute on function public.stay_in_touch(uuid) from public, anon;
grant execute on function public.stay_in_touch(uuid) to authenticated;
revoke execute on function private.connect_users(uuid, uuid) from public, anon, authenticated;

-- Guest upgraded to a full account (anonymous user linked an email):
-- also connect them with anyone they had a mutual "Stay in touch" with.
create or replace function private.handle_user_updated()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_partner uuid;
begin
  update public.profiles set is_guest = coalesce(new.is_anonymous, false) where id = new.id;
  if coalesce(new.is_anonymous, false) = false then
    -- never let this block the sign-up itself
    begin
      for v_partner in
        select distinct theirs.user_id
        from public.match_likes mine
        join public.match_likes theirs on theirs.session_id = mine.session_id and theirs.user_id <> new.id
        where mine.user_id = new.id
          and not private.is_guest(theirs.user_id)
          and not private.is_blocked_between(new.id, theirs.user_id)
      loop
        perform private.connect_users(new.id, v_partner);
      end loop;
    exception when others then
      raise warning 'Could not connect mutual matches for %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end $$;
