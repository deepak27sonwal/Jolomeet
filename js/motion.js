// Homepage scroll reveal: sections slide in as they come into view.
// Content stays fully visible without JavaScript or with reduced motion.

const TARGETS = [
  '.section-header',
  '.way',
  '.feature-card',
  '.step',
  '.cta',
  '.site-footer__grid > *',
].join(',');

const STAGGER_MS = 90;
const MAX_STAGGER = 4;

export function initReveal() {
  if (document.body.dataset.page !== 'home') return; // other pages don't animate
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const elements = [...document.querySelectorAll(TARGETS)];
  if (!elements.length) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      observer.unobserve(el);
      el.classList.add('is-visible');
      // hand transitions back to the element's own styles (e.g. card hover) once revealed
      el.addEventListener('transitionend', () => {
        el.classList.remove('reveal', 'is-visible');
        el.style.removeProperty('--reveal-delay');
      }, { once: true });
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });

  for (const el of elements) {
    // stagger siblings that reveal together (cards in a grid, footer columns)
    const siblings = [...el.parentElement.children].filter((child) => elements.includes(child));
    const index = Math.min(siblings.indexOf(el), MAX_STAGGER);
    if (index > 0) el.style.setProperty('--reveal-delay', `${index * STAGGER_MS}ms`);
    el.classList.add('reveal');
    observer.observe(el);
  }
}
