-- Editing and "delete for me".
--
-- Edit: senders can change the text of their own text message for 5 minutes
-- after sending it. The database enforces the window and stamps edited_at.
-- Delete for me: hides any message (yours or theirs) only for you; the other
-- person still sees it. Delete for everyone stays as before (deleted_at).

alter table public.messages add column if not exists edited_at timestamptz;

grant update (body) on public.messages to authenticated;

create or replace function private.before_message_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.deleted_at is not null then
    raise exception 'Message already deleted' using errcode = 'JM409';
  end if;
  if new.deleted_at is not null then
    new.deleted_at := now();
    new.body := null;
    new.attachment_path := null;
    new.edited_at := old.edited_at;
    return new;
  end if;
  if new.body is distinct from old.body then
    if old.kind <> 'text' then
      raise exception 'Only text messages can be edited' using errcode = 'JM400';
    end if;
    if now() - old.created_at > interval '5 minutes' then
      raise exception 'Messages can only be edited for 5 minutes after sending' using errcode = 'JM403';
    end if;
    new.body := btrim(new.body);
    new.edited_at := now();
  else
    new.edited_at := old.edited_at;
  end if;
  return new;
end $$;

-- Messages someone has hidden for themselves ("Delete for me")
create table if not exists public.hidden_messages (
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

alter table public.hidden_messages enable row level security;

create policy "People see what they hid" on public.hidden_messages
  for select to authenticated using (user_id = (select auth.uid()));

-- only messages from your own conversations, and only for yourself
create policy "People hide messages they can see" on public.hidden_messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and private.is_conversation_member(m.conversation_id, (select auth.uid()))
    )
  );

grant select, insert on public.hidden_messages to authenticated;
