(function () {
  'use strict';

  const clampNumber = (value, min, max, fallback) => {
    const num = Number(value);
    if (Number.isNaN(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  };

  const target = window.KawaiiUtils || {};
  target.clampNumber = clampNumber;
  window.KawaiiUtils = target;
})();
