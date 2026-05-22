'use strict';

(function () {
  let ctx = null;
  let master = null;
  let enabled = true;
  let unlocked = false;
  let volume = 1.0;

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    return ctx;
  }

  // iOS WKWebView requires the AudioContext to be resumed inside a user
  // gesture AND for at least one buffer to actually play before sound
  // emerges. Without the warm-up buffer, the very first playTap on device
  // is silent even after resume() completes. Schedule a near-silent 1-sample
  // buffer the first time we unlock so subsequent tones come through.
  function unlock() {
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (unlocked) return;
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      if (typeof src.start === 'function') src.start(0);
      unlocked = true;
    } catch (_) { /* ignore */ }
  }
  ['pointerdown', 'touchstart', 'click'].forEach((ev) => {
    window.addEventListener(ev, unlock, { capture: true });
  });
  // The page may become inactive (background, screen lock) which puts the
  // context back into "interrupted"/"suspended" on iOS. Resume on the next
  // user interaction after the app comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') {
      ctx.resume().catch(() => {});
    }
  });

  function envelope(gain, start, attack, decay, peak = 1) {
    gain.gain.cancelScheduledValues(start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
  }

  function tone(freq, { type = 'sine', attack = 0.02, decay = 0.22, peak = 0.55, detune = 0, slideTo = null, slideTime = 0.1, delay = 0 } = {}) {
    if (!enabled || !ensureCtx()) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    const start = ctx.currentTime + delay;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo !== null) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, start + slideTime);
    }
    osc.detune.value = detune;
    osc.connect(g);
    g.connect(master);
    envelope(g, start, attack, decay, peak);
    osc.start(start);
    osc.stop(start + attack + decay + 0.02);
  }

  function noiseBurst({ duration = 0.22, peak = 0.35, filterFreq = 2500, filterType = 'bandpass', Q = 0.9, attack = 0.025, distort = 0, delay = 0 } = {}) {
    if (!enabled || !ensureCtx()) return;
    const start = ctx.currentTime + delay;
    const bufferSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    filter.Q.value = Q;
    const g = ctx.createGain();
    let chain = src;
    chain.connect(filter);
    chain = filter;
    if (distort > 0) {
      const ws = ctx.createWaveShaper();
      const curve = new Float32Array(256);
      const k = distort * 20;
      for (let i = 0; i < 256; i++) {
        const x = (i / 128) - 1;
        curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
      }
      ws.curve = curve;
      chain.connect(ws);
      chain = ws;
    }
    chain.connect(g);
    g.connect(master);
    envelope(g, start, attack, duration, peak);
    src.start(start);
    src.stop(start + duration + 0.02);
  }

  // ─── Game-facing sounds ───
  // Keep the original timbres (triangle/sawtooth/square) but pad the attacks
  // so each tone eases in rather than snapping. Peaks are lowered slightly
  // for the same reason — perceived sharpness, not pitch.
  const TAP_FREQS = { r: 520, b: 660, y: 780, g: 600, p: 720 };
  function playTap(color) {
    const f = TAP_FREQS[color] || 600;
    tone(f, { type: 'triangle', attack: 0.018, decay: 0.16, peak: 0.42 });
    tone(f * 2, { type: 'sine', attack: 0.02, decay: 0.08, peak: 0.13 });
  }

  // Combo streak → semitone offset (도레미파솔, C major pentatonic 1-5).
  // streak 0 (off-cycle, no combo) = 도, 1 = 레, 2 = 미, 3 = 파, 4+ = 솔 (cap).
  const COMBO_SEMITONES = [0, 2, 4, 5, 7];
  function comboPitchScale(streak) {
    const idx = Math.min(Math.max(streak | 0, 0), COMBO_SEMITONES.length - 1);
    return Math.pow(2, COMBO_SEMITONES[idx] / 12);
  }

  function playMatch(count, comboStreak = 1) {
    // Pitch is governed solely by combo streak (도레미파솔) — match size feeds
    // noise brightness only. Previously `base` was also scaled by `count`,
    // so a 4-match without a combo bled into the ×1 (레) pitch and the cue
    // stopped tracking combo cleanly.
    const base = 220 * comboPitchScale(comboStreak);
    const notes = [base, base * 1.5, base * 2];
    // Schedule all three notes via Web Audio's sample-accurate clock instead
    // of setTimeout — JS main-thread jitter was shifting the 60 ms spacing
    // run-to-run, which made the three-note chord phase-cancel differently
    // each time and shifted the perceived pitch of the combo cue.
    notes.forEach((f, i) => {
      tone(f, { type: 'sawtooth', attack: 0.05, decay: 0.36, peak: 0.22, delay: i * 0.06 });
    });
    noiseBurst({ duration: 0.28, peak: 0.14, filterFreq: 1800 + count * 120 });
  }

  // A-N-4e/D5: thud-style destroy sound (sub thud + mid punch + gritty body
  // + crack noise), pitched 0.45× from A-N-4e baseline for a heavier, duller
  // impact. Used for both painted and (post-downgrade) metal destroys.
  function playDestroy() {
    const scale = 0.45;
    tone(55 * scale, { type: 'sine', attack: 0.002, decay: 0.22, peak: 0.6, slideTo: 28 * scale, slideTime: 0.18 });
    tone(110 * scale, { type: 'sawtooth', attack: 0.003, decay: 0.12, peak: 0.32 });
    noiseBurst({ duration: 0.26, peak: 0.4, filterFreq: 700 * scale, filterType: 'lowpass', Q: 0.4, distort: 1.3 });
    noiseBurst({ duration: 0.04, peak: 0.5, filterFreq: 2200 * scale, filterType: 'bandpass', Q: 0.5 });
  }

  // Metal bounce: destroy button on a metal cell — the cell does NOT shatter,
  // it bounces. Short, light metallic clink to signal "blocked".
  function playMetalBounce() {
    if (!enabled || !ensureCtx()) return;
    noiseBurst({ duration: 0.04, peak: 0.18, filterFreq: 4500, filterType: 'highpass' });
    tone(2400, { type: 'square', attack: 0.001, decay: 0.12, peak: 0.16 });
    tone(3600, { type: 'square', attack: 0.001, decay: 0.08, peak: 0.08 });
  }

  // Landing sound — debounced because gravity drops many cells at once.
  let landScheduled = false;
  function playLand() {
    if (landScheduled) return;
    landScheduled = true;
    setTimeout(() => { landScheduled = false; }, 80);
    tone(140 + Math.random() * 40, { type: 'sine', attack: 0.012, decay: 0.11, peak: 0.3 });
    tone(80, { type: 'square', attack: 0.015, decay: 0.08, peak: 0.14 });
  }

  window.QSAudio = {
    playTap,
    playMatch,
    playDestroy,
    playMetalBounce,
    playLand,
    setEnabled(v) { enabled = !!v; },
    isEnabled: () => enabled,
    // Volume in [0, 1]. Setting to 0 also flips enabled off so we don't
    // schedule audio nodes that produce nothing.
    setVolume(v) {
      const clamped = Math.max(0, Math.min(1, Number(v) || 0));
      volume = clamped;
      enabled = clamped > 0;
      if (master) master.gain.value = clamped;
    },
    getVolume: () => volume,
  };
})();
