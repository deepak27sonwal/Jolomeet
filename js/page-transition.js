// Page switch effect: the new page slides in from the right; going back in
// history slides it in from the left. Loaded as a plain blocking script in
// <head> so the listeners exist before the first frame is shown.
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  function isBack(activation) {
    return Boolean(activation && activation.navigationType === 'traverse'
      && activation.from && activation.entry && activation.from.index > activation.entry.index);
  }

  function markBack(transition, activation) {
    if (transition && transition.types && isBack(activation)) transition.types.add('back');
  }

  if ('CSSViewTransitionRule' in window) {
    // the old page and the new page each pick the direction for their half
    window.addEventListener('pageswap', function (event) { markBack(event.viewTransition, event.activation); });
    window.addEventListener('pagereveal', function (event) {
      markBack(event.viewTransition, window.navigation && window.navigation.activation);
    });
    return;
  }

  // browsers without view transitions: slide the content in after moving between our own pages
  try {
    if (document.referrer && new URL(document.referrer).origin === window.location.origin) {
      document.documentElement.classList.add('page-enter');
    }
  } catch (error) {
    /* no animation */
  }
})();
