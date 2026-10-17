// Single place that talks to Supabase. Pages import functions from here
// instead of building queries themselves.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/** Interest catalogue for the "What's your vibe?" chips, featured first. */
export async function fetchInterests() {
  const { data, error } = await supabase
    .from('interests')
    .select('slug, label, is_featured')
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw error;
  return data;
}

/** Live count of people online who allow their status to be shown. */
export async function fetchOnlineCount() {
  const { data, error } = await supabase.rpc('count_online_users');
  if (error) throw error;
  return data;
}

/* ---------- Auth ---------- */

/** Pages a successful login may send the user back to (prevents open redirects). */
export function safeNextPage(next) {
  return /^[a-z0-9-]+\.html(\?[^#\s]*)?$/i.test(next || '') ? next : 'index.html';
}

function authRedirect(page) {
  return new URL(page, window.location.href).href;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => callback(event, session));
}

/** Email sign-up. birthDate is YYYY-MM-DD; the database rejects anyone under 18. */
export async function signUp({ displayName, email, password, birthDate }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: authRedirect('login.html?confirmed=1'),
      data: { display_name: displayName, birth_date: birthDate, accepted_terms: 'true' },
    },
  });
  if (error) throw error;
  return data; // data.session is null until the email is confirmed
}

export async function signIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/** Guest access: an anonymous account plus the 18+ age confirmation. */
export async function signInAsGuest(birthDate) {
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  const { error: ageError } = await supabase.rpc('confirm_age', { p_birth_date: birthDate });
  if (ageError) {
    await supabase.auth.signOut();
    throw ageError;
  }
}

export async function resendConfirmation(email) {
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: authRedirect('login.html?confirmed=1') },
  });
  if (error) throw error;
}

export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: authRedirect('reset-password.html'),
  });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/* ---------- Profiles ---------- */

export const IMAGE_RULES = {
  avatars: { maxBytes: 2 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'] },
  covers: { maxBytes: 5 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'] },
};

/** Public profile as the viewer may see it, or null if hidden/blocked/missing. */
export async function getProfile(userId) {
  const { data, error } = await supabase.rpc('get_profile', { p_user_id: userId });
  if (error) throw error;
  return data?.[0] ?? null;
}

/** The signed-in user's own editable profile row (includes privacy flags). */
export async function getMyProfileRow(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, bio, avatar_path, cover_path, languages, show_age, visibility, show_online_status')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateMyProfile(userId, fields) {
  const { error } = await supabase.from('profiles').update(fields).eq('id', userId);
  if (error) throw error;
}

/** Replaces the user's interests with `next`, only touching what changed. */
export async function setMyInterests(userId, current, next) {
  const removed = current.filter((slug) => !next.includes(slug));
  const added = next.filter((slug) => !current.includes(slug));
  if (removed.length) {
    const { error } = await supabase.from('user_interests').delete()
      .eq('user_id', userId).in('interest_slug', removed);
    if (error) throw error;
  }
  if (added.length) {
    const { error } = await supabase.from('user_interests')
      .insert(added.map((slug) => ({ user_id: userId, interest_slug: slug })));
    if (error) throw error;
  }
}

/** Uploads an avatar or cover into the user's own folder; returns the storage path. */
export async function uploadProfileImage(bucket, userId, file) {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
  const path = `${userId}/${bucket === 'avatars' ? 'avatar' : 'cover'}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;
  return path;
}

export async function removeProfileImage(bucket, path) {
  if (!path) return;
  await supabase.storage.from(bucket).remove([path]); // best effort; an orphaned file is harmless
}

export function publicImageUrl(bucket, path) {
  if (!path) return null;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

/* ---------- Connections, blocks, reports ---------- */

export async function getConnectionWith(myId, otherId) {
  const { data, error } = await supabase
    .from('connections')
    .select('id, requester_id, addressee_id, status')
    .or(`and(requester_id.eq.${myId},addressee_id.eq.${otherId}),and(requester_id.eq.${otherId},addressee_id.eq.${myId})`)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function sendConnectionRequest(myId, otherId) {
  const { error } = await supabase.from('connections').insert({ requester_id: myId, addressee_id: otherId });
  if (error) throw error;
}

export async function respondToConnection(connectionId, accept) {
  const { error } = await supabase.from('connections')
    .update({ status: accept ? 'accepted' : 'declined' }).eq('id', connectionId);
  if (error) throw error;
}

export async function removeConnection(connectionId) {
  const { error } = await supabase.from('connections').delete().eq('id', connectionId);
  if (error) throw error;
}

export async function blockUser(myId, otherId) {
  const { error } = await supabase.from('blocks').insert({ blocker_id: myId, blocked_id: otherId });
  if (error) throw error;
}

export async function unblockUser(myId, otherId) {
  const { error } = await supabase.from('blocks').delete().eq('blocker_id', myId).eq('blocked_id', otherId);
  if (error) throw error;
}

export async function reportUser({ reportedUserId, context, reason, details, conversationId, sessionId }) {
  const { error } = await supabase.from('reports').insert({
    reported_user_id: reportedUserId,
    context,
    reason,
    details: details || null,
    conversation_id: conversationId || null,
    session_id: sessionId || null,
  });
  if (error) throw error;
}

/* ---------- Starting conversations and calls ---------- */

export async function startDirectConversation(otherId) {
  const { data, error } = await supabase.rpc('start_direct_conversation', { p_other_user: otherId });
  if (error) throw error;
  return data;
}

export async function startDirectCall(otherId) {
  const { data, error } = await supabase.rpc('start_direct_call', { p_other_user: otherId });
  if (error) throw error;
  return data;
}

/* ---------- Presence ---------- */

export async function touchPresence() {
  const { error } = await supabase.rpc('touch_presence');
  if (error) throw error;
}

/** Last-seen times for the given users (only those who share their status). */
export async function getPresence(userIds) {
  if (!userIds.length) return [];
  const { data, error } = await supabase.from('user_presence').select('user_id, last_seen_at').in('user_id', userIds);
  if (error) throw error;
  return data;
}

/* ---------- Chat ---------- */

export const CHAT_IMAGE_RULES = {
  maxBytes: 5 * 1024 * 1024,
  types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
};

/** Sidebar list. filter: 'all' | 'favorites' | 'requests'. */
export async function listConversations(filter = 'all') {
  const { data, error } = await supabase.rpc('list_my_conversations', { p_filter: filter, p_limit: 100 });
  if (error) throw error;
  return data;
}

/** Conversation kind, both participants and (for random chats) the match session. */
export async function getConversationMeta(conversationId) {
  const [conv, parts, session] = await Promise.all([
    supabase.from('conversations').select('id, kind').eq('id', conversationId).maybeSingle(),
    supabase.from('conversation_participants')
      .select('user_id, status, last_read_at, is_favorite').eq('conversation_id', conversationId),
    supabase.from('match_sessions')
      .select('id, status, mode, end_reason, ended_by').eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const r of [conv, parts, session]) if (r.error) throw r.error;
  if (!conv.data) return null;
  return { conversation: conv.data, participants: parts.data, session: session.data };
}

const MESSAGE_FIELDS = 'id, conversation_id, sender_id, client_id, kind, body, attachment_path, created_at, deleted_at';

/** Newest-last page of messages, optionally older than `before` (ISO time). */
export async function getMessages(conversationId, { before = null, limit = 40 } = {}) {
  let query = supabase.from('messages').select(MESSAGE_FIELDS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (before) query = query.lt('created_at', before);
  const { data, error } = await query;
  if (error) throw error;
  return data.reverse();
}

export async function getMessageByClientId(clientId) {
  const { data, error } = await supabase.from('messages').select(MESSAGE_FIELDS).eq('client_id', clientId).maybeSingle();
  if (error) throw error;
  return data;
}

/** Inserts a message. client_id makes a retry safe: the same message can't be stored twice. */
export async function sendMessage({ conversationId, clientId, body, kind = 'text', attachmentPath = null }) {
  const { data, error } = await supabase.from('messages')
    .insert({ conversation_id: conversationId, client_id: clientId, kind, body: body || null, attachment_path: attachmentPath })
    .select(MESSAGE_FIELDS)
    .single();
  if (error) throw error;
  return data;
}

export async function markConversationRead(conversationId, userId) {
  const { error } = await supabase.from('conversation_participants')
    .update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId).eq('user_id', userId);
  if (error) throw error;
}

/** fields: { status: 'active' | 'left' } and/or { is_favorite, is_muted } */
export async function updateParticipation(conversationId, userId, fields) {
  const { error } = await supabase.from('conversation_participants')
    .update(fields).eq('conversation_id', conversationId).eq('user_id', userId);
  if (error) throw error;
}

export async function uploadChatImage(conversationId, userId, file) {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type];
  const path = `${conversationId}/${userId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('chat-attachments')
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return path;
}

/** Chat images live in a private bucket, so they are shown through short-lived signed links. */
export async function chatImageUrl(path) {
  const { data, error } = await supabase.storage.from('chat-attachments').createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

/* ---------- Matchmaking ---------- */

/** Returns { status: 'waiting' | 'matched' | 'ringing', session_id, conversation_id, partner_id, ... }. */
export async function requestMatch(mode, interests = [], languages = []) {
  const { data, error } = await supabase.rpc('request_match', {
    p_mode: mode, p_interests: interests, p_languages: languages,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function leaveMatchQueue() {
  const { error } = await supabase.rpc('leave_match_queue');
  if (error) throw error;
}

/** reason: 'ended' | 'next' | 'disconnected' | 'declined' | 'reported' */
export async function endMatchSession(sessionId, reason = 'ended') {
  const { error } = await supabase.rpc('end_match_session', { p_session_id: sessionId, p_reason: reason });
  if (error) throw error;
}

/* ---------- Realtime ---------- */

async function authorizeRealtime() {
  const session = await getSession();
  if (session) supabase.realtime.setAuth(session.access_token);
}

/**
 * Live database changes for everything the user can see (RLS filters them):
 * new/updated messages, read receipts, session changes and new matches.
 */
export async function subscribeToInbox(userId, handlers) {
  await authorizeRealtime();
  return supabase.channel(`inbox-${userId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => handlers.onMessage?.(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p) => handlers.onMessageUpdate?.(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_participants' }, (p) => handlers.onParticipant?.(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'match_sessions' }, (p) => handlers.onSession?.(p.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'match_session_participants', filter: `user_id=eq.${userId}` },
      (p) => handlers.onMatched?.(p.new))
    .subscribe((status) => handlers.onStatus?.(status));
}

/** Private broadcast channel for typing indicators in one conversation. */
export async function joinTypingChannel(conversationId, onTyping) {
  await authorizeRealtime();
  const channel = supabase.channel(`conversation:${conversationId}`, {
    config: { private: true, broadcast: { self: false } },
  });
  channel.on('broadcast', { event: 'typing' }, ({ payload }) => onTyping(payload)).subscribe();
  return {
    // only over the open socket; before it joins, send() would fall back to an HTTP request
    sendTyping: (userId) => {
      if (channel.state === 'joined') channel.send({ type: 'broadcast', event: 'typing', payload: { user_id: userId } });
    },
    leave: () => supabase.removeChannel(channel),
  };
}

export function leaveChannel(channel) {
  if (channel) supabase.removeChannel(channel);
}
