// Form validation shared by every form. Each validator returns an error
// message, or '' when the value is valid. The server re-checks everything.

export const MIN_AGE = 18;

export function validateEmail(value) {
  const email = value.trim();
  if (!email) return 'Enter your email address.';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return 'Enter a valid email address, like name@example.com.';
  }
  return '';
}

export function validatePassword(value) {
  if (!value) return 'Enter a password.';
  if (value.length < 8) return 'Use at least 8 characters.';
  if (value.length > 72) return 'Use 72 characters or fewer.';
  if (!/[a-z]/i.test(value) || !/\d/.test(value)) return 'Include at least one letter and one number.';
  return '';
}

export function validatePasswordMatch(password, confirm) {
  if (!confirm) return 'Confirm your password.';
  return password === confirm ? '' : "Passwords don't match.";
}

export function validateDisplayName(value) {
  const name = value.trim();
  if (!name) return 'Enter a display name.';
  if (name.length > 40) return 'Use 40 characters or fewer.';
  return '';
}

/** Latest birth date (YYYY-MM-DD) that is at least MIN_AGE years ago. */
export function latestAllowedBirthDate(today = new Date()) {
  const d = new Date(today.getFullYear() - MIN_AGE, today.getMonth(), today.getDate());
  return toIsoDate(d);
}

export function validateBirthDate(value) {
  if (!value) return 'Enter your date of birth.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') return 'Enter a valid date of birth.';
  if (value > latestAllowedBirthDate()) return `You must be ${MIN_AGE} or older to use JoloMeet.`;
  return '';
}

/** 0-4 score for the password strength meter. */
export function passwordStrength(value) {
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 12) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\d/.test(value) && /[^a-z0-9]/i.test(value)) score++;
  return score;
}

function toIsoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
