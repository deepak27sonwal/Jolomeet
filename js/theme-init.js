// Light or dark theme, set before the first paint so pages never flash white.
// A choice saved with the header toggle wins; otherwise follow the device.
// Loaded as a plain blocking script in <head>; js/navigation.js adds the toggle.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('jolomeet:theme'); } catch (error) { /* storage blocked */ }
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
