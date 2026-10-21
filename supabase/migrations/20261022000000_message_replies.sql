-- Replies: a message can quote an earlier message in the same conversation.
-- If the quoted message row is removed, the reply stays and just loses the link.

alter table public.messages
  add column if not exists reply_to_id uuid references public.messages (id) on delete set null;

grant insert (reply_to_id) on public.messages to authenticated;

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
  -- a reply can only point at a message in the same conversation
  if new.reply_to_id is not null and not exists (
    select 1 from public.messages m
    where m.id = new.reply_to_id and m.conversation_id = new.conversation_id
  ) then
    raise exception 'Invalid reply' using errcode = 'JM400';
  end if;
  return new;
end $$;
