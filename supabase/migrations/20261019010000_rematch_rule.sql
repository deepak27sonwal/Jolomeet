-- Matchmaking fix: people matched with each other in the last 10 minutes
-- could not be matched again at all (in any mode), so with few people online,
-- e.g. trying audio or video right after a text chat, both just waited.
-- Now only an instant re-match right after one of them pressed Next (same
-- mode, 2 minutes) is prevented; otherwise someone new is simply preferred.
-- Matching is serialized with a table lock on match_queue (same effect as the
-- advisory lock before).

create or replace function public.request_match(
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
  lock table public.match_queue in share row exclusive mode;

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
    -- after one of them pressed Next, don't hand them straight back to each other
    and not exists (
      select 1
      from public.match_session_participants a
      join public.match_session_participants b on b.session_id = a.session_id
      join public.match_sessions s on s.id = a.session_id
      where a.user_id = v_uid and b.user_id = q.user_id
        and s.mode = p_mode and s.end_reason = 'next'
        and s.ended_at > now() - interval '2 minutes'
    )
  -- prefer someone new over someone matched in the last 10 minutes, then shared interests
  order by exists (
             select 1
             from public.match_session_participants a
             join public.match_session_participants b on b.session_id = a.session_id
             join public.match_sessions s on s.id = a.session_id
             where a.user_id = v_uid and b.user_id = q.user_id
               and s.created_at > now() - interval '10 minutes'
           ),
           cardinality(array(select unnest(q.interests) intersect select unnest(v_interests))) desc,
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
