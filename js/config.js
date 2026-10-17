// Public Supabase settings. The publishable key is designed to ship to browsers:
// every table is protected by Row Level Security. Never put the service-role
// (secret) key in frontend code.
export const SUPABASE_URL = 'https://kdzmknibhsnxbaayzasp.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_h9Rw_Ny6Ax2YdhitEFsJrw_8xwTmqAQ';

export const STORAGE_KEYS = {
  interests: 'jolomeet:interests',
};

// WebRTC servers used to connect two callers. These public STUN servers work
// for most home and mobile networks; very strict networks also need a TURN
// relay (add { urls: 'turn:…', username, credential } from a TURN provider).
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
