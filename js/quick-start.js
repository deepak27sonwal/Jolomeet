// "About you" form for random chat, audio and video: name, gender and age,
// then straight in. No email, password or sign-up step.
import * as api from './api.js';
import { validateDisplayName } from './validation.js';
import { icon, esc, setLoading } from './ui.js';
import { refreshAuthHeader } from './app.js';

const MIN_AGE = 18;
const MAX_AGE = 99;
const GENDER_CHOICES = [...Object.entries(api.GENDERS), ['', 'Prefer not to say']];

/**
 * Shows the form inside `container` and resolves with the new session once the
 * visitor has filled it in. `action` is the button label, e.g. "Start Video Chat".
 */
export function askAboutYou(container, { action = 'Start Chatting', next = '' } = {}) {
  container.innerHTML = `
    <form class="about-you" novalidate>
      <span class="about-you__badge">${icon('sparkles', 'icon icon--sm')}No sign-up needed</span>
      <h1>Tell people a little about you</h1>
      <p class="about-you__lead">This is what the people you meet will see.</p>
      <div class="alert" role="alert" hidden></div>

      <div class="field">
        <label class="field__label" for="about-name">Your name</label>
        <input class="input input--plain" id="about-name" name="name" type="text" maxlength="40"
          autocomplete="nickname" placeholder="e.g. Aisha" required aria-describedby="about-name-error">
        <p class="field__error" id="about-name-error"></p>
      </div>

      <fieldset class="field about-you__gender" aria-describedby="about-gender-error">
        <legend class="field__label">Gender</legend>
        <div class="about-you__choices">
          ${GENDER_CHOICES.map(([value, label], i) => `
            <label class="choice"><input type="radio" name="gender" value="${value}"${i === 0 ? ' required' : ''}><span>${esc(label)}</span></label>`).join('')}
        </div>
        <p class="field__error" id="about-gender-error"></p>
      </fieldset>

      <div class="field about-you__age">
        <label class="field__label" for="about-age">Age</label>
        <input class="input input--plain" id="about-age" name="age" type="number" inputmode="numeric"
          min="${MIN_AGE}" max="${MAX_AGE}" placeholder="18+" required aria-describedby="about-age-error">
        <p class="field__error" id="about-age-error"></p>
      </div>

      <button class="btn btn--primary btn--lg btn--block" type="submit">${esc(action)}${icon('arrow-right', 'icon icon--sm')}</button>
      <p class="about-you__legal">By continuing you confirm you're ${MIN_AGE} or older and agree to the
        <a href="terms.html">Terms</a> and <a href="guidelines.html">Community Guidelines</a>.</p>
      <p class="about-you__login">Have an account? <a href="login.html${next ? `?next=${encodeURIComponent(next)}` : ''}">Log in</a></p>
    </form>`;

  const form = container.querySelector('form');
  const name = form.elements.name;
  const age = form.elements.age;

  const checks = {
    name: () => validateDisplayName(name.value),
    gender: () => (form.querySelector('[name="gender"]:checked') ? '' : 'Choose an option.'),
    age: () => {
      const n = Number(age.value);
      if (!age.value) return 'Enter your age.';
      if (!Number.isInteger(n) || n > MAX_AGE) return 'Enter a valid age.';
      if (n < MIN_AGE) return `You must be ${MIN_AGE} or older to use JoloMeet.`;
      return '';
    },
  };
  const show = (field, message) => {
    const el = document.getElementById(`about-${field}-error`);
    el.replaceChildren();
    if (message) el.insertAdjacentHTML('beforeend', `${icon('alert')}${esc(message)}`);
    if (field !== 'gender') form.elements[field].setAttribute('aria-invalid', String(Boolean(message)));
  };

  // on leaving a field, only point out mistakes in what was typed: an error that
  // appears for an empty field would shift the form under the next tap
  name.addEventListener('blur', () => { if (name.value.trim()) show('name', checks.name()); });
  age.addEventListener('blur', () => { if (age.value) show('age', checks.age()); });
  name.addEventListener('input', () => show('name', ''));
  age.addEventListener('input', () => show('age', ''));
  form.addEventListener('change', (e) => { if (e.target.name === 'gender') show('gender', ''); });
  setTimeout(() => name.focus(), 50);

  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      let first = null;
      for (const field of ['name', 'gender', 'age']) {
        const message = checks[field]();
        show(field, message);
        if (message && !first) first = field;
      }
      if (first) {
        (first === 'gender' ? form.querySelector('[name="gender"]') : form.elements[first]).focus();
        return;
      }
      const alert = form.querySelector('.alert');
      alert.hidden = true;
      const button = form.querySelector('[type="submit"]');
      setLoading(button, true);
      try {
        await api.startRandomSession({
          name: name.value.trim(),
          gender: form.querySelector('[name="gender"]:checked').value,
          age: Number(age.value),
        });
        const session = await api.getSession();
        refreshAuthHeader();
        resolve(session);
      } catch (error) {
        setLoading(button, false);
        alert.className = 'alert alert--error';
        alert.innerHTML = icon('alert');
        alert.append(document.createTextNode(startError(error)));
        alert.hidden = false;
      }
    });
  });
}

function startError(error) {
  const code = error?.code || '';
  if (error instanceof TypeError || /failed to fetch|network/i.test(error?.message || '')) {
    return "We can't reach JoloMeet right now. Check your connection and try again.";
  }
  if (code === 'anonymous_provider_disabled') return "Random chat without an account isn't switched on yet. Please log in or create an account.";
  if (code.startsWith('over_') || error?.status === 429) return 'Too many attempts. Please wait a minute and try again.';
  return 'Something went wrong. Please try again.';
}
