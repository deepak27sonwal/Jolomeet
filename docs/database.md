# JoloMeet — Supabase database

The full schema lives in [`supabase/migrations/20261017000000_initial_schema.sql`](../supabase/migrations/20261017000000_initial_schema.sql).
Apply it with the Supabase CLI (`supabase db push`) or paste it into the SQL editor of a fresh project.

## Tables

| Table | Purpose | Who can read | Who can write |
|---|---|---|---|
| `interests` | Interest catalogue for the "What's your vibe?" chips (`is_featured` = shown before "More") | everyone (incl. logged-out) | migrations only |
| `profiles` | Public profile: display name, username, bio, avatar/cover paths, languages, privacy flags (`visibility`, `show_online_status`, `allow_messages_from`, `allow_video_from`), `is_guest` | users the profile is visible to | owner (privacy and profile columns only) |
| `user_private` | Birth date, age confirmation, terms acceptance, role, ban status | owner | server only (`confirm_age` RPC) |
| `user_settings` | Notification, sound, enter-to-send, read receipts, typing indicator, video quality | owner | owner |
| `user_presence` | `last_seen_at` heartbeat (live presence uses Realtime Presence) | users allowed by `show_online_status` | `touch_presence` RPC |
| `user_interests` | User ↔ interest (max 10) | users who can see the profile | owner |
| `blocks` | Who blocked whom; a block also removes the connection and ends live sessions | blocker | blocker |
| `connections` | Friend requests: `pending` → `accepted` / `declined` | both parties | requester creates, addressee answers |
| `conversations` | `direct` (1:1, unique per pair) or `random` (from matchmaking) | members | RPCs only |
| `conversation_participants` | Membership, `status` (`active` / `request` / `left`), favorite, muted, `last_read_at` | members | own row (accept request, leave, favorite, mark read) |
| `messages` | Text/image messages; `client_id` makes retries idempotent; soft delete wipes content | members | sender (server checks blocks, privacy, request cap, live session) |
| `match_queue` | Users waiting for a random match | own row | RPCs only |
| `match_sessions` | Random matches and direct calls (`ringing` → `active` → `ended`) | participants | RPCs only |
| `match_session_participants` | Who is in a session, who sends the WebRTC offer (`is_initiator`); a unique index stops anyone being in two open sessions | participants | RPCs only |
| `reports` | User reports with a server-captured evidence snapshot | reporter + moderators | reporter creates, moderators update |
| `rate_limit_events` | Internal log behind the rate limits | nobody | server only |

## RPCs the frontend calls (`supabase.rpc(name, args)`)

| Function | Used on | Notes |
|---|---|---|
| `explore_profiles(p_search, p_interests, p_languages, p_online_only, p_sort, p_limit, p_offset)` | explore.html | Public, non-guest, non-blocked profiles only. Online status is `null` when hidden |
| `get_profile(p_user_id)` | profile.html | No row returned if the viewer may not see it. Includes connection state, real counts and whether the viewer can message or video call |
| `list_my_conversations(p_filter, p_limit, p_before)` | chat.html sidebar | `p_filter`: `all` / `favorites` / `requests`. Returns unread counts and last message |
| `start_direct_conversation(p_other_user)` | Start Chat buttons | Respects `allow_messages_from`. Non-connections land in the recipient's **Requests** tab (max 3 messages until accepted) |
| `request_match(p_mode, p_interests, p_languages)` | Start Text/Video Chat, Next | Returns `waiting` / `matched` / `ringing`. Poll every ~3 s while waiting and also listen on Realtime |
| `leave_match_queue()` | Cancel search | |
| `end_match_session(p_session_id, p_reason)` | End Call / Next | `p_reason`: `ended`, `next`, `disconnected`, `declined`, `reported` |
| `start_direct_call(p_other_user)` / `respond_to_call(p_session_id, p_accept)` | Start Video on a profile | Respects `allow_video_from`. Unanswered calls expire after 45 s |
| `touch_presence()` | every page | Heartbeat every 30 s (10 s while queued). Sessions whose participants go silent for 90 s are ended automatically |
| `confirm_age(p_birth_date)` | guests / OAuth users | 18+ required before matchmaking or calls |

Errors use custom SQLSTATE codes that the UI can map to messages:
`JM400` invalid input · `JM401` not signed in · `JM403` not allowed · `JM404` not found · `JM409` conflict/busy · `JM429` rate limited.

## Rate limits (enforced in the database)

| Action | Limit |
|---|---|
| Send message | 30 / minute |
| Match request | 60 / minute |
| New direct conversation | 20 / hour |
| Connection request | 30 / hour |
| Direct video call | 10 / 10 minutes |
| Report | 10 / hour |
| Block | 60 / hour |

## Storage buckets

| Bucket | Path | Access |
|---|---|---|
| `avatars` (public, 2 MB, jpeg/png/webp) | `<user_id>/<file>` | owner uploads (no guests) |
| `covers` (public, 5 MB, jpeg/png/webp) | `<user_id>/<file>` | owner uploads (no guests) |
| `chat-attachments` (private, 5 MB, images) | `<conversation_id>/<user_id>/<file>` | members read; upload only if the user may post in that conversation |

## Realtime

- **Postgres Changes** (filtered by RLS) on `messages`, `conversation_participants`, `match_sessions`, `match_session_participants`, `connections`.
- **Private Broadcast/Presence channels** (join with `{ config: { private: true } }`):
  - `match:<session_id>`: WebRTC offer/answer/ICE candidates. The `is_initiator` participant sends the offer once both peers are present on the channel.
  - `conversation:<conversation_id>`: typing indicators.
  - `user:<user_id>`: personal notifications (e.g. incoming call).
  Access is checked by `private.can_access_realtime_topic`.

## Things the schema expects from the project settings

1. **Auth** (Dashboard → Authentication):
   - Enable the **Email** provider (keep "Confirm email" on) and **Anonymous sign-ins** (used by "Continue as Guest").
   - **URL Configuration**: set the Site URL to where the site is hosted and add `…/login.html` and `…/reset-password.html` to the redirect allow-list. The confirmation and password-reset emails link back to those pages.
   - Guest upgrade: a signed-in guest's register form calls `auth.updateUser({ email })`, so the "Change email address" template is the email they get; its link opens `reset-password.html?finish=1` (covered by the redirect entry above), where they set their first password. Keeping **Secure email change** on is fine: guests have no previous email to confirm.
   - The register page sends `options.data = { display_name, birth_date, accepted_terms: 'true' }`; under-18 birth dates are rejected by the database trigger as well as the form.
2. **Realtime**: turn off "Allow public access" under Realtime settings so only private, authorized channels work.
3. **Edge Functions** (not SQL; they need the service role key, which must never reach the browser):
   - `turn-credentials`: returns short-lived TURN credentials (Cloudflare Calls, Twilio, Metered or your own coturn) to signed-in users.
   - `delete-account`: removes the user's storage files, then calls `auth.admin.deleteUser`. All rows cascade from `auth.users`.
4. **Scheduled cleanup** (pg_cron, optional): delete `rate_limit_events` older than a day and `match_queue` rows with stale heartbeats.
5. **Moderators**: promote with `update public.user_private set role = 'moderator' where user_id = '…';` (SQL editor or service role only). Ban with `banned_until`.

## Known limitations

- Age is **self-declared**. Real age assurance needs an external verification provider.
- Matchmaking serializes on one advisory lock. That is fine for thousands of concurrent users; beyond that, move matching into a dedicated worker.
- Avatars and covers sit in public buckets, so anyone with a file URL can fetch it even when the profile is private. Use a private bucket with signed URLs if that matters.

## Calls (WebRTC)

- `chat_mode` is `text`, `video` or `audio` (`20261018000000_audio_calls.sql`); `request_match` pairs people in the same mode only.
- After a match, both browsers join the private Realtime channel `match:<session id>` (only the session's two participants are authorized) and exchange WebRTC offer/answer/ICE messages there. Audio and video flow directly between the two browsers; nothing is recorded or stored. Besides the WebRTC messages, the pages send `{ kind: 'media', muted, cameraOff }` so each side can show the other's mute/camera state.
- `js/config.js` lists public STUN servers. Calls between people on very strict networks (some offices, schools, mobile carriers) need a TURN relay as well; add one from a TURN provider to `ICE_SERVERS` when needed.
- Reports from a call use the `audio_call` (or `video_call`) context with the session id.

