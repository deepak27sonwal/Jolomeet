-- Emoji reactions on chat messages.
-- One reaction per person per message, from a fixed set. Removing a reaction
-- sets emoji to null instead of deleting the row, so live updates go out as
-- inserts/updates, which Realtime filters with the read policy below (deletes
-- would be broadcast without that check).

create table if not exists public.message_reactions (
  message_id      uuid not null references public.messages (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  emoji           text check (emoji in ('❤️', '😂', '😮', '😢', '👍', '🔥')),
  updated_at      timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists message_reactions_conversation_idx on public.message_reactions (conversation_id);

alter table public.message_reactions enable row level security;

create policy "Members see reactions in their chats" on public.message_reactions
  for select to authenticated
  using (private.is_conversation_member(conversation_id, (select auth.uid())));

grant select on public.message_reactions to authenticated;

-- Writes only through this function: add, change (another emoji) or remove (null).
create or replace function public.react_to_message(p_message uuid, p_emoji text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_conv    uuid;
  v_deleted timestamptz;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = 'JM401';
  end if;
  if p_emoji is not null and p_emoji not in ('❤️', '😂', '😮', '😢', '👍', '🔥') then
    raise exception 'Unsupported reaction' using errcode = 'JM400';
  end if;
  select conversation_id, deleted_at into v_conv, v_deleted from public.messages where id = p_message;
  if v_conv is null or not private.is_conversation_member(v_conv, v_uid) then
    raise exception 'Message not found' using errcode = 'JM404';
  end if;
  if v_deleted is not null and p_emoji is not null then
    raise exception 'Message deleted' using errcode = 'JM409';
  end if;
  perform private.enforce_rate_limit('reaction', 60, interval '1 minute');
  insert into public.message_reactions (message_id, user_id, conversation_id, emoji, updated_at)
  values (p_message, v_uid, v_conv, p_emoji, now())
  on conflict (message_id, user_id) do update set emoji = excluded.emoji, updated_at = now();
end $$;

revoke execute on function public.react_to_message(uuid, text) from public, anon;
grant execute on function public.react_to_message(uuid, text) to authenticated;

alter publication supabase_realtime add table public.message_reactions;
