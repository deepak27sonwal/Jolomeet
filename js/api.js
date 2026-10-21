// Single place that talks to Supabase. Pages import functions from here
// instead of building queries themselves.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/** Interest catalogue for the "What's your vibe?" picker shown before matching, featured first. */
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

export const GENDERS = { female: 'Female', male: 'Male', nonbinary: 'Non-binary' };

/**
 * Random chat without an account: an anonymous session created with the
 * visitor's name, gender and age (no email or password). The age is stored as
 * an approximate birth date so the database's 18+ checks apply, and it is shown
 * to the people they match with. gender: a GENDERS key, or '' to not say.
 */
export async function startRandomSession({ name, gender, age }) {
  const birth = new Date();
  birth.setFullYear(birth.getFullYear() - age);
  birth.setDate(birth.getDate() - 182); // middle of that year of age
  const { error } = await supabase.auth.signInAnonymously({
    options: {
      data: {
        display_name: name,
        gender: gender || null,
        birth_date: birth.toISOString().slice(0, 10),
        show_age: 'true',
        accepted_terms: 'true',
      },
    },
  });
  if (error) throw error;
}

/**
 * Turns the signed-in guest into a full account without losing their chats.
 * The email is confirmed by link; that link opens the page where they choose a
 * password (the server only allows a password once the email is confirmed).
 */
export async function upgradeGuest({ userId, displayName, email }) {
  const { error: nameError } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', userId);
  if (nameError) throw nameError;
  const { error } = await supabase.auth.updateUser(
    { email, data: { display_name: displayName } },
    { emailRedirectTo: authRedirect('reset-password.html?finish=1') },
  );
  if (error) throw error;
}

export async function resendGuestUpgrade(email) {
  const { error } = await supabase.auth.resend({
    type: 'email_change',
    email,
    options: { emailRedirectTo: authRedirect('reset-password.html?finish=1') },
  });
  if (error) throw error;
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

/** Gender label for someone you can see (e.g. your current match), or '' if not given. */
export async function getGenderLabel(userId) {
  const { data, error } = await supabase.from('profiles').select('gender').eq('id', userId).maybeSingle();
  if (error) throw error;
  return GENDERS[data?.gender] || '';
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

const MESSAGE_FIELDS = 'id, conversation_id, sender_id, client_id, kind, body, attachment_path, reply_to_id, created_at, deleted_at';

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
export async function sendMessage({ conversationId, clientId, body, kind = 'text', attachmentPath = null, replyToId = null }) {
  const row = { conversation_id: conversationId, client_id: clientId, kind, body: body || null, attachment_path: attachmentPath };
  if (replyToId) row.reply_to_id = replyToId; // only sent when replying, so other callers are unaffected
  const { data, error } = await supabase.from('messages')
    .insert(row)
    .select(MESSAGE_FIELDS)
    .single();
  if (error) throw error;
  return data;
}

/** Deletes your own message for everyone: the database clears its text and
 *  attachment (it then shows as "Message deleted"), and the photo or voice file is removed. */
export async function deleteMessage(id, attachmentPath = null) {
  const { data, error } = await supabase.from('messages')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .select(MESSAGE_FIELDS)
    .single();
  if (error) throw error;
  if (attachmentPath) await supabase.storage.from('chat-attachments').remove([attachmentPath]); // best effort
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

const ATTACHMENT_EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
};

/** Photo or voice note for a chat. Stored at <conversation>/<sender>/<file> in the private bucket. */
export async function uploadChatAttachment(conversationId, userId, blob, type = blob.type) {
  const baseType = String(type).split(';')[0]; // "audio/webm;codecs=opus" → "audio/webm"
  const ext = ATTACHMENT_EXTENSIONS[baseType];
  if (!ext) throw new Error(`Unsupported file type: ${baseType}`);
  const path = `${conversationId}/${userId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('chat-attachments')
    .upload(path, blob, { contentType: baseType, upsert: false });
  if (error) throw error;
  return path;
}

export function uploadChatImage(conversationId, userId, file) {
  return uploadChatAttachment(conversationId, userId, file);
}

/** Chat photos and voice notes live in a private bucket, so they are loaded through short-lived signed links. */
export async function chatAttachmentUrl(path) {
  const { data, error } = await supabase.storage.from('chat-attachments').createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

export const chatImageUrl = chatAttachmentUrl;

/* ---------- Matchmaking ---------- */

/** Returns { status: 'waiting' | 'matched' | 'ringing', session_id, conversation_id, partner_id, ... }. */
export async function requestMatch(mode, interests = [], languages = []) {
  const { data, error } = await supabase.rpc('request_match', {
    p_mode: mode, p_interests: interests, p_languages: languages,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * "Stay in touch" with the person from a random match. Private until both tap it.
 * Returns 'waiting' | 'mutual' (now connected) | 'mutual_needs_account'.
 */
export async function stayInTouch(sessionId) {
  const { data, error } = await supabase.rpc('stay_in_touch', { p_session_id: sessionId });
  if (error) throw error;
  return data;
}

/** Whether you already tapped "Stay in touch" for this session (you can only ever see your own taps). */
export async function didStayInTouch(sessionId) {
  const { data, error } = await supabase.from('match_likes').select('session_id').eq('session_id', sessionId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
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
/**
 * Private broadcast channel for one conversation: typing indicators, plus small
 * signals between the two people (e.g. "it's mutual").
 */
export async function joinConversationChannel(conversationId, { onTyping, onSignal } = {}) {
  await authorizeRealtime();
  const channel = supabase.channel(`conversation:${conversationId}`, {
    config: { private: true, broadcast: { self: false } },
  });
  channel
    .on('broadcast', { event: 'typing' }, ({ payload }) => onTyping?.(payload))
    .on('broadcast', { event: 'signal' }, ({ payload }) => onSignal?.(payload))
    .subscribe();
  return {
    // only over the open socket; before it joins, send() would fall back to an HTTP request
    sendTyping: (userId) => {
      if (channel.state === 'joined') channel.send({ type: 'broadcast', event: 'typing', payload: { user_id: userId } });
    },
    sendSignal: (payload) => channel.send({ type: 'broadcast', event: 'signal', payload }),
    leave: () => supabase.removeChannel(channel),
  };
}

export function joinTypingChannel(conversationId, onTyping) {
  return joinConversationChannel(conversationId, { onTyping });
}

/**
 * Private broadcast channel shared by the two people in a match session, used
 * to exchange WebRTC offers, answers and network candidates. Only the session's
 * participants can join (Realtime authorization in the database).
 */
export async function joinMatchChannel(sessionId, onSignal, onStatus) {
  await authorizeRealtime();
  const channel = supabase.channel(`match:${sessionId}`, {
    config: { private: true, broadcast: { self: false, ack: false } },
  });
  channel.on('broadcast', { event: 'signal' }, ({ payload }) => onSignal(payload))
    .subscribe((status) => onStatus?.(status));
  return {
    send: (payload) => channel.send({ type: 'broadcast', event: 'signal', payload }),
    leave: () => supabase.removeChannel(channel),
  };
}

export function leaveChannel(channel) {
  if (channel) supabase.removeChannel(channel);
}
