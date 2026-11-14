// Run before page rendering; keep this small fallback aligned with appearance.ts.
(function () {
  var preference = 'system';
  try {
    var saved = localStorage.getItem('scratchtree.appearance');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch (_) {
    // A blocked preference store must not block rendering.
  }
  var theme = preference;
  if (preference === 'system') {
    theme = matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  document.documentElement.dataset.appearance = preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
