// Header, mobile menu and bottom navigation behaviour shared by every page.

export function initNavigation() {
  markActiveLinks(document.body.dataset.page);
  initHeaderShadow();
  initMobileMenu();
  initThemeToggle();
}

function markActiveLinks(page) {
  if (!page) return;
  document.querySelectorAll(`[data-nav="${page}"]`).forEach((link) => {
    link.setAttribute('aria-current', 'page');
  });
}

function initHeaderShadow() {
  const header = document.querySelector('.site-header');
  if (!header) return;
  const update = () => header.classList.toggle('is-scrolled', window.scrollY > 4);
  update();
  window.addEventListener('scroll', update, { passive: true });
}

function initMobileMenu() {
  const toggle = document.querySelector('.menu-toggle');
  const menu = document.getElementById(toggle?.getAttribute('aria-controls'));
  if (!toggle || !menu) return;

  const icon = toggle.querySelector('use');
  const desktop = window.matchMedia('(min-width: 961px)');

  const setOpen = (open) => {
    menu.classList.toggle('is-open', open);
    document.body.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    icon?.setAttribute('href', `assets/icons/sprite.svg#${open ? 'close' : 'menu'}`);
    if (open) menu.querySelector('a, button')?.focus();
  };

  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.classList.contains('is-open')) {
      setOpen(false);
      toggle.focus();
    }
  });

  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });

  desktop.addEventListener('change', (event) => {
    if (event.matches) setOpen(false);
  });
}

// Sun/moon button in the header. js/theme-init.js has already applied the saved
// or device theme; this switches it and remembers the choice on this device.
const THEME_KEY = 'jolomeet:theme';
const THEME_COLORS = { light: '#E91E78', dark: '#160E28' };

function initThemeToggle() {
  const header = document.querySelector('.site-header__inner');
  if (!header) return;
  const root = document.documentElement;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button theme-toggle';
  button.innerHTML = '<svg class="icon icon-sun" aria-hidden="true"><use href="assets/icons/sprite.svg#sun"/></svg>'
    + '<svg class="icon icon-moon" aria-hidden="true"><use href="assets/icons/sprite.svg#moon"/></svg>';
  header.insertBefore(button, header.querySelector('.menu-toggle'));

  const meta = document.querySelector('meta[name="theme-color"]');
  const show = (theme) => {
    root.dataset.theme = theme;
    const dark = theme === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = dark ? 'Light mode' : 'Dark mode';
    meta?.setAttribute('content', THEME_COLORS[theme]);
  };
  show(root.dataset.theme === 'dark' ? 'dark' : 'light');

  button.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    show(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked: applies to this page only */ }
  });

  // follow the device while the person hasn't picked a theme themselves
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage blocked */ }
    if (!saved) show(event.matches ? 'dark' : 'light');
  });
}
