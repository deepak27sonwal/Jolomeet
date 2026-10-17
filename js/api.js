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
