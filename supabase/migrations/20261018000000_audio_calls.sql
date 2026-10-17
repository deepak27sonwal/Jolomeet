-- Random audio calls: a third matchmaking mode, plus a report context for it.
-- request_match, end_match_session and the match:<session id> Realtime topic
-- already work for any mode, so nothing else changes.
alter type public.chat_mode add value if not exists 'audio';
alter type public.report_context add value if not exists 'audio_call';
