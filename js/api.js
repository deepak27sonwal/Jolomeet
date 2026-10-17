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

export async function reportUser({ reportedUserId, context, reason, details }) {
  const { error } = await supabase.from('reports').insert({
    reported_user_id: reportedUserId,
    context,
    reason,
    details: details || null,
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
