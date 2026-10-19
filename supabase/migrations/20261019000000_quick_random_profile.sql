-- Random chat without signing up: visitors give a name, gender and age, and
-- the browser creates an anonymous session with those details (no email,
-- no password). The age becomes an approximate birth date so the existing
-- 18+ checks keep working, and it is shown to the people they match with.

alter table public.profiles add column if not exists gender text
  check (gender in ('female', 'male', 'nonbinary'));

grant update (gender) on public.profiles to authenticated;

-- New auth user → profile, private data, settings, presence.
-- Same as before, plus gender and show_age from the sign-up metadata.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_meta   jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_guest  boolean := coalesce(new.is_anonymous, false);
  v_name   text := nullif(btrim(v_meta ->> 'display_name'), '');
  v_gender text := case when v_meta ->> 'gender' in ('female', 'male', 'nonbinary') then v_meta ->> 'gender' end;
  v_birth  date;
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
  insert into public.profiles (id, display_name, is_guest, visibility, gender, show_age)
  values (
    new.id,
    left(coalesce(v_name, case when v_guest then 'Guest-' else 'User-' end
                          || left(replace(new.id::text, '-', ''), 6)), 40),
    v_guest,
    case when v_guest then 'private' else 'public' end::public.profile_visibility,
    v_gender,
    coalesce(v_meta ->> 'show_age' = 'true', false)
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
