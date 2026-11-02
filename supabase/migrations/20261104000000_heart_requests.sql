-- =============================================================================
-- The heart ("Stay in touch") now sends a request the other person can accept
-- or decline. Before, a like stayed invisible until both people tapped it.
--
--   * two accounts  : tapping the heart saves the like and creates a pending
--                     connection request to the other person, who is told
--                     (Realtime on public.connections) and answers it with
--                     Accept / Decline (existing RLS lets only the addressee answer);
--   * they tapped first, or the pair already asked each other: connected now;
--   * a guest on either side: unchanged, a private like that becomes a
--                     connection when the guest signs up (guests can't have
--                     connection requests);
--   * already declined by them: nothing is sent again, the caller just learns 'declined'
--                     (if the caller had declined the other person's request and now taps
--                     the heart, that is a yes: they did ask first);
--   * blocked / banned / rate limits: enforced here as before.
--
-- Returns 'requested' (request sent, waiting for an answer), 'waiting' (guest:
-- private like), 'mutual', 'mutual_needs_account' or 'declined'.
-- =============================================================================
create or replace function public.stay_in_touch(p_session_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_partner uuid;
  v_guest   boolean;
  v_conn    public.connections%rowtype;
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

  v_guest := private.is_guest(v_uid) or private.is_guest(v_partner);

  -- they tapped the heart too: connected (a mutual like also overrides an earlier "no")
  if exists (select 1 from public.match_likes where session_id = p_session_id and user_id = v_partner) then
    if v_guest then
      return 'mutual_needs_account';
    end if;
    perform private.connect_users(v_uid, v_partner);
    return 'mutual';
  end if;

  -- guests can't have connection requests: it stays a private like until sign-up
  if v_guest then
    return 'waiting';
  end if;

  select * into v_conn from public.connections
  where least(requester_id, addressee_id) = least(v_uid, v_partner)
    and greatest(requester_id, addressee_id) = greatest(v_uid, v_partner);

  if found then
    if v_conn.status = 'accepted' then
      return 'mutual';
    elsif v_conn.status = 'declined' then
      if v_conn.requester_id = v_uid then
        return 'declined';        -- they said no: never notify them again
      end if;
      -- I had said no to their request and have changed my mind: they did ask first
      perform private.connect_users(v_uid, v_partner);
      return 'mutual';
    elsif v_conn.requester_id = v_uid then
      return 'requested';         -- already asked, still waiting
    end if;
    -- they had asked me (for example from their profile page): the heart accepts
    update public.connections set status = 'accepted' where id = v_conn.id;
    return 'mutual';
  end if;

  -- the insert trigger makes it a pending request and applies the hourly limit
  insert into public.connections (requester_id, addressee_id) values (v_uid, v_partner);
  return 'requested';
end $$;

revoke execute on function public.stay_in_touch(uuid) from public, anon;
grant execute on function public.stay_in_touch(uuid) to authenticated;
