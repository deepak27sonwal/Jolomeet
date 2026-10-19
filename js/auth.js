// Login, register and reset-password pages.
import { initApp, toast } from './app.js';
import * as api from './api.js';
import * as v from './validation.js';

const SPRITE = 'assets/icons/sprite.svg';
const page = document.body.dataset.page;
const nextPage = api.safeNextPage(new URLSearchParams(window.location.search).get('next'));

initApp();
initPasswordToggles();

if (page === 'login') initLogin();
if (page === 'register') initRegister();
if (page === 'reset-password') initResetPassword();

/* ================= Login ================= */

async function initLogin() {
  await redirectIfSignedIn();

  const panels = { reset: 'reset-email', login: 'login-email' };
  document.querySelectorAll('[data-show-panel]').forEach((btn) => {
    btn.addEventListener('click', () => showPanel(btn.dataset.showPanel, panels[btn.dataset.showPanel]));
  });
  const fromHash = window.location.hash.slice(1);
  if (fromHash in panels && fromHash !== 'login') showPanel(fromHash, panels[fromHash]);

  if (new URLSearchParams(window.location.search).has('confirmed')) {
    showAlert('login-alert', 'success', 'Your email is confirmed. Log in to get started!');
  }

  // --- email + password ---
  const loginForm = document.getElementById('login-form');
  const email = document.getElementById('login-email');
  const password = document.getElementById('login-password');
  const rules = [[email, () => v.validateEmail(email.value)],
                 [password, () => (password.value ? '' : 'Enter your password.')]];
  liveValidate(rules);

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert('login-alert');
    if (!validateAll(rules)) return;
    const button = loginForm.querySelector('[type="submit"]');
    setLoading(button, true);
    try {
      await api.signIn({ email: email.value.trim(), password: password.value });
      window.location.assign(nextPage);
    } catch (error) {
      setLoading(button, false);
      if (error.code === 'email_not_confirmed') {
        showAlert('login-alert', 'info', 'Please confirm your email first. Check your inbox for the link.', {
          label: 'Resend email',
          onClick: () => resend(email.value.trim(), 'login-alert'),
        });
      } else {
        showAlert('login-alert', 'error', friendlyError(error));
      }
    }
  });

  // --- forgot password ---
  const resetForm = document.getElementById('reset-form');
  const resetEmail = document.getElementById('reset-email');
  const resetRules = [[resetEmail, () => v.validateEmail(resetEmail.value)]];
  liveValidate(resetRules);

  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert('reset-alert');
    if (!validateAll(resetRules)) return;
    const button = resetForm.querySelector('[type="submit"]');
    setLoading(button, true);
    try {
      await api.sendPasswordReset(resetEmail.value.trim());
      // Same message whether or not the account exists, so emails can't be probed.
      showAlert('reset-alert', 'success',
        `If an account exists for ${resetEmail.value.trim()}, a reset link is on its way. Check your inbox and spam folder.`);
      resetForm.reset();
    } catch (error) {
      showAlert('reset-alert', 'error', friendlyError(error));
    } finally {
      setLoading(button, false);
    }
  });
}

/* ================= Register ================= */

async function initRegister() {
  await redirectIfSignedIn();

  const form = document.getElementById('register-form');
  const name = document.getElementById('register-name');
  const email = document.getElementById('register-email');
  const password = document.getElementById('register-password');
  const birthDate = document.getElementById('register-birth-date');
  const terms = document.getElementById('register-terms');
  const meter = document.getElementById('password-strength');
  setBirthDateLimits(birthDate);

  password.addEventListener('input', () => {
    meter.dataset.score = String(password.value ? v.passwordStrength(password.value) : 0);
  });

  const guest = await currentGuest();
  if (guest) {
    initGuestUpgrade(guest, { form, name, email, terms });
    return;
  }

  const rules = [
    [name, () => v.validateDisplayName(name.value)],
    [email, () => v.validateEmail(email.value)],
    [password, () => v.validatePassword(password.value)],
    [birthDate, () => v.validateBirthDate(birthDate.value)],
    [terms, () => (terms.checked ? '' : 'Please confirm you are 18+ and agree to the terms.')],
  ];
  liveValidate(rules);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert('register-alert');
    if (!validateAll(rules)) return;
    const button = form.querySelector('[type="submit"]');
    setLoading(button, true);
    try {
      const { session } = await api.signUp({
        displayName: name.value.trim(),
        email: email.value.trim(),
        password: password.value,
        birthDate: birthDate.value,
      });
      if (session) {
        window.location.assign(nextPage); // email confirmation is switched off
        return;
      }
      document.getElementById('sent-to').textContent = email.value.trim();
      showPanel('check-email');
    } catch (error) {
      setLoading(button, false);
      showAlert('register-alert', 'error', friendlyError(error));
    }
  });

  document.getElementById('resend-button').addEventListener('click', () => resend(email.value.trim(), 'resend-alert'));
}

/** The signed-in guest user, or null for visitors and full accounts. */
async function currentGuest() {
  try {
    const session = await api.getSession();
    return session?.user.is_anonymous ? session.user : null;
  } catch {
    return null;
  }
}

/**
 * Guests keep their account: we link an email to it instead of creating a new
 * one. Their age is already confirmed, and the password is chosen after the
 * email link is opened, so this form only asks for a name and an email.
 */
function initGuestUpgrade(user, { form, name, email, terms }) {
  document.getElementById('guest-upgrade-note').hidden = false;
  form.querySelectorAll('[data-full-only]').forEach((field) => {
    field.hidden = true;
    field.querySelectorAll('input').forEach((input) => { input.required = false; });
  });
  document.querySelector('[data-panel="register"] h1').textContent = 'Keep your chats';
  document.querySelector('[data-panel="register"] .auth__header p').textContent =
    'Create your free account to get a profile, make connections and never lose a conversation.';
  document.querySelector('.auth__switch').hidden = true;

  const rules = [
    [name, () => v.validateDisplayName(name.value)],
    [email, () => v.validateEmail(email.value)],
    [terms, () => (terms.checked ? '' : 'Please agree to the terms to continue.')],
  ];
  liveValidate(rules);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert('register-alert');
    if (!validateAll(rules)) return;
    const button = form.querySelector('[type="submit"]');
    setLoading(button, true);
    try {
      await api.upgradeGuest({ userId: user.id, displayName: name.value.trim(), email: email.value.trim() });
    } catch (error) {
      setLoading(button, false);
      showAlert('register-alert', 'error', friendlyError(error));
      return;
    }
    const sentTo = document.createElement('strong');
    sentTo.textContent = email.value.trim();
    document.getElementById('check-email-text').replaceChildren(
      'We sent a link to ', sentTo,
      '. Open it to confirm your email and choose a password. Until then you can keep chatting as you are.',
    );
    const next = document.getElementById('check-email-next');
    next.href = 'chat.html';
    next.textContent = 'Keep Chatting';
    showPanel('check-email');
  });

  const resendButton = document.getElementById('resend-button');
  resendButton.addEventListener('click', async () => {
    try {
      await api.resendGuestUpgrade(email.value.trim());
      showAlert('resend-alert', 'success', `We sent a new link to ${email.value.trim()}.`);
    } catch (error) {
      showAlert('resend-alert', 'error', friendlyError(error));
    }
  });
}

/* ================= Reset password ================= */

async function initResetPassword() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const queryParams = new URLSearchParams(window.location.search);
  if (hashParams.has('error') || queryParams.has('error')) {
    showPanel('invalid-link');
    return;
  }

  // The reset link signs the user in with a short-lived recovery session.
  const ready = new Promise((resolve) => {
    api.onAuthChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) resolve(true);
    });
    setTimeout(() => resolve(false), 4000);
  });
  const hasSession = Boolean(await api.getSession()) || (await ready);
  if (!hasSession) {
    showPanel('invalid-link');
    return;
  }
  // someone who chatted without an account and just confirmed their email is choosing their first password
  const finishing = queryParams.has('finish');
  if (finishing) {
    document.querySelector('[data-panel="new-password"] h1').textContent = 'Create your password';
    document.querySelector('[data-panel="new-password"] .auth__header p').textContent =
      'Your email is confirmed. Choose a password to finish your account.';
  }
  showPanel('new-password', 'new-password');

  const form = document.getElementById('new-password-form');
  const password = document.getElementById('new-password');
  const confirm = document.getElementById('confirm-password');
  const rules = [[password, () => v.validatePassword(password.value)],
                 [confirm, () => v.validatePasswordMatch(password.value, confirm.value)]];
  liveValidate(rules);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert('new-password-alert');
    if (!validateAll(rules)) return;
    const button = form.querySelector('[type="submit"]');
    setLoading(button, true);
    try {
      await api.updatePassword(password.value);
      toast(finishing ? 'Your account is ready. Welcome to JoloMeet!' : 'Password updated. Welcome back!', { type: 'success' });
      setTimeout(() => window.location.assign(finishing ? 'profile.html' : 'index.html'), 1200);
    } catch (error) {
      setLoading(button, false);
      showAlert('new-password-alert', 'error', friendlyError(error));
    }
  });
}

/* ================= Shared helpers ================= */

async function redirectIfSignedIn() {
  try {
    const session = await api.getSession();
    if (session && !session.user.is_anonymous) window.location.replace(nextPage);
  } catch {
    /* stay on the page */
  }
}

async function resend(email, alertId) {
  try {
    await api.resendConfirmation(email);
    showAlert(alertId, 'success', `We sent a new confirmation link to ${email}.`);
  } catch (error) {
    showAlert(alertId, 'error', friendlyError(error));
  }
}

function showPanel(name, focusId) {
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  const target = focusId ? document.getElementById(focusId)
                         : document.querySelector(`[data-panel="${name}"] h1`);
  if (target) {
    if (!focusId) target.setAttribute('tabindex', '-1');
    target.focus();
  }
}

function initPasswordToggles() {
  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    const input = document.getElementById(btn.dataset.togglePassword);
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.querySelector('use').setAttribute('href', `${SPRITE}#${show ? 'eye-off' : 'eye'}`);
    });
  });
}

function setBirthDateLimits(input) {
  input.max = v.latestAllowedBirthDate();
  input.min = '1900-01-01';
}

/** Validate on blur; once a field has shown an error, re-check it as the user types. */
function liveValidate(rules) {
  rules.forEach(([input, check]) => {
    const evt = input.type === 'checkbox' ? 'change' : 'blur';
    input.addEventListener(evt, () => setFieldError(input, check()));
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') setFieldError(input, check());
    });
  });
}

function validateAll(rules) {
  let firstInvalid = null;
  rules.forEach(([input, check]) => {
    const message = check();
    setFieldError(input, message);
    if (message && !firstInvalid) firstInvalid = input;
  });
  firstInvalid?.focus();
  return !firstInvalid;
}

function setFieldError(input, message) {
  input.setAttribute('aria-invalid', String(Boolean(message)));
  const el = document.getElementById(`${input.id}-error`);
  if (!el) return;
  el.replaceChildren();
  if (message) el.append(iconEl('alert'), document.createTextNode(message));
}

function showAlert(id, type, message, action) {
  const el = document.getElementById(id);
  el.className = `alert alert--${type}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.replaceChildren(iconEl(type === 'success' ? 'check-circle' : 'alert'), text);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    text.append(' ', btn);
  }
  el.hidden = false;
}

function hideAlert(id) {
  document.getElementById(id).hidden = true;
}

function setLoading(button, loading) {
  button.classList.toggle('is-loading', loading);
  button.disabled = loading;
  button.setAttribute('aria-busy', String(loading));
}

function iconEl(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `${SPRITE}#${name}`);
  svg.append(use);
  return svg;
}

/** Turns Supabase / network errors into messages people can act on. */
function friendlyError(error) {
  const code = error?.code || '';
  const message = error?.message || '';
  if (error instanceof TypeError || /failed to fetch|network/i.test(message)) {
    return "We can't reach JoloMeet right now. Check your connection and try again.";
  }
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) {
    return "That email and password don't match. Try again, or reset your password.";
  }
  if (code === 'user_already_exists' || /already registered/i.test(message)) {
    return 'An account with this email already exists. Try logging in instead.';
  }
  if (code === 'email_exists' || /already been registered/i.test(message)) {
    return 'That email already has an account. Log in to it instead (chats from this session stay here).';
  }
  if (/anonymous user/i.test(message)) return 'Open the link we emailed you first, then choose your password.';
  if (code === 'weak_password') return 'That password is too easy to guess. Try a longer one with a mix of characters.';
  if (code === 'same_password') return 'Your new password must be different from your old one.';
  if (code === 'anonymous_provider_disabled') return "Guest access isn't available right now. Please create a free account instead.";
  if (code === 'signup_disabled') return "New sign-ups are paused right now. Please try again later.";
  if (code.startsWith('over_') || error?.status === 429) return 'Too many attempts. Please wait a minute and try again.';
  if (code === 'JM403') return message; // e.g. the 18+ age check from the database
  return 'Something went wrong. Please try again.';
}
