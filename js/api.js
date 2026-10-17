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
