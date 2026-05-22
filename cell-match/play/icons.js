'use strict';
// Cell Match — SVG icon registry.
// Each icon is a self-contained SVG string. We attach icons to elements that
// declare a `data-icon="name"` attribute, prepending the SVG before their text
// content. Elements with `data-icon-only` get the SVG without surrounding text.
//
// The icons use currentColor for fill so they pick up the parent's text color.

(function () {
  const ICONS = {
    // 5-point star (filled, slightly rounded). Used as a "shine"/highlight mark.
    star: `<svg class="qm-icon icon-star" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.6 L14.7 8.5 L21.1 9.2 L16.3 13.6 L17.6 19.9 L12 16.7 L6.4 19.9 L7.7 13.6 L2.9 9.2 L9.3 8.5 Z"/>
    </svg>`,
    // Share icon: arrow rising out of an open box with rounded corners.
    // Stroked geometry reads cleaner than a filled silhouette at button size.
    share: `<svg class="qm-icon icon-share" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 14 V4"/>
      <path d="M8 7 L12 3 L16 7"/>
      <path d="M5 12 V18 A2 2 0 0 0 7 20 L17 20 A2 2 0 0 0 19 18 V12"/>
    </svg>`,
    // Restart: refresh arrow. A clockwise arc that breaks at the top and
    // terminates in a small wedge arrowhead. Drawn at viewBox 24, stroked
    // 2.2 for visibility on the gradient button.
    restart: `<svg class="qm-icon icon-restart" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 12 A8 8 0 1 1 12 4"/>
      <path d="M12 1 L15 4 L12 7"/>
    </svg>`,
    // Play / revive triangle.
    play: `<svg class="qm-icon icon-play" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4 L20 12 L7 20 Z"/>
    </svg>`,
    // Sound on: speaker with two sound waves.
    sound: `<svg class="qm-icon icon-sound" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9 L4 15 L8 15 L13 19 L13 5 L8 9 Z"/>
      <path d="M16 8 Q19 12 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M18 5 Q23 12 18 19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
    // Vibration: phone shape with wavy side lines.
    vibration: `<svg class="qm-icon icon-vibration" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="4" width="6" height="16" rx="1.2"/>
      <path d="M5 8 L5 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
      <path d="M2.5 10 L2.5 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
      <path d="M19 8 L19 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
      <path d="M21.5 10 L21.5 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
    </svg>`,
    // Book / tutorial: open book outline.
    book: `<svg class="qm-icon icon-book" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 5 Q3 4 4 4 L10 4 Q12 4 12 6 L12 20 Q12 18 10 18 L4 18 Q3 18 3 17 Z"/>
      <path d="M21 5 Q21 4 20 4 L14 4 Q12 4 12 6 L12 20 Q12 18 14 18 L20 18 Q21 18 21 17 Z"/>
    </svg>`,
    // Hamburger menu: three centered horizontal bars.
    menu: `<svg class="qm-icon icon-menu" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="6" width="16" height="2.4" rx="1.2"/>
      <rect x="4" y="10.8" width="16" height="2.4" rx="1.2"/>
      <rect x="4" y="15.6" width="16" height="2.4" rx="1.2"/>
    </svg>`,
    // Check mark, bold rounded.
    check: `<svg class="qm-icon icon-check" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12.5 L10 17.5 L19 7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  };

  function applyIcons(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-icon]').forEach((el) => {
      const name = el.getAttribute('data-icon');
      const svg = ICONS[name];
      if (!svg) return;
      // Idempotent: remove any previously injected icon span before adding a new one.
      const existing = el.querySelector(':scope > .qm-icon-slot');
      if (existing) existing.remove();
      const slot = document.createElement('span');
      slot.className = 'qm-icon-slot';
      slot.setAttribute('aria-hidden', 'true');
      slot.innerHTML = svg;
      // For text-bearing elements we prepend the icon so it sits before the label.
      el.insertBefore(slot, el.firstChild);
    });
  }

  window.QSIcons = {
    apply: applyIcons,
    ICONS,
  };

  document.addEventListener('DOMContentLoaded', () => applyIcons());
  window.addEventListener('qsLangChanged', () => applyIcons());
})();
