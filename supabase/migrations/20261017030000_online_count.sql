-- Live "people online" count for the homepage. Counts only users who were
-- active in the last 2 minutes and allow their online status to be shown.
create function public.count_online_users()
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int
  from public.user_presence up
  join public.profiles p on p.id = up.user_id
  where up.last_seen_at > now() - interval '2 minutes'
    and p.show_online_status
    and not private.is_banned(p.id);
$$;

revoke execute on function public.count_online_users() from public;
grant execute on function public.count_online_users() to anon, authenticated;
