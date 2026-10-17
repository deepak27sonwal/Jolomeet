// Header, mobile menu and bottom navigation behaviour shared by every page.

export function initNavigation() {
  markActiveLinks(document.body.dataset.page);
  initHeaderShadow();
  initMobileMenu();
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
