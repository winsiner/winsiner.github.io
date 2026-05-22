'use strict';

const N = 5;
// Full 5-color palette. activeColors expands as the player crosses score
// thresholds (3 → 4 → 5). All probability and pip logic iterates over
// activeColors, not COLORS, so the rest of the engine is palette-agnostic.
const COLORS = ['r', 'b', 'y', 'g', 'p'];
const COLOR_RGB = {
  r: '255,107,139',
  b: '95,179,255',
  y: '255,206,90',
  g: '111,219,138',
  p: '184,133,255',
};
const COLOR_DARK = {
  r: '208,64,96',
  b: '64,144,216',
  y: '216,160,48',
  g: '69,165,96',
  p: '136,85,216',
};
const COLOR_LABEL = { r: 'RED', b: 'BLUE', y: 'YELLOW', g: 'GREEN', p: 'PURPLE' };
const UNLOCK_THRESHOLDS = [
  { score: 1000, color: 'g' },
  { score: 5000, color: 'p' },
];
let activeColors = ['r', 'b', 'y'];
const BIAS_OBSERVE = 0.22;

let board = [];
let score = 0;
let obsCount = 0;
let matchCount = 0;
let gameOverFired = false;
let history = [];
const HISTORY_LIMIT = 12;
const REVIVE_REWIND_TURNS = 3;
const DESTROY_FREE_PER_GAME = 3;
const DESTROY_AD_PER_GAME = 3;
let destroyFreeRemaining = DESTROY_FREE_PER_GAME;
let destroyAdRemaining = DESTROY_AD_PER_GAME;
let destroyMode = false;
const AUTOPLAY_USES_PER_GAME = 3;
let autoplayUsesRemaining = AUTOPLAY_USES_PER_GAME;
// True while an ad has been watched and autoplay started but no turn has
// actually been consumed yet. If autoplay aborts before the first step
// (e.g. board is gridlocked and destroy pool is empty), we refund the
// charge so the player isn't punished for an unwinnable launch.
let autoplayChargePending = false;
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;
const COLLAPSE_MS = 420;
const MATCH_ANIM_MS = 360;
const FALL_MS = 700;

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
// Each board cell holds a unique id; cellEls maps id → its DOM element.
// Elements are absolutely positioned inside boardEl and translate to their
// (x, y) grid slot — when board data reshuffles (gravity), the elements
// move with their data, so there is no "ghost" stale visual underneath.
const cellEls = new Map();
let nextCellId = 1;
let cellSize = 0;  // px, updated on layout

const hooks = {
  onTap: null,
  onMatch: null,
  onGameOver: null,
  onReset: null,
  onCombo: null,
  onColorUnlock: null,
  onAutoplayStart: null,
  onAutoplayStep: null,
  onAutoplayEnd: null,
  // Called when the game needs the user to watch a rewarded ad in exchange
  // for a power-up. mobile.js installs an implementation that (a) skips the
  // ad if ads are removed, (b) shows the AdMob rewarded interstitial,
  // resolving true on reward and false on dismiss/error. The default just
  // grants the reward immediately (web preview / dev fallback).
  // Signature: requestRewardedAd(reason: 'autoplay' | 'destroy') => Promise<boolean>
  requestRewardedAd: null,
};

// Rainbow combo (A1 cycle): scoring is allowed ONLY when the next match
// matches the required color in the fixed R→B→Y→R cycle. Off-cycle matches
// fire visually (board clears) but award zero points and do NOT advance the
// cycle. A tap that produces no match breaks the streak and triggers the
// break animation.
let comboStreak = 0;
// Peak on-cycle combo streak reached in the current game. Persisted in
// snapshot + reported via onGameOver so mobile.js can update the all-time
// best-combo.
let maxComboThisGame = 0;
// Peak cascade-chain length (waves triggered by a single tap) in the
// current game. Distinct from comboStreak: a 3-wave cascade from a single
// tap counts as a chain of 3 here, regardless of on-cycle / off-cycle.
let maxChainThisGame = 0;
let chainThisTap = 0;
let lastMatchColor = null;  // kept for snapshot compatibility / HUD coloring
let cycleIndex = 0;
// Guarantees the 10k/20k cascade drops the new cell type immediately
// instead of waiting for the next interval tick. Persisted in snapshot.
let firstPaintedSpawned = false;
let firstMetalSpawned = false;
// Set by onTap, consumed by startCascadeWave on first wave: if no match fires
// at all, the streak resets to zero. Otherwise the cascade increments it.
// Declared early so reset()/revive() callers cannot hit TDZ before module
// evaluation reaches the bottom of the file.
let tapWillResolveCombo = false;
// comboStreak → multiplier. Index 1 = first on-cycle (×1), 2 = ×2, 3 = ×3,
// 4 = ×4. Streaks beyond 4 are clamped to the last entry via Math.min in
// comboMultiplier(), so the cap is implicit in the array length.
// Index 0 is unused but kept aligned (×1) for safety.
const COMBO_MULTIPLIERS = [1, 1, 2, 3, 4];
// Flat bonus added to baseScore when the matched color equals NEXT.
// Applied BEFORE the combo multiplier, so on-cycle streaks compound the
// bonus too — a 4× combo on a 3-match earns (30 base + 30 next) × 4.
const NEXT_BONUS = 30;
function comboMultiplier() {
  const idx = Math.min(comboStreak, COMBO_MULTIPLIERS.length - 1);
  return COMBO_MULTIPLIERS[idx];
}
function nextRequiredColor() {
  return activeColors[cycleIndex % activeColors.length];
}

// Unlock pending colors based on current score. Called after every score
// change. When a color unlocks we also seed it into the board: ~20% of the
// remaining super cells get their dominant rerolled to the new color so the
// player can actually find and play it right away (otherwise random spawn
// might leave the new color absent for several rounds, defeating the unlock).
function checkColorUnlocks() {
  for (const t of UNLOCK_THRESHOLDS) {
    if (score >= t.score && !activeColors.includes(t.color)) {
      activeColors.push(t.color);
      unlockRule('unlockColor');
      seedColorIntoBoard(t.color, 0.2);
      // Color unlock changes the cycle length, which invalidates any cached
      // BFS path's onCycle predictions. Discard the cache so the next
      // autoplay step replans against the new activeColors.
      autoplayState.tapPathCache = null;
      if (hooks.onColorUnlock) hooks.onColorUnlock(t.color);
    }
  }
  if (typeof updateAutoplayUI === 'function') updateAutoplayUI();
  if (typeof updateDestroyUI === 'function') updateDestroyUI();
}

function seedColorIntoBoard(color, fraction) {
  const supers = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (board[y][x].state === 'super') supers.push([x, y]);
  }
  // Shuffle and pick fraction of them.
  for (let i = supers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [supers[i], supers[j]] = [supers[j], supers[i]];
  }
  const target = Math.max(1, Math.floor(supers.length * fraction));
  const otherCount = activeColors.length - 1;
  const otherShare = otherCount > 0 ? (1 - DOMINANT_PROB) / otherCount : 0;
  for (let i = 0; i < target && i < supers.length; i++) {
    const [x, y] = supers[i];
    const cell = board[y][x];
    cell.probs = emptyProbs();
    for (const c of activeColors) cell.probs[c] = otherShare;
    cell.probs[color] = DOMINANT_PROB;
  }
}

window.QSGame = {
  setHook(name, fn) { hooks[name] = fn; },
  getScore: () => score,
  getStats: () => ({
    score,
    maxCombo: maxComboThisGame,
    maxChain: maxChainThisGame,
    matches: matchCount,
    taps: obsCount,
  }),
  getActiveColors: () => activeColors.slice(),
  getColorLabel: (c) => COLOR_LABEL[c] || c.toUpperCase(),
  getColorRGB: (c) => COLOR_RGB[c],
  getNextRequiredColor: () => nextRequiredColor(),
  // Exposed for the tutorial coach so its quest demo can render the
  // exact same icons + score targets the real .next-unlock chip uses.
  getUnlockMilestones: () => UNLOCK_MILESTONES.map(m => ({ ...m })),
  renderUnlockIcon: (kind) => renderUnlockIcon(kind),
  showStamp: (text, color, size) => showMatchStamp(text, color, size),
  showUnlockBanner: (text, color) => showUnlockBanner(text, color),
  reset,
  revive,
  enterDestroyMode,
  exitDestroyMode,
  isDestroyMode,
  refreshDynamicText: () => {
    if (typeof updateAutoplayUI === 'function') updateAutoplayUI();
    if (typeof updateDestroyUI === 'function') updateDestroyUI();
    if (typeof updateNextUnlock === 'function') updateNextUnlock();
    // Re-paint NEXT color label so it picks up the localized color word.
    if (typeof applyNextColorVisuals === 'function') applyNextColorVisuals();
  },
  // Fresh-board revive is always available once a game has ended — there's
  // no per-tap history requirement now that we no longer rewind turns.
  canRevive: () => gameOverFired,
  findBestTap,
  startAutoplay,
  stopAutoplay,
  isAutoplaying: () => autoplayState.active,
  isDestroyModalAiContext: () => destroyModalAiContext,
  getSaveState: () => ({
    v: 1,
    snap: snapshotState(),
    destroyFreeRemaining,
    destroyAdRemaining,
    autoplayUsesRemaining,
    gameOverFired,
    // Persist the AI's leftover ad-bought turns so a mid-autoplay app
    // close doesn't waste the player's reward. When the same save is
    // resumed, the autoplay flow picks up with the remaining turn count.
    autoplay: {
      active: autoplayState.active,
      remaining: autoplayState.remaining,
    },
  }),
  loadSaveState: (data) => {
    if (!data || data.v !== 1 || !data.snap || gameOverFired) return false;
    if (data.gameOverFired) return false;
    try {
      restoreState(data.snap);
      destroyFreeRemaining = Math.max(
        0,
        Math.min(DESTROY_FREE_PER_GAME, data.destroyFreeRemaining ?? DESTROY_FREE_PER_GAME),
      );
      destroyAdRemaining = Math.max(
        0,
        Math.min(DESTROY_AD_PER_GAME, data.destroyAdRemaining ?? DESTROY_AD_PER_GAME),
      );
      autoplayUsesRemaining = Math.max(
        0,
        Math.min(AUTOPLAY_USES_PER_GAME, data.autoplayUsesRemaining ?? AUTOPLAY_USES_PER_GAME),
      );
      destroyMode = false;
      applyDestroyVisuals();
      buildDOM();
      render();
      if (typeof updateAutoplayUI === 'function') updateAutoplayUI();
      if (typeof updateDestroyUI === 'function') updateDestroyUI();
      // If the player was mid-autoplay when the app went away, resume the
      // remaining ad-bought turns. The save format guarantees the board
      // state is consistent (cascade fully resolved before persistAutosave
      // fires), so startAutoplay can dive straight back into BFS planning.
      const saved = data.autoplay;
      if (saved && saved.active && saved.remaining > 0 && typeof startAutoplay === 'function') {
        startAutoplay(saved.remaining);
      }
      return true;
    } catch (_) {
      return false;
    }
  },
  isGameOver: () => gameOverFired,
  isCascadeBusy: () => cascadeBusy,
  _debugBoard: () => board.map(row => row.map(c => ({state:c.state,color:c.color,probs:{...c.probs}}))),
  _debugForceMatch: (color) => {
    // Set the top row to all `color` observed cells, then trigger cascade.
    for (let x = 0; x < N; x++) {
      const existing = board[0][x];
      board[0][x] = { id: existing.id, state: 'observed', probs: emptyProbs(), color };
    }
    render();
    resolveCascade();
  },
  __debug: {
    bfsTapPath: (s) => bfsTapPath(s || cloneSimState()),
    bfsDestroyTarget: (s) => bfsDestroyTarget(s || cloneSimState()),
    cloneSimState: () => cloneSimState(),
    findBestK1: () => findBestK1(),
    findBestK1All: () => {
      // Diagnostic: return ALL k=1 candidates, sorted by the same policy as
      // findBestK1 so the picked candidate is always cands[0].
      const state = cloneSimState();
      const supers = simSuperCells(state);
      const cands = [];
      for (const [x, y] of supers) {
        const r = simEvalTap(state, x, y);
        if (r.matched) cands.push({ x, y, totalSize: r.totalSize, onCycle: r.onCycle, streakSurvives: r.streakSurvives, gained: r.gained, cascadeCount: r.cascadeCount });
      }
      cands.sort((a, b) => {
        const aS = a.onCycle && a.streakSurvives, bS = b.onCycle && b.streakSurvives;
        if (aS !== bS) return aS ? -1 : 1;
        if (a.onCycle !== b.onCycle) return a.onCycle ? -1 : 1;
        if (a.totalSize !== b.totalSize) return b.totalSize - a.totalSize;
        return b.gained - a.gained;
      });
      return cands;
    },
  },
};

function snapshotState() {
  return {
    board: board.map(row => row.map(c => ({
      // id is preserved so the rewind animation can match cells across
      // history frames and detect which ones changed vs. stayed put.
      id: c.id,
      state: c.state,
      probs: { r: c.probs.r, b: c.probs.b, y: c.probs.y, g: c.probs.g, p: c.probs.p },
      color: c.color,
      special: c.special,
    }))),
    score, obsCount, matchCount, comboStreak, maxComboThisGame, maxChainThisGame, lastMatchColor, cycleIndex,
    firstPaintedSpawned, firstMetalSpawned,
    activeColors: activeColors.slice(),
  };
}
function pushHistory() {
  history.push(snapshotState());
  if (history.length > HISTORY_LIMIT) history.shift();
}
function restoreState(snap) {
  board = snap.board.map(row => row.map(c => {
    if (c.state === 'matching') return initCell();
    return {
      id: nextCellId++,
      state: c.state,
      probs: { r: c.probs.r, b: c.probs.b, y: c.probs.y, g: c.probs.g ?? 0, p: c.probs.p ?? 0 },
      color: c.color,
      // Legacy `spawnedObserved: true` → 'metal' for backward-compat.
      special: c.special || (c.spawnedObserved ? 'metal' : undefined),
    };
  }));
  score = snap.score;
  obsCount = snap.obsCount;
  matchCount = snap.matchCount;
  comboStreak = snap.comboStreak ?? 0;
  maxComboThisGame = snap.maxComboThisGame ?? comboStreak;
  maxChainThisGame = snap.maxChainThisGame ?? 0;
  chainThisTap = 0;
  lastMatchColor = snap.lastMatchColor ?? null;
  if (snap.activeColors) activeColors = snap.activeColors.slice();
  cycleIndex = snap.cycleIndex ?? 0;
  // Legacy saves without these flags: infer from score so a redundant
  // guarantee spawn doesn't fire on the next match after restore.
  firstPaintedSpawned = snap.firstPaintedSpawned ?? (snap.score >= 10000);
  firstMetalSpawned   = snap.firstMetalSpawned   ?? (snap.score >= 20000);
}

function revive() {
  // Fresh-board revive. Used from the gameover screen after the user watches
  // a rewarded ad: we keep everything the player has built up (score, combo
  // streak, unlocked colors, cycle position, counters) and only swap the
  // board for a fresh one of all-super cells so play can continue.
  if (!gameOverFired) return false;
  unlockRule('revive');

  gameOverFired = false;
  autoplayState.tapPathCache = null;
  autoplayState.pendingDestroy = null;
  tapWillResolveCombo = false;
  // Board itself starts over; history (used for autosave snapshots) clears
  // because the previous board frames no longer reflect reality.
  history = [];
  newBoard();
  // Re-seed the dominant-color biases for already-unlocked colors so the
  // fresh board's super cells reflect the difficulty curve the player has
  // reached, not the easier round-1 distribution.
  for (let i = 3; i < activeColors.length; i++) {
    seedColorIntoBoard(activeColors[i], 0.25);
  }

  $('gameover').classList.remove('show');
  buildDOM();
  render();
  if (typeof updateDestroyUI === 'function') updateDestroyUI();
  if (typeof updateAutoplayUI === 'function') updateAutoplayUI();
  return true;
}

// ─── Destroy mode: pick one cell to remove ───
// Player taps the destroy button → enters destroy mode → next cell tap removes
// that cell. Gravity drops a new super in its place; cascade can chain matches.
function isDestroyMode() { return destroyMode; }
function enterDestroyMode() {
  if (destroyMode || gameOverFired) return;
  autoplayState.tapPathCache = null;
  destroyMode = true;
  applyDestroyVisuals();
}
function exitDestroyMode() {
  if (!destroyMode) return;
  destroyMode = false;
  applyDestroyVisuals();
}
function applyDestroyVisuals() {
  const app = document.querySelector('.app');
  if (app) app.classList.toggle('destroy-mode', destroyMode);
  const strip = $('next-strip');
  if (strip) strip.classList.toggle('destroy-mode', destroyMode);
  if (typeof updateDestroyUI === 'function') updateDestroyUI();
}
function destroyCellAt(x, y) {
  // Remove cell at (x, y), apply gravity (one column collapses), spawn one
  // new super on top. Cascade resolves any newly formed matches.
  if (!destroyMode) return false;
  const cell = board[y]?.[x];
  if (!cell) return false;
  // Metal bounces (destroy mode stays active for re-target). Painted destroys normally.
  if (cell.special === 'metal') {
    const el = cellEls.get(cell.id);
    if (el) {
      el.classList.remove('cursed-shake');
      void el.offsetWidth;
      el.classList.add('cursed-shake');
      setTimeout(() => el.classList.remove('cursed-shake'), 400);
    }
    if (window.QSAudio) window.QSAudio.playMetalBounce();
    return false;
  }
  pushHistory();
  destroyMode = false;
  applyDestroyVisuals();
  destroyFreeRemaining = Math.max(0, destroyFreeRemaining - 1);
  unlockRule('destroy');
  // Refresh the badge immediately so the count drops as the shatter
  // animation starts, not ~900 ms later when the cascade settles.
  if (typeof updateDestroyUI === 'function') updateDestroyUI();

  // Visual: shatter + flash + particles, then physically remove the cell.
  // Shatter is spawned BEFORE adding destroy-flash so the cell's current
  // transform is still its grid position (the flash animation discards the
  // grid transform briefly).
  const el = cellEls.get(cell.id);
  if (el) {
    const color = cell.color || pickDominant(cell.probs);
    shatter(el, color, 12);
    particles(el, color, 20);
    el.classList.add('destroy-flash');
  }
  if (window.QSAudio) window.QSAudio.playDestroy();
  setTimeout(() => {
    destroyCellElement(cell.id);
    const matchedList = [[x, y]];
    const spawned = applyGravityForMatches(matchedList, { fromDestroy: true });
    for (const sp of spawned) {
      const e = createCellElement(sp.cell, { spawnAbove: true });
      positionCell(e, sp.x, -N);
      void e.offsetWidth;
    }
    render();
    // Drop spawned cells next frame so the transition actually plays.
    requestAnimationFrame(() => {
      for (const sp of spawned) {
        const e = cellEls.get(sp.cell.id);
        if (!e) continue;
        e.classList.add('spawning');
        let landedY = -1, landedX = sp.x;
        for (let yy = 0; yy < N; yy++) if (board[yy][sp.x]?.id === sp.cell.id) { landedY = yy; break; }
        if (landedY < 0) continue;
        positionCell(e, landedX, landedY);
        setTimeout(() => e.classList.remove('above'), 16);
        setTimeout(() => e.classList.remove('spawning'), FALL_MS);
      }
      if (window.QSAudio) setTimeout(() => window.QSAudio.playLand(), FALL_MS - 80);
      setTimeout(() => {
        resolveCascade();
        if (typeof updateDestroyUI === 'function') updateDestroyUI();
        if (typeof updateAutoplayUI === 'function') updateAutoplayUI();
      }, FALL_MS);
    });
  }, 200);
  return true;
}

// Each fresh cell gets ONE dominant color (from activeColors) biased to 0.5;
// the rest of activeColors share the remaining 0.5 equally. Inactive colors
// stay at 0. probs always has all 5 keys so palette expansion is non-breaking.
const DOMINANT_PROB = 0.55;
function emptyProbs() {
  return { r: 0, b: 0, y: 0, g: 0, p: 0 };
}
function initCell() {
  const dom = activeColors[Math.floor(Math.random() * activeColors.length)];
  const otherCount = activeColors.length - 1;
  const otherShare = otherCount > 0 ? (1 - DOMINANT_PROB) / otherCount : 0;
  const probs = emptyProbs();
  for (const c of activeColors) probs[c] = otherShare;
  probs[dom] = DOMINANT_PROB;
  return { id: nextCellId++, state: 'super', probs, color: null };
}
function newBoard() {
  board = [];
  for (let y = 0; y < N; y++) {
    const row = [];
    for (let x = 0; x < N; x++) row.push(initCell());
    board.push(row);
  }
}
function inBounds(x, y) { return x >= 0 && y >= 0 && x < N && y < N; }
function neighbors(x, y) {
  const out = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) {
    if (inBounds(x+dx, y+dy)) out.push([x+dx, y+dy]);
  }
  return out;
}
// Deterministic resolution: the dominant color wins. Ties break by COLORS order
// (r > b > y). Probabilities still mutate via biasNeighbor for visual feedback
// and to telegraph future outcomes — but no dice are rolled at observation time.
function pickDominant(probs) {
  // Restrict to currently active colors so an unlocked-but-empty (probs=0)
  // color never wins by tiebreak. Defaults to the first active color when
  // all active probs are zero.
  let best = activeColors[0];
  for (const c of activeColors) {
    if (probs[c] > probs[best]) best = c;
  }
  return best;
}
function biasNeighbor(cell, color, amount) {
  const p = cell.probs;
  // Only redistribute among currently active colors — never resurrect a
  // locked color (g/p before unlock) by clamping its probability up to 0.04.
  const others = activeColors.filter(c => c !== color);
  const otherTotal = others.reduce((s, c) => s + p[c], 0);
  const inc = Math.min(amount, otherTotal * 0.8);
  p[color] = Math.min(0.88, p[color] + inc);
  if (otherTotal > 0) {
    for (const c of others) p[c] = Math.max(0.04, p[c] - inc * (p[c] / otherTotal));
  }
  // Normalize over active colors only; inactive ones stay at 0.
  const sum = activeColors.reduce((s, c) => s + p[c], 0);
  if (sum > 0) for (const c of activeColors) p[c] /= sum;
}
function observe(x, y) {
  const cell = board[y][x];
  if (cell.state !== 'super') return null;
  const color = pickDominant(cell.probs);
  cell.state = 'observed';
  cell.color = color;
  unlockRule('superObserved');
  for (const [nx, ny] of neighbors(x, y)) {
    const nc = board[ny][nx];
    if (nc.state === 'super') biasNeighbor(nc, color, BIAS_OBSERVE);
  }
  return color;
}
function findMatches() {
  const matched = new Set();
  const dirs = [[1,0],[0,1]];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = board[y][x];
      if (c.state !== 'observed') continue;
      for (const [dx, dy] of dirs) {
        const px = x - dx, py = y - dy;
        if (inBounds(px, py)) {
          const pc = board[py][px];
          if (pc.state === 'observed' && pc.color === c.color) continue;
        }
        const line = [[x, y]];
        for (let k = 1; k < N; k++) {
          const nx = x + dx*k, ny = y + dy*k;
          if (!inBounds(nx, ny)) break;
          const nc = board[ny][nx];
          if (nc.state === 'observed' && nc.color === c.color) {
            line.push([nx, ny]);
          } else break;
        }
        if (line.length >= 3) for (const [lx, ly] of line) matched.add(`${ly},${lx}`);
      }
    }
  }
  return matched;
}
function isGameOver() {
  // Game ends when every cell on the board has been observed. As long as any
  // super (un-observed) cell exists, play continues. Matching cells are still
  // mid-animation so they also keep play alive.
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const s = board[y][x].state;
    if (s === 'super' || s === 'matching') return false;
  }
  return true;
}

// ─── Pure simulation helpers (no DOM, no animation) ───
// Used by the autoplay bot to evaluate tap candidates by dry-running them on
// a cloned game state. Mirrors the same observe/bias/cascade math as the live
// game, but stripped of all UI side effects.
function cloneSimState() {
  const cells = [];
  for (let y = 0; y < N; y++) {
    const row = [];
    for (let x = 0; x < N; x++) {
      const c = board[y][x];
      row.push({ state: c.state, probs: Object.assign({}, c.probs), color: c.color, special: c.special });
    }
    cells.push(row);
  }
  return {
    board: cells,
    activeColors: activeColors.slice(),
    score,
    comboStreak,
    cycleIndex,
  };
}
function simPickDominant(probs, active) {
  let best = active[0];
  for (const c of active) if (probs[c] > probs[best]) best = c;
  return best;
}
function simBiasNeighbor(cell, color, amount, active) {
  const p = cell.probs;
  const others = active.filter(c => c !== color);
  const otherTotal = others.reduce((s, c) => s + p[c], 0);
  const inc = Math.min(amount, otherTotal * 0.8);
  p[color] = Math.min(0.88, p[color] + inc);
  if (otherTotal > 0) for (const c of others) p[c] = Math.max(0.04, p[c] - inc * (p[c] / otherTotal));
  const sum = active.reduce((s, c) => s + p[c], 0);
  if (sum > 0) for (const c of active) p[c] /= sum;
}
function simObserve(state, x, y) {
  const cell = state.board[y][x];
  if (cell.state !== 'super') return null;
  const color = simPickDominant(cell.probs, state.activeColors);
  cell.state = 'observed';
  cell.color = color;
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = x+dx, ny = y+dy;
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
    const nc = state.board[ny][nx];
    if (nc.state === 'super') simBiasNeighbor(nc, color, BIAS_OBSERVE, state.activeColors);
  }
  return color;
}
function simFindMatches(state) {
  const matched = new Set();
  const dirs = [[1,0],[0,1]];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = state.board[y][x];
    if (c.state !== 'observed') continue;
    for (const [dx, dy] of dirs) {
      const px = x-dx, py = y-dy;
      if (px >= 0 && py >= 0 && px < N && py < N) {
        const pc = state.board[py][px];
        if (pc.state === 'observed' && pc.color === c.color) continue;
      }
      const line = [[x, y]];
      for (let k = 1; k < N; k++) {
        const nx = x+dx*k, ny = y+dy*k;
        if (nx >= N || ny >= N) break;
        const nc = state.board[ny][nx];
        if (nc.state === 'observed' && nc.color === c.color) line.push([nx, ny]);
        else break;
      }
      if (line.length >= 3) for (const [lx, ly] of line) matched.add(`${ly},${lx}`);
    }
  }
  return matched;
}
function simInitSuper(active) {
  const dom = active[Math.floor(Math.random() * active.length)];
  const otherCount = active.length - 1;
  const otherShare = otherCount > 0 ? (1 - DOMINANT_PROB) / otherCount : 0;
  const probs = { r: 0, b: 0, y: 0, g: 0, p: 0 };
  for (const c of active) probs[c] = otherShare;
  probs[dom] = DOMINANT_PROB;
  return { state: 'super', probs, color: null };
}
function simApplyGravity(state, list) {
  const cleared = Array.from({ length: N }, () => new Array(N).fill(false));
  for (const [mx, my] of list) cleared[my][mx] = true;
  for (let x = 0; x < N; x++) {
    const survivors = [];
    for (let y = N-1; y >= 0; y--) if (!cleared[y][x]) survivors.push(state.board[y][x]);
    for (let y = N-1; y >= 0; y--) state.board[y][x] = survivors.shift() || simInitSuper(state.activeColors);
  }
}
function simNextRequiredColor(state) {
  return state.activeColors[state.cycleIndex % state.activeColors.length];
}
function simTap(state, x, y) {
  // Returns { waves: [{color, size, onCycle, gained}, ...] }
  if (state.board[y][x].state !== 'super') return { waves: [] };
  simObserve(state, x, y);
  const waves = [];
  while (true) {
    const matched = simFindMatches(state);
    if (matched.size === 0) break;
    const tally = { r: 0, b: 0, y: 0, g: 0, p: 0 };
    const list = [];
    for (const k of matched) {
      const [my, mx] = k.split(',').map(Number);
      const cc = state.board[my][mx].color;
      if (cc) tally[cc]++;
      list.push([mx, my]);
    }
    let waveColor = 'r';
    for (const c of ['r','b','y','g','p']) if (tally[c] > tally[waveColor]) waveColor = c;
    const required = simNextRequiredColor(state);
    const onCycle = waveColor === required;
    const bonus = matched.size > 3 ? 3 : 0;
    const base = matched.size * 10 + (matched.size - 3) * 5 + bonus * 8;
    let gained;
    if (onCycle) {
      state.comboStreak += 1;
      state.cycleIndex = (state.cycleIndex + 1) % state.activeColors.length;
      const idx = Math.min(state.comboStreak, COMBO_MULTIPLIERS.length - 1);
      gained = Math.round((base + NEXT_BONUS) * COMBO_MULTIPLIERS[idx]);
    } else {
      gained = base;
      state.comboStreak = 0;
    }
    state.score += gained;
    waves.push({ color: waveColor, size: matched.size, onCycle, gained });
    simApplyGravity(state, list);
  }
  return { waves };
}
function simSuperCells(state) {
  const out = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (state.board[y][x].state === 'super') out.push([x, y]);
  }
  return out;
}
function simEvalTap(state, x, y) {
  const clone = {
    board: state.board.map(row => row.map(c => ({ state: c.state, probs: Object.assign({}, c.probs), color: c.color, special: c.special }))),
    activeColors: state.activeColors.slice(),
    score: state.score,
    comboStreak: state.comboStreak,
    cycleIndex: state.cycleIndex,
  };
  const { waves } = simTap(clone, x, y);
  if (waves.length === 0) return { matched: false, totalSize: 0, onCycle: false, streakSurvives: false, gained: 0, cascadeCount: 0 };
  let totalSize = 0, gained = 0;
  for (const w of waves) { totalSize += w.size; gained += w.gained; }
  // onCycle: first wave matched the NEXT color (extends the streak).
  // streakSurvives: AND no later wave broke it. A streak-breaking cascade
  // ranks below a clean single on-cycle wave even when totalSize/gained
  // would otherwise prefer the cascade.
  const onCycle = !!waves[0].onCycle;
  const streakSurvives = waves.every(w => w.onCycle);
  return { matched: true, totalSize, onCycle, streakSurvives, gained, cascadeCount: waves.length, clone };
}
const BFS_NODE_LIMIT = 10000;
const BFS_DESTROY_INNER_NODE_LIMIT = 1500;

// Deep clone a sim state (board cells, activeColors, score, comboStreak, cycleIndex).
// Note: any future field added to the sim state schema must be added here AND in
// cloneSimState/simEvalTap clones — there are three clone sites in this file.
function bfsCloneState(state) {
  return {
    board: state.board.map(row => row.map(c => ({
      state: c.state,
      probs: Object.assign({}, c.probs),
      color: c.color,
      special: c.special,
    }))),
    activeColors: state.activeColors.slice(),
    score: state.score,
    comboStreak: state.comboStreak,
    cycleIndex: state.cycleIndex,
  };
}

// Serialize a board state into a short string key for BFS visited-set dedup.
// Distinct boards must map to distinct keys; identical boards must map to the
// same key. Probabilities don't matter for matching — only state + color +
// dominant-color (the only field that influences future taps). For super
// cells we encode their pickDominant color since that determines tap output.
function bfsBoardKey(state) {
  const parts = [];
  for (let y = 0; y < state.board.length; y++) {
    const row = state.board[y];
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c.state === 'observed') {
        parts.push('o' + c.color);
      } else if (c.state === 'super') {
        // Encode dominant color (decides this cell's tap outcome) AND a
        // coarse probability fingerprint so two paths reaching the same
        // dominant layout via different bias histories do not collapse.
        // Accumulated neighbor bias can raise a non-dominant color above
        // the original dominant after enough exposure, and the BFS would
        // miss the resulting match if those states were deduped together.
        parts.push('s' + simPickDominant(c.probs, state.activeColors) + ':');
        for (const ac of state.activeColors) {
          // Quantize to 0.05 so trivially-different floats still collapse,
          // but bias-relevant differences (>= one bias step) do not.
          parts.push(Math.round((c.probs[ac] || 0) * 20).toString(36));
        }
        parts.push(';');
      } else {
        parts.push('.');
      }
    }
  }
  // Append cycleIndex because on-cycle matching depends on it.
  return parts.join('') + '|' + state.cycleIndex;
}

// BFS search for the shortest tap sequence that produces at least one match.
// Returns an array of [x, y] coordinates, or null if no path exists within
// the node budget. Uses a visited-set keyed by board state to avoid the
// permutation explosion when non-matching taps commute.
// BFS by depth layer. Within each layer, prefer onCycle matches (combo-extending)
// over off-cycle matches, then prefer higher gained score. Returns the path to
// the best match at the shallowest depth that contains any match.
function bfsTapPath(startState, nodeLimit) {
  const limit = nodeLimit || BFS_NODE_LIMIT;
  let frontier = [];      // current depth
  const visited = new Set();
  let nodeCount = 0;

  visited.add(bfsBoardKey(startState));
  frontier.push({ state: startState, path: [] });

  // matchCmp: lower is better. Used to pick the best match within a depth layer.
  // Tier order matches findBestK1:
  //   1) streak-preserving on-cycle (combo multiplier dominates score)
  //   2) any on-cycle beats off-cycle
  //   3) larger totalSize
  //   4) gained
  const matchCmp = (a, b) => {
    const aStreak = a.onCycle && a.streakSurvives;
    const bStreak = b.onCycle && b.streakSurvives;
    if (aStreak !== bStreak) return aStreak ? -1 : 1;
    if (a.onCycle !== b.onCycle) return a.onCycle ? -1 : 1;
    const aSize = a.totalSize || 0, bSize = b.totalSize || 0;
    if (aSize !== bSize) return bSize - aSize;
    const aGained = a.gained || 0, bGained = b.gained || 0;
    return bGained - aGained;
  };

  while (frontier.length > 0) {
    const nextFrontier = [];
    let bestMatch = null;
    let bestMatchPath = null;
    for (const { state, path } of frontier) {
      if (nodeCount >= limit) break;
      const supers = simSuperCells(state);
      for (const [x, y] of supers) {
        if (nodeCount >= limit) break;
        const clone = bfsCloneState(state);
        const r = simTap(clone, x, y);
        nodeCount += 1;
        const newPath = path.concat([[x, y]]);
        if (r.waves.length > 0) {
          // Aggregate wave data for comparison.
          let totalSize = 0, gained = 0;
          for (const w of r.waves) { totalSize += w.size; gained += w.gained; }
          const onCycle = !!r.waves[0].onCycle;
          const streakSurvives = r.waves.every(w => w.onCycle);
          const candidate = { onCycle, streakSurvives, totalSize, gained };
          if (!bestMatch || matchCmp(candidate, bestMatch) < 0) {
            bestMatch = candidate;
            bestMatchPath = newPath;
          }
          // Don't enqueue matched states — they end the search at this depth.
          continue;
        }
        const key = bfsBoardKey(clone);
        if (visited.has(key)) continue;
        visited.add(key);
        nextFrontier.push({ state: clone, path: newPath });
      }
    }
    // If any match was found at this depth, return the best one (shallowest match wins).
    if (bestMatchPath) return bestMatchPath;
    // Budget exhausted only after a full depth layer ran: return what we have
    // (null) so the caller falls through to destroy phase. The next deeper
    // layer wouldn't fit anyway.
    if (nodeCount >= limit) return null;
    frontier = nextFrontier;
  }
  return null;
}

// Simulate destroyCellAt on a cloned sim state: remove (x, y), apply gravity
// to that column, and spawn one new super cell at the top with the given
// dominant color. Mirrors destroyCellAt + applyGravityForMatches([[x, y]])
// without DOM/animation work. The spawned cell uses the same DOMINANT_PROB
// distribution as simInitSuper but with `assumedDominant` instead of random.
function bfsSimDestroy(state, x, y, assumedDominant) {
  const N_ = state.board.length;
  // Build the column: keep all non-cleared cells, push them down, fill top with new super.
  const column = [];
  for (let yy = 0; yy < N_; yy++) {
    if (yy === y) continue;
    column.push(state.board[yy][x]);
  }
  // Construct new super at the top with assumedDominant.
  const active = state.activeColors;
  const otherCount = active.length - 1;
  const otherShare = otherCount > 0 ? (1 - DOMINANT_PROB) / otherCount : 0;
  const probs = { r: 0, b: 0, y: 0, g: 0, p: 0 };
  for (const c of active) probs[c] = otherShare;
  probs[assumedDominant] = DOMINANT_PROB;
  const newSuper = { state: 'super', probs, color: null };

  // Rewrite the column: top = newSuper, then column[] in order.
  const newColumn = [newSuper, ...column];
  for (let yy = 0; yy < N_; yy++) state.board[yy][x] = newColumn[yy];
}

// For each observed cell on the board, try destroying it with each possible
// dominant spawn color. The cell with the SHORTEST best-case match path
// (across all colors) is the recommended destroy target. Returns
// { x, y } or null if no destroy enables a match.
function bfsDestroyTarget(startState) {
  const N_ = startState.board.length;
  const observed = [];
  for (let y = 0; y < N_; y++) {
    for (let x = 0; x < N_; x++) {
      const cell = startState.board[y][x];
      // Cursed cells are unbreakable, so AI must never recommend destroying them.
      if (cell.state === 'observed' && cell.special !== 'metal') observed.push([x, y]);
    }
  }
  if (observed.length === 0) return null;

  const candidates = [];
  for (const [x, y] of observed) {
    let bestLen = Infinity;
    for (const c of startState.activeColors) {
      const clone = bfsCloneState(startState);
      bfsSimDestroy(clone, x, y, c);
      // After destroy, try k=1 first on the cloned state.
      const supers = simSuperCells(clone);
      let immediate = false;
      for (const [sx, sy] of supers) {
        const cc = bfsCloneState(clone);
        const r = simTap(cc, sx, sy);
        if (r.waves.length > 0) { immediate = true; break; }
      }
      if (immediate) { bestLen = 1; break; }
      const path = bfsTapPath(clone, BFS_DESTROY_INNER_NODE_LIMIT);
      if (path && path.length < bestLen) bestLen = path.length;
    }
    if (bestLen < Infinity) candidates.push({ x, y, len: bestLen });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.len - b.len);
  return { x: candidates[0].x, y: candidates[0].y };
}

// k=1: returns { x, y } of the best immediate-match tap, or null.
// Single ranking (score-optimized): streak-preserving on-cycle is strictly
// best, then any on-cycle, then larger totalSize. Size 4+ matches naturally
// score higher via the cascade/bonus formula so the tiebreak still favours
// them, but they no longer short-circuit ahead of streak preservation.
function findBestK1() {
  const state = cloneSimState();
  const supers = simSuperCells(state);
  if (supers.length === 0) return null;
  const candidates = [];
  for (const [x, y] of supers) {
    const r = simEvalTap(state, x, y);
    if (r.matched) candidates.push({ x, y, ...r });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aStreak = a.onCycle && a.streakSurvives;
    const bStreak = b.onCycle && b.streakSurvives;
    if (aStreak !== bStreak) return aStreak ? -1 : 1;
    if (a.onCycle !== b.onCycle) return a.onCycle ? -1 : 1;
    if (a.totalSize !== b.totalSize) return b.totalSize - a.totalSize;
    if (a.cascadeCount !== b.cascadeCount) return b.cascadeCount - a.cascadeCount;
    return b.gained - a.gained;
  });
  const best = candidates[0];
  return { x: best.x, y: best.y, onCycle: best.onCycle, streakSurvives: best.streakSurvives, totalSize: best.totalSize, gained: best.gained };
}

function findBestTap() {
  const k = findBestK1();
  return k ? [k.x, k.y] : null;
}

// ─── Autoplay ───
const autoplayState = {
  active: false,
  remaining: 0,
  timer: null,
  tapPathCache: null,        // Array<[x, y]> | null — FIFO consumed
  pendingDestroy: null,      // { x, y } | null — set while AI destroy modal is open
  botTapInFlight: false,     // true while autoplayExecuteTap is calling onTap, so the cache survives the bot's own tap
};
const AUTOPLAY_TURN_DELAY_MS = 600;

function boardIsStable() {
  // Cascade engine flag — true while a match/gravity wave is mid-resolve.
  // DOM class checks below catch the in-flight spawn/collapse animations,
  // but there is a 360-700ms gap between phases where no cell has those
  // classes yet cascadeBusy is still true. Reading the board then would
  // give the AI a snapshot that doesn't reflect the imminent state change.
  if (cascadeBusy) return false;
  for (const el of cellEls.values()) {
    if (el.classList.contains('spawning') || el.classList.contains('above') || el.classList.contains('collapsing')) return false;
  }
  return true;
}
function applyAutoplayVisuals() {
  const app = document.querySelector('.app');
  if (app) app.classList.toggle('autoplay-active', autoplayState.active);
}
function startAutoplay(turns) {
  if (autoplayState.active) return false;
  if (gameOverFired) return false;
  unlockRule('ai');
  autoplayState.active = true;
  autoplayState.remaining = Math.max(1, turns | 0);
  applyAutoplayVisuals();
  if (hooks.onAutoplayStart) hooks.onAutoplayStart(autoplayState.remaining);
  scheduleNextAutoplayStep(0);
  return true;
}
function stopAutoplay() {
  if (!autoplayState.active && !autoplayState.tapPathCache && !autoplayState.pendingDestroy) return;
  // If autoplay aborted before its first tap could land, refund the use
  // and let the player know — they paid for an ad and got nothing.
  const refunded = autoplayChargePending;
  autoplayState.active = false;
  autoplayState.remaining = 0;
  autoplayState.tapPathCache = null;
  autoplayState.pendingDestroy = null;
  autoplayState.botTapInFlight = false;
  autoplayChargePending = false;
  applyAutoplayVisuals();
  if (autoplayState.timer) { clearTimeout(autoplayState.timer); autoplayState.timer = null; }
  if (hooks.onAutoplayEnd) hooks.onAutoplayEnd();
  if (refunded && typeof window.QSToast === 'function') {
    const msg = window.QSI18n ? window.QSI18n.t('autoplay.refunded') : 'No moves available. AI use refunded.';
    window.QSToast(msg);
  }
}
function scheduleNextAutoplayStep(delay) {
  if (!autoplayState.active) return;
  autoplayState.timer = setTimeout(autoplayStep, delay);
}

// Shared 250 ms highlight + onTap flow used by all autoplay execution branches.
function autoplayExecuteTap(x, y, onAfter) {
  const cell = board[y]?.[x];
  const el = cell ? cellEls.get(cell.id) : null;
  // Capture the cell identity so we can detect mid-flight board changes
  // (user tap, cascade, destroy) during the 250ms highlight delay. If the
  // cell at (x,y) is no longer the same super cell when the timer fires,
  // skip the tap entirely — autoplayStep will re-plan on the next tick.
  const targetCellId = cell?.id;
  const wasSuper = cell?.state === 'super';
  if (el) el.classList.add('autoplay-pick');
  setTimeout(() => {
    if (el) el.classList.remove('autoplay-pick');
    if (!autoplayState.active || gameOverFired) {
      if (typeof onAfter === 'function') onAfter();
      return;
    }
    const current = board[y]?.[x];
    if (!current || current.id !== targetCellId || current.state !== 'super' || !wasSuper) {
      // Board changed underneath us. Drop the cached path (it was planned for
      // the old board) and let autoplayStep recompute on the next tick.
      autoplayState.tapPathCache = null;
      if (typeof onAfter === 'function') onAfter();
      return;
    }
    // Mark this onTap call as bot-originated so onTap doesn't invalidate the
    // remaining cached path — only external (user) taps should clear it.
    autoplayState.botTapInFlight = true;
    try { onTap(x, y); } finally { autoplayState.botTapInFlight = false; }
    if (typeof onAfter === 'function') onAfter();
  }, 250);
}

const aiDestroyModal = $('ai-destroy-modal');
const aiDestroyConfirm = $('ai-destroy-confirm');
const aiDestroyCancel = $('ai-destroy-cancel');
const aiDestroyRemainingEl = $('ai-destroy-remaining');

function openAIDestroyModal(target) {
  if (!aiDestroyModal) {
    console.error('[AI] #ai-destroy-modal not found in DOM');
    autoplayState.pendingDestroy = null;
    stopAutoplay();
    return;
  }
  if (aiDestroyRemainingEl) aiDestroyRemainingEl.textContent = String(destroyFreeRemaining);
  const descEl = aiDestroyModal.querySelector('.autoplay-modal-desc');
  if (descEl && window.QSI18n) {
    descEl.innerHTML = window.QSI18n.t('aiDestroy.desc', { n: destroyFreeRemaining });
  }
  aiDestroyModal.hidden = false;
}

function closeAIDestroyModal() {
  if (aiDestroyModal) aiDestroyModal.hidden = true;
}

function executeAIDestroyAndResume(target) {
  if (!autoplayState.active || gameOverFired) {
    autoplayState.pendingDestroy = null;
    autoplayState.tapPathCache = null;
    return;
  }
  autoplayState.pendingDestroy = null;
  autoplayState.tapPathCache = null;
  enterDestroyMode();
  destroyCellAt(target.x, target.y);
  scheduleNextAutoplayStep(FALL_MS + 200);
}

aiDestroyConfirm?.addEventListener('click', () => {
  // Double-click guard: without this, a rapid second click before the modal
  // animation closes would invoke executeAIDestroyAndResume twice, consuming
  // two destroys and re-entering destroy mode while the first action is
  // still animating.
  if (aiDestroyConfirm.dataset.busy === '1') return;
  aiDestroyConfirm.dataset.busy = '1';
  try {
    const target = autoplayState.pendingDestroy;
    closeAIDestroyModal();
    if (!target || !autoplayState.active || gameOverFired) {
      autoplayState.pendingDestroy = null;
      stopAutoplay();
      return;
    }
    executeAIDestroyAndResume(target);
  } finally {
    // Allow re-arming after the destroy animation lands (FALL_MS + buffer).
    setTimeout(() => { aiDestroyConfirm.dataset.busy = ''; }, FALL_MS + 200);
  }
});

aiDestroyCancel?.addEventListener('click', () => {
  closeAIDestroyModal();
  autoplayState.pendingDestroy = null;
  stopAutoplay();
});

function aiResetDestroyModalLabels() {
  if (!destroyModal) return;
  const titleEl = destroyModal.querySelector('.autoplay-modal-title');
  const descEl = destroyModal.querySelector('.autoplay-modal-desc');
  const cancelBtn = $('destroy-cancel');
  const closeBtn = $('destroy-modal-close');
  if (titleEl && window.QSI18n) titleEl.textContent = window.QSI18n.t('destroy.modalTitle');
  if (descEl && window.QSI18n) descEl.innerHTML = window.QSI18n.t('destroy.modalDesc');
  if (cancelBtn && window.QSI18n) cancelBtn.textContent = window.QSI18n.t('destroy.cancel');
  if (closeBtn) closeBtn.style.display = '';
}

function openAIDestroyAdModal(target) {
  if (!destroyModal) {
    console.error('[AI] #destroy-modal not found in DOM');
    autoplayState.pendingDestroy = null;
    stopAutoplay();
    return;
  }
  destroyModalAiContext = true;
  const titleEl = destroyModal.querySelector('.autoplay-modal-title');
  const descEl = destroyModal.querySelector('.autoplay-modal-desc');
  const cancelBtn = $('destroy-cancel');
  const closeBtn = $('destroy-modal-close');
  if (titleEl && window.QSI18n) titleEl.textContent = window.QSI18n.t('aiDestroy.title');
  if (descEl && window.QSI18n) descEl.innerHTML = window.QSI18n.t('aiDestroy.descAd');
  if (cancelBtn && window.QSI18n) cancelBtn.textContent = window.QSI18n.t('aiDestroy.cancel');
  if (closeBtn) closeBtn.style.display = 'none';
  destroyModal.hidden = false;
}

function autoplayStep() {
  autoplayState.timer = null;
  if (!autoplayState.active) return;
  if (gameOverFired || autoplayState.remaining <= 0) { stopAutoplay(); return; }
  if (!boardIsStable() || destroyMode || autoplayState.pendingDestroy) {
    scheduleNextAutoplayStep(150);
    return;
  }

  const afterTap = () => {
    // If autoplay was stopped (user clicked Stop AI, game over fired, etc.)
    // during the 250ms highlight delay, do not decrement or reschedule.
    if (!autoplayState.active) return;
    // First tap of this ad-charged run committed the charge.
    if (autoplayChargePending) {
      autoplayChargePending = false;
      autoplayUsesRemaining = Math.max(0, autoplayUsesRemaining - 1);
    }
    autoplayState.remaining -= 1;
    if (hooks.onAutoplayStep) hooks.onAutoplayStep(autoplayState.remaining);
    if (autoplayState.remaining <= 0) { stopAutoplay(); return; }
    scheduleNextAutoplayStep(AUTOPLAY_TURN_DELAY_MS);
  };

  // 1. Best k=1 immediate match (3-match). Streak-preserving on-cycle first,
  //    then any on-cycle, then off-cycle by totalSize. AI resolves whatever
  //    match is available; it does not chase deeper "size 4+ stacking" paths
  //    — that was experimentally wired up and dropped on user request.
  const k1 = findBestK1();
  if (k1) {
    autoplayState.tapPathCache = null;
    autoplayExecuteTap(k1.x, k1.y, afterTap);
    return;
  }

  // 2. Cached tap path (only consumed when no on-cycle k=1 match exists)
  if (autoplayState.tapPathCache && autoplayState.tapPathCache.length > 0) {
    const [x, y] = autoplayState.tapPathCache.shift();
    if (autoplayState.tapPathCache.length === 0) autoplayState.tapPathCache = null;
    autoplayExecuteTap(x, y, afterTap);
    return;
  }

  // 3. Tap-Path BFS. We pass the off-cycle k=1 candidate (if any) as a
  //    fallback floor so the BFS can prefer deeper on-cycle matches but
  //    still degrade gracefully to the immediate off-cycle match.
  const startState = cloneSimState();
  const path = bfsTapPath(startState);
  if (path && path.length > 0) {
    autoplayState.tapPathCache = path.slice(1);
    if (autoplayState.tapPathCache.length === 0) autoplayState.tapPathCache = null;
    const [x, y] = path[0];
    autoplayExecuteTap(x, y, afterTap);
    return;
  }

  // 4. BFS produced nothing better than the off-cycle k=1; take it.
  if (k1) {
    autoplayState.tapPathCache = null;
    autoplayExecuteTap(k1.x, k1.y, afterTap);
    return;
  }

  // 5. Destroy BFS
  const target = bfsDestroyTarget(startState);
  if (!target) { stopAutoplay(); return; }

  autoplayState.pendingDestroy = target;
  if (destroyFreeRemaining >= 1) {
    openAIDestroyModal(target);
  } else if (destroyAdRemaining >= 1) {
    openAIDestroyAdModal(target);
  } else {
    // No free destroys and no ad recharges left — AI has nowhere to go.
    autoplayState.pendingDestroy = null;
    stopAutoplay();
  }
}


function createCellElement(cell, opts = {}) {
  const el = document.createElement('div');
  el.className = 'cell super pre-paint';
  el.dataset.id = cell.id;
  // Super cell layout: outer donut (conic-gradient of probabilities) + center
  // mini mascot (dominant color, with eyes + mouth). Observed cells reuse the
  // mini’s structure as the full face via render().
  el.innerHTML = `
    <div class="donut"></div>
    <div class="mini"><div class="mm"></div></div>
    <div class="face-mouth"></div>
  `;

  // Long-press (≥ LONG_PRESS_MS, with no movement past LONG_PRESS_SLOP_PX)
  // opens the probability tooltip and suppresses the tap. A short click still
  // calls onTap as before. Once the tooltip is open, sliding the finger to
  // another cell updates the tooltip to that cell's probabilities — handled
  // by a global pointermove listener installed in showCellProbTooltip, so the
  // gesture continues across cell boundaries.
  let pressTimer = null;
  let pressStart = null;
  let suppressClick = false;
  const startPress = (clientX, clientY) => {
    cancelPress();
    pressStart = { x: clientX, y: clientY };
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true;
      const pos = findCellPos(cell.id);
      if (pos) showCellProbTooltip(pos.x, pos.y);
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressStart = null;
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    suppressClick = false;
    startPress(e.clientX, e.clientY);
  });
  el.addEventListener('pointermove', (e) => {
    // Slop guard only matters BEFORE long-press fires. Once the tooltip is up
    // the global handler takes over and movement is intentional.
    if (!pressStart || probTooltipEl) return;
    const dx = e.clientX - pressStart.x;
    const dy = e.clientY - pressStart.y;
    if (dx * dx + dy * dy > LONG_PRESS_SLOP_PX * LONG_PRESS_SLOP_PX) cancelPress();
  });
  // pointerup / pointercancel still cancel the pending press if the timer
  // hasn't fired yet. After the timer fires the global listener handles
  // release-to-dismiss; we don't want to dismiss here on pointerleave
  // because that fires as soon as the finger slides off this specific cell.
  el.addEventListener('pointerup', () => {
    cancelPress();
    // Once long-press has fired, the global listener handles dismissal so
    // we don't race the slide-to-next-cell flow.
    if (suppressClick && !probTooltipEl) dismissCellProbTooltip();
  });
  el.addEventListener('pointercancel', cancelPress);
  el.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const pos = findCellPos(cell.id);
    if (pos) onTap(pos.x, pos.y);
  });
  if (opts.spawnAbove) el.classList.add('above');
  if (cell.special === 'metal') {
    el.classList.add('spawned-observed', 'special-metal');
    el.innerHTML += `
      <div class="cursed-facet"></div>
      <div class="cursed-rivets"><div class="cursed-rivet tl"></div><div class="cursed-rivet tr"></div><div class="cursed-rivet bl"></div><div class="cursed-rivet br"></div></div>
    `;
  } else if (cell.special === 'painted') {
    el.classList.add('special-painted');
  }
  boardEl.appendChild(el);
  cellEls.set(cell.id, el);
  return el;
}

// Once a cell has had positionCell() called on it, drop the pre-paint guard so
// it becomes visible at its real slot rather than at the (0,0) corner.
function revealCell(el) {
  if (el && el.classList.contains('pre-paint')) {
    el.classList.remove('pre-paint');
  }
}

// ─── Probability inspector tooltip ───
// Long-pressing any cell pops a small floating panel listing each active
// color's probability (or 100% on the observed color). Lets the player
// inspect a cell without committing a tap. Dismisses when the long-press
// is released, or on any pointer interaction outside the tooltip.
let probTooltipEl = null;
let probTooltipDismissBound = false;
let probTooltipPos = { x: -1, y: -1 };
function dismissCellProbTooltip() {
  if (probTooltipEl) {
    probTooltipEl.remove();
    probTooltipEl = null;
  }
  probTooltipPos = { x: -1, y: -1 };
}
function showCellProbTooltip(x, y) {
  dismissCellProbTooltip();
  const cell = board[y]?.[x];
  if (!cell) return;
  const anchorEl = cellEls.get(cell.id);
  if (!anchorEl) return;

  const t = document.createElement('div');
  t.className = 'cell-prob-tooltip';

  // Build rows: observed → single 100% row; super → all active colors descending.
  const rows = [];
  if (cell.state === 'observed' && cell.color) {
    rows.push({ color: cell.color, pct: 100 });
  } else {
    const probs = cell.probs || {};
    for (const c of activeColors) rows.push({ color: c, pct: Math.round((probs[c] || 0) * 100) });
    rows.sort((a, b) => b.pct - a.pct);
  }

  const t9n = (key, fallback) => (window.QSI18n ? window.QSI18n.t(key) : fallback);
  const colorName = (c) => {
    const key = { r: 'next.red', b: 'next.blue', y: 'next.yellow', g: 'next.green', p: 'next.purple' }[c];
    return key ? t9n(key, COLOR_LABEL[c]) : COLOR_LABEL[c];
  };
  t.innerHTML = rows.map(({ color, pct }) => `
    <div class="cell-prob-row">
      <span class="cell-prob-swatch" style="background: rgb(${COLOR_RGB[color]})"></span>
      <span class="cell-prob-name">${colorName(color)}</span>
      <span class="cell-prob-pct">${pct}%</span>
    </div>
  `).join('');

  document.body.appendChild(t);

  // Position beside the cell so the held cell itself stays visible. Prefer
  // right side, then left, then below the cell, then above — and never let
  // the tooltip overlap the anchor cell rectangle.
  const rect = anchorEl.getBoundingClientRect();
  const tRect = t.getBoundingClientRect();
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left, top;
  if (rect.right + gap + tRect.width + 8 <= vw) {
    // Right side fits
    left = rect.right + gap;
    top = rect.top + rect.height / 2 - tRect.height / 2;
  } else if (rect.left - gap - tRect.width - 8 >= 0) {
    // Left side fits
    left = rect.left - gap - tRect.width;
    top = rect.top + rect.height / 2 - tRect.height / 2;
  } else if (rect.bottom + gap + tRect.height + 8 <= vh) {
    // Below fits
    left = rect.left + rect.width / 2 - tRect.width / 2;
    top = rect.bottom + gap;
  } else {
    // Fall back to above (last resort)
    left = rect.left + rect.width / 2 - tRect.width / 2;
    top = Math.max(8, rect.top - gap - tRect.height);
  }
  left = Math.max(8, Math.min(left, vw - tRect.width - 8));
  top = Math.max(8, Math.min(top, vh - tRect.height - 8));
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;

  probTooltipEl = t;
  if (!probTooltipDismissBound) {
    probTooltipDismissBound = true;
    const onDismiss = (e) => {
      if (!probTooltipEl) return;
      if (e && e.target && probTooltipEl.contains(e.target)) return;
      dismissCellProbTooltip();
    };
    // Slide-to-inspect: while the finger is still down and the tooltip is
    // open, sliding to another cell updates the tooltip to that cell.
    const onMove = (e) => {
      if (!probTooltipEl) return;
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target) return;
      const cellEl = target.closest('.cell');
      if (!cellEl) return;
      const id = cellEl.dataset.id;
      if (!id) return;
      const pos = findCellPos(Number(id));
      if (!pos) return;
      if (pos.x === probTooltipPos.x && pos.y === probTooltipPos.y) return;
      showCellProbTooltip(pos.x, pos.y);
    };
    const onUp = () => {
      // Releasing the finger ends the inspect gesture.
      dismissCellProbTooltip();
    };
    window.addEventListener('pointerdown', onDismiss, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('scroll', dismissCellProbTooltip, true);
  }
  probTooltipPos = { x, y };
}

function findCellPos(id) {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (board[y][x] && board[y][x].id === id) return { x, y };
  }
  return null;
}

function elAt(x, y) {
  const c = board[y]?.[x];
  return c ? cellEls.get(c.id) : null;
}

function destroyCellElement(id) {
  const el = cellEls.get(id);
  if (el) {
    const donut = el.querySelector('.donut');
    if (donut) donutAnim.delete(donut);
    el.remove();
    cellEls.delete(id);
  }
}

function updateCellSize() {
  const w = boardEl.getBoundingClientRect().width;
  if (!w) return;
  const gap = 6;
  cellSize = (w - gap * (N - 1)) / N;
  boardEl.style.setProperty('--cs', `${cellSize}px`);
  boardEl.style.setProperty('--gap', `${gap}px`);
}

function buildDOM() {
  Array.from(boardEl.querySelectorAll('.cell')).forEach(n => n.remove());
  cellEls.clear();
  updateCellSize();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // Pin each cell to its slot immediately, with transitions disabled, so we
    // never see the freshly-built (0,0)-anchored cells slide into place from
    // the top-left corner on first render.
    const el = createCellElement(board[y][x]);
    el.classList.add('no-transition');
    positionCell(el, x, y);
  }
  // After paint, drop the no-transition guard so subsequent moves animate.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      boardEl.querySelectorAll('.cell.no-transition').forEach(c => c.classList.remove('no-transition'));
    });
  });
}

const DONUT_TWEEN_MS = 240;
const donutAnim = new WeakMap();

function paintDonut(donut, probs, order) {
  let accum = 0;
  const stops = [];
  for (const c of order) {
    const p = probs[c];
    if (p <= 0) continue;
    const start = accum * 100;
    accum += p;
    const end = accum * 100;
    stops.push(`rgb(${COLOR_RGB[c]}) ${start.toFixed(2)}% ${end.toFixed(2)}%`);
  }
  donut.style.background = stops.length > 0
    ? `conic-gradient(from 0deg, ${stops.join(', ')})`
    : '#f0e0d0';
}

function updateDonut(el, probs) {
  const donut = el.querySelector('.donut');
  if (!donut) return;
  const state = donutAnim.get(donut);
  const evenStart = {};
  for (const c of COLORS) evenStart[c] = activeColors.includes(c) ? 1 / activeColors.length : 0;
  const from = state ? { ...state.current } : evenStart;
  const target = {};
  for (const c of COLORS) target[c] = probs[c] ?? 0;
  const epsilon = 0.001;
  let unchanged = true;
  for (const c of COLORS) {
    if (Math.abs((from[c] ?? 0) - target[c]) > epsilon) { unchanged = false; break; }
  }
  if (unchanged) {
    if (!state) {
      const order = COLORS.slice().sort((a, b) => target[b] - target[a]);
      paintDonut(donut, target, order);
      donutAnim.set(donut, { current: target, raf: null });
    }
    return;
  }
  if (state && state.raf) cancelAnimationFrame(state.raf);
  const order = COLORS.slice().sort((a, b) => target[b] - target[a]);
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / DONUT_TWEEN_MS);
    const k = 1 - Math.pow(1 - t, 3);
    const cur = {};
    for (const c of COLORS) cur[c] = (from[c] ?? 0) + (target[c] - (from[c] ?? 0)) * k;
    paintDonut(donut, cur, order);
    const next = t < 1 ? requestAnimationFrame(tick) : null;
    donutAnim.set(donut, { current: cur, raf: next });
  };
  donutAnim.set(donut, { current: from, raf: requestAnimationFrame(tick) });
}

function positionCell(el, x, y) {
  const gap = 6;
  const cs = cellSize || 60;
  const step = cs + gap;
  el.style.transform = `translate(${x * step}px, ${y * step}px)`;
  // Reveal the cell now that it has a real transform. Cells start invisible
  // (pre-paint class) so they never flash at the board's (0,0) origin.
  revealCell(el);
}

function render() {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cell = board[y][x];
    if (!cell) continue;
    const el = cellEls.get(cell.id);
    if (!el) continue;
    // Position the element at its current (x, y). CSS transition makes movement
    // smooth when gravity rearranges the data.
    //   - skip if `.above` is set: the spawn flow has put the element above
    //     the board on purpose; positioning is finalized in a later rAF tick
    //     so that the transition actually has somewhere to animate from.
    if (!el.classList.contains('above')) positionCell(el, x, y);
    if (el.classList.contains('matching')) continue;
    el.classList.remove('super', 'observed');
    el.classList.add(cell.state);
    if (cell.state === 'super') {
      const predicted = pickDominant(cell.probs);
      el.dataset.pip = predicted;
      el.style.setProperty('--pip', `rgb(${COLOR_RGB[predicted]})`);
      el.style.setProperty('--pip-dark', `rgb(${COLOR_DARK[predicted]})`);
      delete el.dataset.c;
      updateDonut(el, cell.probs);
    } else {
      // Observed: hide donut/mini, show body color + face via data-c
      el.dataset.c = cell.color;
      delete el.dataset.pip;
    }
    // Highlight observed cells whose color matches the current NEXT.
    const req = nextRequiredColor();
    if (cell.state === 'observed' && cell.color === req) el.classList.add('is-next-match');
    else el.classList.remove('is-next-match');
  }
  $('score').textContent = score;
  applyNextColorVisuals();
  applyComboBadge();
  applyComboCenter();
  applyHeaderIcons();
  // Re-evaluate score-gated UI (destroy button appears at DESTROY_UNLOCK_SCORE)
  // so the button materializes on the same frame the threshold is crossed.
  if (typeof updateDestroyUI === 'function') updateDestroyUI();
  updateNextUnlock();
}

// Score-gated unlock milestones for the "next unlock" indicator. Each
// score here MUST stay in sync with the live game gates:
//   - UNLOCK_THRESHOLDS (color joins)
//   - DESTROY_UNLOCK_SCORE
//   - AUTOPLAY_UNLOCK_SCORE
//   - cursedSpawnInterval thresholds
// `icon` is rendered as inline HTML by renderUnlockIcon() so we can reuse
// the same SVG/CSS assets already used elsewhere in the UI (mascots,
// destroy hammer, autoplay AI face, cursed cell rivet preview).
const UNLOCK_MILESTONES = [
  { score: 1000,  i18nKey: 'nextUnlock.colorG',         icon: 'mascot-g' },
  { score: 2000,  i18nKey: 'nextUnlock.destroy',        icon: 'destroy' },
  { score: 5000,  i18nKey: 'nextUnlock.colorP',         icon: 'mascot-p' },
  { score: 7000,  i18nKey: 'nextUnlock.ai',             icon: 'ai' },
  // Difficulty ramp milestones — keep score values aligned with specialSpawnConfig.
  { score: 10000, i18nKey: 'nextUnlock.paintedStart',   icon: 'painted' },
  { score: 15000, i18nKey: 'nextUnlock.paintedFaster',  icon: 'painted' },
  { score: 20000, i18nKey: 'nextUnlock.metalStart',     icon: 'cursed' },
  { score: 25000, i18nKey: 'nextUnlock.specialFaster1', icon: 'cursed' },
  { score: 30000, i18nKey: 'nextUnlock.metalRatio1',    icon: 'cursed' },
  { score: 35000, i18nKey: 'nextUnlock.specialFaster2', icon: 'cursed' },
  { score: 40000, i18nKey: 'nextUnlock.metalRatio2',    icon: 'cursed' },
  { score: 45000, i18nKey: 'nextUnlock.specialEveryMatch', icon: 'cursed' },
  { score: 50000, i18nKey: 'nextUnlock.metalAll',       icon: 'cursed' },
];
function renderUnlockIcon(kind) {
  switch (kind) {
    case 'mascot-g':
      return '<span class="quest-mascot g"><span class="quest-mascot-face"></span></span>';
    case 'mascot-p':
      return '<span class="quest-mascot p"><span class="quest-mascot-face"></span></span>';
    case 'destroy':
      return `<svg class="quest-icon" viewBox="0 0 24 24" aria-hidden="true">
        <g transform="rotate(-32 12 12)">
          <rect x="11" y="9" width="2.5" height="13" rx="1.25" fill="#8a5a3a"/>
          <rect x="6.2" y="3" width="11.6" height="6.6" rx="1.6" fill="#3a3a44"/>
          <rect x="6.2" y="3" width="11.6" height="2.2" rx="1.6" fill="#5a5a66"/>
        </g>
      </svg>`;
    case 'ai':
      return '<span class="quest-ai"><span class="quest-ai-face"></span></span>';
    case 'painted':
      return '<span class="quest-painted"></span>';
    case 'cursed':
      return `<span class="quest-cursed">
        <span class="quest-cursed-facet"></span>
        <span class="quest-cursed-rivet tl"></span>
        <span class="quest-cursed-rivet tr"></span>
        <span class="quest-cursed-rivet bl"></span>
        <span class="quest-cursed-rivet br"></span>
      </span>`;
    default:
      return '';
  }
}
// Wraps ASCII digit runs so CSS can fix the baseline drift between
// Korean display fonts and their digit glyphs. Escapes HTML first.
function wrapNumbers(text) {
  if (text == null) return '';
  const escaped = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/[\d][\d,%./]*/g, m => `<span class="quest-num">${m}</span>`);
}
function updateNextUnlock() {
  const wrap = document.getElementById('next-unlock');
  if (!wrap) return;
  const iconEl = document.getElementById('next-unlock-icon');
  const nameEl = document.getElementById('next-unlock-name');
  const progEl = document.getElementById('next-unlock-progress');
  const fillEl = document.getElementById('next-unlock-bar-fill');
  const next = UNLOCK_MILESTONES.find(m => score < m.score);
  if (!next) {
    if (iconEl) iconEl.innerHTML = '';
    if (nameEl) nameEl.textContent = window.QSI18n?.t('nextUnlock.allDone') || 'All unlocks reached';
    if (progEl) progEl.textContent = '';
    if (fillEl) fillEl.style.width = '100%';
    wrap.hidden = false;
    return;
  }
  if (iconEl) iconEl.innerHTML = renderUnlockIcon(next.icon);
  if (nameEl) nameEl.innerHTML = wrapNumbers(window.QSI18n?.t(next.i18nKey) || next.i18nKey);
  if (progEl) progEl.innerHTML = wrapNumbers(`${score.toLocaleString()} / ${next.score.toLocaleString()}`);
  if (fillEl) {
    // Fill spans the current tier (prev → next), not 0 → next.
    const idx = UNLOCK_MILESTONES.indexOf(next);
    const prev = idx > 0 ? UNLOCK_MILESTONES[idx - 1].score : 0;
    const range = Math.max(1, next.score - prev);
    const pct = Math.max(0, Math.min(100, ((score - prev) / range) * 100));
    fillEl.style.width = pct.toFixed(1) + '%';
  }
  wrap.hidden = false;
}

function applyNextColorVisuals() {
  const next = nextRequiredColor();
  const rgb = COLOR_RGB[next];
  const dark = COLOR_DARK[next];
  const colorVar = `rgb(${rgb})`;
  const darkVar = `rgb(${dark})`;
  const glowVar = `rgba(${rgb}, 0.45)`;
  const root = document.documentElement;
  root.style.setProperty('--next-color', colorVar);
  root.style.setProperty('--next-dark', darkVar);
  root.style.setProperty('--next-shadow', glowVar);

  const strip = $('next-strip');
  if (strip) strip.dataset.c = next;
  const mascot = $('next-mascot');
  if (mascot) mascot.dataset.c = next;
  const label = $('next-text');
  if (label) {
    const i18nKey = { r: 'next.red', b: 'next.blue', y: 'next.yellow', g: 'next.green', p: 'next.purple' }[next];
    label.textContent = (window.QSI18n && i18nKey) ? window.QSI18n.t(i18nKey) : COLOR_LABEL[next];
  }
}

// Stamp-stack rendering: each successful combo pushes a new stamp onto the
// stack with a slightly different rotation/offset; older stamps fade and
// eventually drop off. The most recent stamp keeps full saturation.
let lastRenderedComboStreak = 0;
const MAX_STAMPS = 4;  // beyond this, oldest are removed

function applyComboBadge() {
  const stack = $('combo-stack');
  if (!stack) return;

  // Streak reset → clear all stamps.
  if (comboStreak <= 0) {
    if (lastRenderedComboStreak !== 0) {
      // Fade everything out then remove.
      for (const el of stack.querySelectorAll('.combo-stamp')) {
        el.classList.add('gone');
        setTimeout(() => el.remove(), 450);
      }
      lastRenderedComboStreak = 0;
    }
    return;
  }

  // Only add a new stamp when the streak actually grew (not on every render).
  if (comboStreak <= lastRenderedComboStreak) return;
  lastRenderedComboStreak = comboStreak;

  // Demote prior stamps: latest → fading, increase --fade.
  const existing = Array.from(stack.querySelectorAll('.combo-stamp'));
  for (const el of existing) {
    el.classList.remove('latest');
    el.classList.add('fading');
    const cur = parseFloat(el.style.getPropertyValue('--fade') || '0');
    const next = Math.min(1, cur + 0.32);
    el.style.setProperty('--fade', next.toFixed(2));
    if (next >= 1) {
      el.classList.add('gone');
      setTimeout(() => el.remove(), 450);
    }
  }
  // Cap stamps in flight.
  while (stack.querySelectorAll('.combo-stamp').length >= MAX_STAMPS) {
    const oldest = stack.querySelector('.combo-stamp');
    if (!oldest) break;
    oldest.classList.add('gone');
    setTimeout(() => oldest.remove(), 450);
    // Break out of loop after marking; we will let removal complete async.
    break;
  }

  // Create the new stamp.
  const stamp = document.createElement('div');
  stamp.className = 'combo-stamp latest';
  // Random-ish rotation and small offset so successive stamps don't perfectly
  // overlap. Range is gentle so the stack still reads as one element.
  const rot = (Math.random() * 14 - 7).toFixed(1);
  const tx = (Math.random() * 16 - 8).toFixed(1);
  const ty = (Math.random() * 10 - 5).toFixed(1);
  stamp.style.setProperty('--rot', `${rot}deg`);
  stamp.style.setProperty('--tx', `${tx}px`);
  stamp.style.setProperty('--ty', `${ty}px`);

  const color = lastMatchColor || 'r';
  stamp.innerHTML = `
    <div class="combo-mascot" data-c="${color}"
         style="background: rgb(${COLOR_RGB[color]}); box-shadow: 0 3px 0 rgb(${COLOR_DARK[color]});">
      <div class="m-mouth"></div>
    </div>
    <div class="combo-text" style="color: rgb(${COLOR_DARK[color]});">×${comboStreak}</div>
  `;
  stack.appendChild(stamp);
}

// Combo readout in the score-card center column.
let _lastShownComboStreak = 0;
function applyComboCenter() {
  const el = $('combo-center');
  const valueEl = $('combo-value');
  if (!el || !valueEl) return;
  valueEl.textContent = `×${comboStreak}`;
  const color = lastMatchColor || 'r';
  el.style.setProperty('--combo-color', `rgb(${COLOR_RGB[color]})`);
  if (comboStreak <= 0) el.classList.add('is-zero');
  else el.classList.remove('is-zero');
  // Brief bump animation when streak grows.
  if (comboStreak > _lastShownComboStreak) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
    setTimeout(() => el.classList.remove('bump'), 250);
  }
  _lastShownComboStreak = comboStreak;
}

function applyHeaderIcons() {
  const wrap = $('title-icons');
  if (!wrap) return;
  if (wrap.dataset.colors === activeColors.join(',')) return;
  wrap.dataset.colors = activeColors.join(',');
  wrap.innerHTML = '';
  for (const c of activeColors) {
    const sp = document.createElement('span');
    sp.className = `icon-mini ${c}`;
    const mouth = document.createElement('span');
    mouth.className = 'face-mouth';
    sp.appendChild(mouth);
    wrap.appendChild(sp);
  }
}

function particles(el, color, count = 12) {
  const rect = el.getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  const colStr = `rgb(${COLOR_RGB[color]})`;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = cx + 'px';
    p.style.top = cy + 'px';
    p.style.background = colStr;
    p.style.boxShadow = `0 0 10px ${colStr}, 0 0 20px ${colStr}`;
    const a = Math.random() * Math.PI * 2;
    const d = 22 + Math.random() * 36;
    p.style.setProperty('--dx', Math.cos(a) * d + 'px');
    p.style.setProperty('--dy', Math.sin(a) * d + 'px');
    el.appendChild(p);
    setTimeout(() => p.remove(), 800);
  }
}

// Shatter effect: large color shards fly outward with rotation. Used when a
// cell is destroyed via the destroy booster. Shards are appended to the board
// container (not the cell) so they survive after the cell is removed.
function shatter(el, color, count = 10) {
  const colStr = `rgb(${COLOR_RGB[color] || COLOR_RGB.r})`;
  const elRect = el.getBoundingClientRect();
  const parentRect = boardEl.getBoundingClientRect();
  const cx = elRect.left - parentRect.left + elRect.width / 2;
  const cy = elRect.top - parentRect.top + elRect.height / 2;
  for (let i = 0; i < count; i++) {
    const s = document.createElement('div');
    s.className = 'shatter-shard';
    const size = 7 + Math.random() * 9;
    s.style.width = `${size}px`;
    s.style.height = `${size}px`;
    s.style.left = `${cx}px`;
    s.style.top = `${cy}px`;
    s.style.background = colStr;
    s.style.boxShadow = `0 1px 3px rgba(0,0,0,0.25), 0 0 8px ${colStr}`;
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const d = 36 + Math.random() * 44;
    s.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * d + 18}px`);
    s.style.setProperty('--rot', `${(Math.random() * 720 - 360).toFixed(0)}deg`);
    boardEl.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }
  const ring = document.createElement('div');
  ring.className = 'shatter-ring';
  ring.style.left = `${cx}px`;
  ring.style.top = `${cy}px`;
  boardEl.appendChild(ring);
  setTimeout(() => ring.remove(), 600);
}

function emitPropagationWaves(x, y, color) {
  // For each of the 8 neighbors that is still super, send a small color projectile
  // from the observed cell toward the neighbor's center. The visual sits on the board
  // overlay (boardEl) so it is not clipped by individual cell overflow.
  const colStr = `rgb(${COLOR_RGB[color]})`;
  const srcEl = elAt(x, y);
  if (!srcEl) return;
  const sourceRect = srcEl.getBoundingClientRect();
  const boardRect = boardEl.getBoundingClientRect();
  const sx = sourceRect.left - boardRect.left + sourceRect.width / 2;
  const sy = sourceRect.top - boardRect.top + sourceRect.height / 2;
  for (const [nx, ny] of neighbors(x, y)) {
    if (board[ny][nx].state !== 'super') continue;
    const tgtEl = elAt(nx, ny);
    if (!tgtEl) continue;
    const targetRect = tgtEl.getBoundingClientRect();
    const tx = targetRect.left - boardRect.left + targetRect.width / 2;
    const ty = targetRect.top - boardRect.top + targetRect.height / 2;
    const wave = document.createElement('div');
    wave.className = 'propagation';
    wave.style.left = `${sx}px`;
    wave.style.top = `${sy}px`;
    wave.style.background = colStr;
    wave.style.boxShadow = `0 0 12px ${colStr}, 0 0 24px ${colStr}`;
    wave.style.setProperty('--dx', `${tx - sx}px`);
    wave.style.setProperty('--dy', `${ty - sy}px`);
    boardEl.appendChild(wave);
    setTimeout(() => wave.remove(), 480);
  }
}

function showToast(msg, ms = 1100) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function applyGravityForMatches(matchedList, opts = {}) {
  // opts.fromDestroy: skip special-cell spawn — destroy-paid clears must
  // not drop a sticky replacement back into the freed slot.
  const cleared = Array.from({ length: N }, () => new Array(N).fill(false));
  for (const [mx, my] of matchedList) cleared[my][mx] = true;

  const spawned = [];  // new super cells inserted at top of columns
  for (let x = 0; x < N; x++) {
    const survivors = [];
    for (let y = N - 1; y >= 0; y--) {
      if (!cleared[y][x]) survivors.push(board[y][x]);
    }
    // Pack survivors at the bottom of the column
    for (let y = N - 1; y >= 0; y--) {
      const cell = survivors.shift();
      if (cell) {
        board[y][x] = cell;
      } else {
        const fresh = initCell();
        board[y][x] = fresh;
        spawned.push({ cell: fresh, x, spawnRow: -1 });
      }
    }
  }

  // Per-match special-cell spawn — see specialSpawnConfig for the curve.
  // First crossing of 10k (painted) and 20k (metal) is force-spawned so
  // the player sees the new mechanic on the very cascade that unlocked it.
  const cfg = specialSpawnConfig(score);
  let forceVariant = null;
  if (!opts.fromDestroy) {
    if (score >= 10000 && !firstPaintedSpawned) forceVariant = 'painted';
    if (score >= 20000 && !firstMetalSpawned)   forceVariant = 'metal';
  }
  const intervalHit = !opts.fromDestroy && cfg.interval !== Infinity && matchCount % cfg.interval === 0;
  if (spawned.length > 0 && (intervalHit || forceVariant)) {
    const pickIdx = Math.floor(Math.random() * spawned.length);
    const sp = spawned[pickIdx];
    const color = activeColors[Math.floor(Math.random() * activeColors.length)];
    sp.cell.state = 'observed';
    sp.cell.color = color;
    // Probs no longer drive rendering (it's observed) but normalise anyway
    // so any sim code that inspects probs sees a sane value.
    for (const c of activeColors) sp.cell.probs[c] = 0;
    sp.cell.probs[color] = 1;
    let isMetal;
    if (forceVariant) {
      isMetal = forceVariant === 'metal';
    } else {
      isMetal = Math.random() < cfg.metalRatio;
    }
    sp.cell.special = isMetal ? 'metal' : 'painted';
    if (sp.cell.special === 'painted') firstPaintedSpawned = true;
    if (sp.cell.special === 'metal')   { firstMetalSpawned = true; firstPaintedSpawned = true; }
    if (isMetal) unlockRule('cursed');
  }

  return spawned;
}

// Cascade runs as a sequence of waves:
//   wave start → mark exploding cells (MATCH_ANIM_MS)
//   → destroy exploded cells, apply gravity, spawn new cells (FALL_MS)
//   → check for the next wave, recurse if needed
// This staging keeps the explosion visually clear before the drop begins.
let cascadeBusy = false;
let cascadeTotal = 0;

function resolveCascade() {
  if (cascadeBusy) return;
  startCascadeWave(0);
}

function startCascadeWave(totalSoFar) {
  const matched = findMatches();
  if (matched.size === 0) {
    cascadeBusy = false;
    cascadeTotal = 0;
    // No matches at all → cycle state is preserved indefinitely. Tapping to
    // shape the board (without producing a match) does not punish the streak.
    tapWillResolveCombo = false;
    checkGameOver();
    return;
  }
  cascadeBusy = true;
  cascadeTotal = totalSoFar;

  matchCount += 1;
  unlockRule('matchBasic');
  // This tap just triggered another wave — extend the per-tap chain.
  chainThisTap += 1;
  if (chainThisTap > maxChainThisGame) maxChainThisGame = chainThisTap;
  if (chainThisTap >= 2) unlockRule('cascade');
  // Pick the dominant color of this wave's matched cells. Initialize all 5
  // color slots so newly-unlocked colors (G, P) also get counted — otherwise
  // their tally is undefined and they never win the "wave color" vote.
  const colorTally = { r: 0, b: 0, y: 0, g: 0, p: 0 };
  for (const k of matched) {
    const [my, mx] = k.split(',').map(Number);
    const c = board[my][mx].color;
    if (c) colorTally[c]++;
  }
  let waveColor = COLORS[0];
  for (const c of COLORS) if (colorTally[c] > colorTally[waveColor]) waveColor = c;
  lastMatchColor = waveColor;

  // Cycle-driven scoring: only matches in the required color earn points and
  // advance the cycle. Off-cycle matches still clear the board (visual match
  // animation runs) but score nothing and leave the cycle untouched.
  const required = nextRequiredColor();
  const onCycle = waveColor === required;
  tapWillResolveCombo = false;

  const total = totalSoFar + matched.size;
  const bonus = total > 3 ? 3 : 0;
  const baseScore = matched.size * 10 + (matched.size - 3) * 5 + bonus * 8;
  let gained = 0;
  if (onCycle) {
    comboStreak += 1;
    if (comboStreak >= 2) unlockRule('combo');
    if (comboStreak > maxComboThisGame) maxComboThisGame = comboStreak;
    cycleIndex = (cycleIndex + 1) % activeColors.length;
    const mult = comboMultiplier();
    if (mult > 1) unlockRule('comboMultiplier');
    gained = Math.round((baseScore + NEXT_BONUS) * mult);
    score += gained;
    checkColorUnlocks();
    if (hooks.onCombo) hooks.onCombo(comboStreak);
  } else {
    // Off-cycle match: still awards base score (×1.0) so every clear feels
    // worthwhile, but the combo streak breaks. Players keep gaining points
    // while losing the multiplier bonus they had built up.
    gained = baseScore;
    score += gained;
    checkColorUnlocks();
    if (comboStreak > 0) {
      triggerComboBreakFx(comboStreak);
      if (hooks.onCombo) hooks.onCombo(0);
    }
    comboStreak = 0;
  }

  const matchedList = [];        // coords that will be cleared from the board
  const explodingCells = [];     // cells whose DOM gets the .matching anim + removal
  const downgradedCells = [];    // metal cells: stay on the board, demoted to painted
  for (const k of matched) {
    const [my, mx] = k.split(',').map(Number);
    const c = board[my][mx];
    if (c.special === 'metal') {
      // First match downgrades metal → painted; the second match clears it.
      downgradedCells.push(c);
    } else {
      matchedList.push([mx, my]);
      explodingCells.push(c);
    }
  }
  if (hooks.onMatch) hooks.onMatch(matched.size, onCycle);
  if (window.QSAudio) window.QSAudio.playMatch(matched.size, comboStreak);

  // Phase 1: explosion — let the matched cells finish their burst undisturbed.
  for (const c of explodingCells) {
    const el = cellEls.get(c.id);
    if (!el) continue;
    el.classList.add('matching');
    if (c.color) particles(el, c.color, 20);
  }
  // One pooled "+N" popup at the matched region's centroid instead of N
  // tiny ones scattered across each cell — easier to read and tracks the
  // actual total gained from this wave.
  if (gained > 0) showScorePopupAt(matchedList, gained);
  flashMatchLine(matchedList);
  render();

  // Phase 2: after the explosion is fully visible, remove those cells and
  // apply gravity so the survivors drop into the now-empty slots.
  setTimeout(() => {
    for (const c of explodingCells) destroyCellElement(c.id);
    // Strip the metal skin from the DOM as the cell demotes to painted.
    for (const c of downgradedCells) {
      c.special = 'painted';
      const dEl = cellEls.get(c.id);
      if (dEl) {
        dEl.classList.remove('spawned-observed', 'special-metal');
        dEl.classList.add('special-painted');
        dEl.querySelector(':scope > .cursed-facet')?.remove();
        dEl.querySelector(':scope > .cursed-rivets')?.remove();
      }
    }
    const spawned = applyGravityForMatches(matchedList);
    for (const sp of spawned) {
      const el = createCellElement(sp.cell, { spawnAbove: true });
      // Start spawn cells well above the board (y = -N) so they travel a
      // longer visual distance than the 1-row survivor shuffle. This breaks
      // the rigid-column illusion that made middle-row matches read as
      // "row 0 doesn't move, new cells appear from behind it".
      positionCell(el, sp.x, -N);
      // Force a synchronous style recalc so the browser commits the
      // above-the-board transform as the cell's *current* transform. Without
      // this, the first-ever spawn cycle can collapse the start and end
      // transforms into a single style update and skip the transition.
      void el.offsetWidth;
    }
    render();
    // Trigger the drop transition for spawned cells on the next frame:
    // remove `.above` (re-enabling transition) AND set the final transform
    // in the same tick so CSS animates from y=-1 to the cell's slot.
    // `spawning` keeps the new cell behind survivors so falling neighbours
    // visibly slide *in front* of it.
    // Two rAF ticks: the FIRST ensures the browser has computed style with
    // `.above` (transition: none) and the spawn-above transform applied. The
    // SECOND tick removes `.above` (re-enabling transition) and sets the
    // final transform — the browser now sees a real before/after diff and
    // the transition fires.
    //
    // Without the double-rAF, the very first spawn cycle after a fresh
    // DOM-attach can fold the spawn-above transform and the final transform
    // into the same style-recalc, causing the cell to snap to its final
    // position with no transition visible.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const sp of spawned) {
          const el = cellEls.get(sp.cell.id);
          if (!el) continue;
          el.classList.remove('above');
          el.classList.add('spawning');
          const pos = findCellPos(sp.cell.id);
          if (pos) positionCell(el, pos.x, pos.y);
          setTimeout(() => el.classList.remove('spawning'), FALL_MS);
        }
      });
    });
    if (window.QSAudio) setTimeout(() => window.QSAudio.playLand(), FALL_MS - 80);

    // Phase 3: after the drop settles, look for the next cascade wave.
    setTimeout(() => startCascadeWave(total), FALL_MS);
  }, MATCH_ANIM_MS);
}

function showScorePopup(el, points) {
  const pop = document.createElement('div');
  pop.className = 'score-pop';
  pop.textContent = `+${points}`;
  el.appendChild(pop);
  setTimeout(() => pop.remove(), 900);
}
// Float a single "+N" over the matched region's centroid. Briefly drifts
// upward and fades out — matched.size cells share one popup rather than
// each cell getting its own fraction of the score.
function showScorePopupAt(matchedList, points) {
  if (!matchedList.length || !boardEl) return;
  const gap = 6;
  const cs = cellSize || 60;
  const step = cs + gap;
  let sx = 0, sy = 0;
  for (const [x, y] of matchedList) { sx += x; sy += y; }
  const cx = (sx / matchedList.length) * step + cs / 2;
  const cy = (sy / matchedList.length) * step + cs / 2;
  const pop = document.createElement('div');
  pop.className = 'score-pop region';
  pop.textContent = `+${points}`;
  pop.style.left = cx + 'px';
  pop.style.top = cy + 'px';
  boardEl.appendChild(pop);
  setTimeout(() => pop.remove(), 900);
}

function flashMatchLine(coords) {
  if (coords.length < 3) return;
  const xs = coords.map(c => c[0]);
  const ys = coords.map(c => c[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const horizontal = maxY === minY;
  const flash = document.createElement('div');
  flash.className = `match-flash ${horizontal ? 'h' : 'v'}`;
  // Compute pixel coords directly from grid metrics.
  const gap = 6;
  const cs = cellSize || 60;
  const xPx = (i) => i * (cs + gap);
  const yPx = (i) => i * (cs + gap);
  if (horizontal) {
    flash.style.left = `${xPx(minX)}px`;
    flash.style.top = `${yPx(minY) + cs / 2 - 2}px`;
    flash.style.width = `${xPx(maxX) + cs - xPx(minX)}px`;
  } else {
    flash.style.left = `${xPx(minX) + cs / 2 - 2}px`;
    flash.style.top = `${yPx(minY)}px`;
    flash.style.height = `${yPx(maxY) + cs - yPx(minY)}px`;
  }
  boardEl.appendChild(flash);
  setTimeout(() => flash.remove(), 520);
}

// Color-tinted stamp shown for big matches (4+) and chained cascades.
// Styled like the combo stamp: rotated, scaled-in pop, tinted by match color.
function showMatchStamp(text, color, size = 'small') {
  const stamp = document.createElement('div');
  stamp.className = `match-stamp ${size}`;
  stamp.textContent = text;
  // Random tilt so each stamp lands at a slightly different angle.
  const rot = (Math.random() * 12 - 6).toFixed(1);
  stamp.style.setProperty('--rot', `${rot}deg`);
  stamp.style.setProperty('--c',      `rgb(${COLOR_RGB[color]})`);
  stamp.style.setProperty('--c-dark', `rgb(${COLOR_DARK[color]})`);
  document.body.appendChild(stamp);
  setTimeout(() => stamp.remove(), 1100);
}
function showUnlockBanner(text, color) {
  const banner = document.createElement('div');
  banner.className = 'unlock-banner';
  banner.textContent = text;
  banner.style.setProperty('--c',      `rgb(${COLOR_RGB[color]})`);
  banner.style.setProperty('--c-dark', `rgb(${COLOR_DARK[color]})`);
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 1800);
}

function triggerComboBreakFx(lostStreak) {
  // Subdued feedback: jiggle the combo number itself + pulse the board's
  // outer edge once. No center toast, no full-app shake, no sound, no
  // haptic — the player has enough negative reinforcement from losing
  // their streak; the effect just confirms what happened.
  const center = document.getElementById('combo-center');
  if (center) {
    center.classList.remove('combo-break-jiggle');
    void center.offsetWidth;
    center.classList.add('combo-break-jiggle');
    setTimeout(() => center.classList.remove('combo-break-jiggle'), 700);
  }
  // Pulse the board-frame (the white panel that wraps next-strip + board) so
  // the red outline traces the player's whole play area, not just the cell
  // grid. Using outline instead of inset box-shadow keeps it outside the
  // panel's rounded corner and doesn't fight the panel's existing shadow.
  const frame = document.getElementById('board-frame');
  if (frame) {
    frame.classList.remove('combo-break-pulse');
    void frame.offsetWidth;
    frame.classList.add('combo-break-pulse');
    setTimeout(() => frame.classList.remove('combo-break-pulse'), 420);
  }
}

function checkGameOver() {
  if (gameOverFired) return;
  if (isGameOver()) {
    gameOverFired = true;
    // Tear down any in-flight autoplay state so isAutoplaying() reflects reality.
    stopAutoplay();
    $('final-score').textContent = score;
    $('gameover').classList.add('show');
    if (hooks.onGameOver) hooks.onGameOver(score, {
      maxCombo: maxComboThisGame,
      maxChain: maxChainThisGame,
      matches: matchCount,
      taps: obsCount,
    });
  }
}

function onTap(x, y) {
  if (gameOverFired) return;
  if (destroyMode) {
    destroyCellAt(x, y);
    return;
  }
  // While autoplay is running, block user taps entirely — they would race
  // with the bot's scheduled tap, invalidate the BFS plan, and waste an AI
  // turn. The user can use the Stop AI button to regain control.
  // The bot's own onTap call passes through via the botTapInFlight flag.
  if (autoplayState.active && !autoplayState.botTapInFlight) return;
  const cell = board[y][x];
  if (cell.state !== 'super') return;
  // Allow taps while the cascade is animating IF the target cell is stable
  // (not mid-spawn drop). The cascade engine is idempotent — resolveCascade
  // is a no-op when already running, and the next wave check will pick up
  // any matches our new tap produced once the current wave finishes.
  const el = cellEls.get(cell.id);
  if (el && (el.classList.contains('spawning') || el.classList.contains('above'))) return;

  pushHistory();
  // Reset the per-tap chain counter so this tap's cascade waves are
  // measured from zero. The counter increments inside startCascadeWave.
  chainThisTap = 0;
  const color = observe(x, y);
  obsCount++;

  const cellEl = elAt(x, y);
  if (cellEl) {
    cellEl.classList.add('collapsing');
    particles(cellEl, color, 14);
    setTimeout(() => cellEl.classList.remove('collapsing'), COLLAPSE_MS);
  }
  emitPropagationWaves(x, y, color);
  if (hooks.onTap) hooks.onTap(color);
  if (window.QSAudio) window.QSAudio.playTap(color);

  // Each tap starts a fresh combo evaluation. If the resulting cascade has at
  // least one match wave, the streak grows in startCascadeWave. If the cascade
  // ends with zero matches (handled here for the no-match case), reset.
  tapWillResolveCombo = true;
  render();
  resolveCascade();
}

function reset() {
  activeColors = ['r', 'b', 'y'];
  score = 0; obsCount = 0; matchCount = 0;
  comboStreak = 0;
  maxComboThisGame = 0;
  maxChainThisGame = 0;
  chainThisTap = 0;
  lastMatchColor = null;
  cycleIndex = 0;
  firstPaintedSpawned = false;
  firstMetalSpawned = false;
  tapWillResolveCombo = false;
  gameOverFired = false;
  destroyModalAiContext = false;
  autoplayState.tapPathCache = null;
  autoplayState.pendingDestroy = null;
  history = [];
  destroyFreeRemaining = DESTROY_FREE_PER_GAME;
  destroyAdRemaining = DESTROY_AD_PER_GAME;
  autoplayUsesRemaining = AUTOPLAY_USES_PER_GAME;
  destroyMode = false;
  applyDestroyVisuals();
  newBoard();
  $('gameover').classList.remove('show');
  buildDOM();
  render();
  if (hooks.onReset) hooks.onReset();
  if (typeof updateAutoplayUI === 'function') updateAutoplayUI();
  if (typeof updateDestroyUI === 'function') updateDestroyUI();
}

// "포기" button: force-end the current game (record final score, show overlay).
$('give-up-btn')?.addEventListener('click', () => {
  $('settings-modal')?.setAttribute('hidden', '');
  if (gameOverFired) return;
  gameOverFired = true;
  stopAutoplay();
  $('final-score').textContent = score;
  $('gameover').classList.add('show');
  if (hooks.onGameOver) hooks.onGameOver(score, {
    maxCombo: maxComboThisGame,
    maxChain: maxChainThisGame,
    matches: matchCount,
    taps: obsCount,
  });
});
$('start-btn')?.addEventListener('click', () => {
  $('tutorial').style.display = 'none';
});

// Autoplay button + confirmation modal — wired to the smart bot.
const AUTOPLAY_DEFAULT_TURNS = 30;
// Difficulty ramp: from this score onward, one fresh cell per match drops
// in pre-observed state (random active color) instead of as a super. The
// goal is to keep the late-game from being infinitely playable once all 5
// colors are unlocked — observed cells crowd the board and force the
// player to use destroy / AI / new match strategies.
// Difficulty ramp: cursed (unbreakable observed) cells start dropping into
// post-match gravity once the score crosses the first threshold. The
// frequency steepens at higher scores so the late game gets chaotic without
// punishing the player the moment they cross 10k.
//   - 0  ~ 10k:    never
//   - 10k ~ 20k:   every 5 matches
//   - 20k ~ 30k:   every 3 matches
//   - 30k+:        every match
const OBSERVED_SPAWN_FROM_SCORE = 10000;
// Convenience wrapper so the game module doesn't have to null-check the
// rulebook hook every time it wants to record that a mechanic was used.
function unlockRule(id) {
  if (window.QSRules && typeof window.QSRules.unlock === 'function') {
    window.QSRules.unlock(id);
  }
}
// Special-cell spawn config by score tier.
//   - interval: every Nth match drops one special cell (Infinity = none).
//   - metalRatio: probability the special is METAL vs PAINTED.
//     painted = pre-colored single-match cell (destructible).
//     metal   = unbreakable, first match downgrades to painted, second
//               match clears it (so 2 matches needed).
//
// Difficulty ramps in 5k steps starting at 10k. Each new tier alternates
// between dropping interval (−1, min 1) and raising metalRatio (+25%,
// max 100%) — interval moves first.
//
//   Score        Interval   Metal ratio
//   0 ~ 10k         —           —
//   10k ~ 15k       5            0%
//   15k ~ 20k       4            0%
//   20k ~ 25k       4           25%
//   25k ~ 30k       3           25%
//   30k ~ 35k       3           50%
//   35k ~ 40k       2           50%
//   40k ~ 45k       2           75%
//   45k ~ 50k       1           75%
//   50k ~ 55k       1          100%
//   55k+            1          100% (cap)
function specialSpawnConfig(currentScore) {
  if (currentScore < 10000) return { interval: Infinity, metalRatio: 0 };
  // tier 0 = 10k–15k, tier 1 = 15k–20k, ... bumped by floor((score-10k)/5k).
  const tier = Math.floor((currentScore - 10000) / 5000);
  // Tier 0 starts at interval=5, ratio=0. Odd tiers drop interval by 1;
  // even tiers (after tier 0) raise ratio by 25%.
  const intervalSteps = Math.floor((tier + 1) / 2);     // 0,1,1,2,2,3,3,4,4,5,...
  const ratioSteps    = Math.floor(tier / 2);            // 0,0,1,1,2,2,3,3,4,4,...
  const interval = Math.max(1, 5 - intervalSteps);
  const metalRatio = Math.min(1.0, 0.25 * ratioSteps);
  return { interval, metalRatio };
}
// Dev builds: flip to true to make the AI button available from score 0 so
// the autoplay flow can be tested without first reaching the threshold.
// MUST be false in release builds.
const DEV_AUTOPLAY_UNLOCK_FROM_ZERO = false;
const AUTOPLAY_UNLOCK_SCORE = DEV_AUTOPLAY_UNLOCK_FROM_ZERO ? 0 : 7000;
const autoplayBtn = $('autoplay-btn');
const autoplayStatus = $('autoplay-status');
const autoplayModal = $('autoplay-modal');
const autoplayConfirm = $('autoplay-confirm');
const autoplayCancel = $('autoplay-cancel');
const autoplayModalClose = $('autoplay-modal-close');
const autoplayBtnText = autoplayBtn?.querySelector('.ai-text');
function isAutoplayUnlocked() { return score >= AUTOPLAY_UNLOCK_SCORE; }
function updateAutoplayUI() {
  const badge = $('autoplay-badge');
  if (autoplayState.active) {
    if (autoplayBtnText) autoplayBtnText.textContent = window.QSI18n ? window.QSI18n.t('autoplay.stop') : 'Stop';
    // While the AI is running, fold the remaining-turn count into the
    // Stop button's own badge instead of showing a separate status chip
    // — keeps the row under the board width on narrow phones.
    autoplayStatus.classList.remove('show');
    autoplayBtn.hidden = false;
    autoplayBtn.classList.remove('is-exhausted');
    if (badge) {
      badge.hidden = false;
      badge.textContent = String(autoplayState.remaining);
      badge.classList.remove('is-exhausted');
    }
  } else if (!isAutoplayUnlocked()) {
    autoplayStatus.classList.remove('show');
    autoplayBtn.hidden = true;
  } else {
    if (autoplayBtnText) autoplayBtnText.textContent = window.QSI18n ? window.QSI18n.t('autoplay.cta') : 'Need help?';
    autoplayStatus.classList.remove('show');
    autoplayBtn.hidden = false;
    const exhausted = autoplayUsesRemaining <= 0;
    autoplayBtn.classList.toggle('is-exhausted', exhausted);
    if (badge) {
      badge.hidden = false;
      if (exhausted) {
        badge.textContent = '0';
      } else {
        const adLabel = window.QSI18n ? window.QSI18n.t('destroy.adBadge') : 'AD';
        badge.textContent = `${adLabel} ${autoplayUsesRemaining}`;
      }
      badge.classList.toggle('is-exhausted', exhausted);
    }
  }
}
function openAutoplayModal() {
  const dontShow = $('autoplay-dontshow');
  if (dontShow) dontShow.checked = false;
  autoplayModal.hidden = false;
}
function closeAutoplayModal() { autoplayModal.hidden = true; }
function commitAutoplayDontShow() {
  const dontShow = $('autoplay-dontshow');
  if (dontShow && dontShow.checked) setHideAutoplayAdInfo(true);
}
async function startAutoplayWithAd() {
  if (autoplayBtn?.dataset.busy === '1') return;
  if (autoplayUsesRemaining <= 0) return;
  if (autoplayBtn) autoplayBtn.dataset.busy = '1';
  try {
    const ok = hooks.requestRewardedAd
      ? await hooks.requestRewardedAd('autoplay')
      : true;
    if (!ok) return;
    // Charge the use only after the bot has actually taken at least one
    // turn. If startAutoplay() fails outright (game over) or the very
    // first step bails out — e.g. the board is fully gridlocked and the
    // destroy pool is empty too — the player keeps their charge.
    const turnsBefore = AUTOPLAY_DEFAULT_TURNS;
    const started = startAutoplay(turnsBefore);
    if (!started) return;
    autoplayChargePending = true;
    updateAutoplayUI();
  } finally {
    if (autoplayBtn) autoplayBtn.dataset.busy = '';
  }
}
// Quick precheck: does the bot have ANY playable move right now? Mirrors
// the planning steps autoplayStep walks (k=1 → BFS tap path → destroy),
// but stops as soon as something usable is found so we don't burn the
// player's ad on a board the AI immediately bails out of.
//
// Heuristic — not a proof of unsolvability. If this returns false the
// AI can't see a path right now; the player may still find one manually.
function autoplayCanMakeProgress() {
  if (findBestK1()) return true;
  const startState = cloneSimState();
  const path = bfsTapPath(startState);
  if (path && path.length > 0) return true;
  // Destroy is only a real option when at least one charge is available
  // (free or ad). If there's neither, a destroy target is no rescue.
  if (destroyFreeRemaining > 0 || destroyAdRemaining > 0) {
    if (bfsDestroyTarget(startState)) return true;
  }
  return false;
}
autoplayBtn?.addEventListener('click', () => {
  if (autoplayState.pendingDestroy) return;
  if (!isAutoplayUnlocked() && !autoplayState.active) return;
  if (autoplayState.active) {
    stopAutoplay();
    updateAutoplayUI();
    return;
  }
  if (autoplayUsesRemaining <= 0) return;
  if (!autoplayCanMakeProgress()) {
    if (typeof window.QSToast === 'function') {
      const msg = window.QSI18n
        ? window.QSI18n.t('autoplay.noPath')
        : "AI couldn't find a path. Try a different move.";
      window.QSToast(msg);
    }
    return;
  }
  if (!shouldShowAutoplayAdInfo()) {
    startAutoplayWithAd();
    return;
  }
  openAutoplayModal();
});
autoplayCancel?.addEventListener('click', () => {
  commitAutoplayDontShow();
  closeAutoplayModal();
});
autoplayModalClose?.addEventListener('click', () => {
  commitAutoplayDontShow();
  closeAutoplayModal();
});
autoplayModal?.addEventListener('click', (e) => {
  if (e.target === autoplayModal) {
    commitAutoplayDontShow();
    closeAutoplayModal();
  }
});
autoplayConfirm?.addEventListener('click', () => {
  commitAutoplayDontShow();
  closeAutoplayModal();
  startAutoplayWithAd();
});
hooks.onAutoplayStart = () => updateAutoplayUI();
hooks.onAutoplayStep = () => updateAutoplayUI();
hooks.onAutoplayEnd = () => updateAutoplayUI();
updateAutoplayUI();

// ─── Destroy (1-cell remover) ───
// 3 free uses per game; tapping the button enters destroy mode (or opens the
// ad modal when zero free uses remain). Watching the ad grants +1 and auto
// enters destroy mode. Tapping the button while already in destroy mode
// cancels without consuming a use.
const destroyBtn = $('destroy-btn');
const destroyCountEl = $('destroy-count');
const destroyTextEl = destroyBtn?.querySelector('.destroy-text');
const destroyModal = $('destroy-modal');
const destroyConfirm = $('destroy-confirm');
const destroyCancel = $('destroy-cancel');
const destroyModalClose = $('destroy-modal-close');
let destroyModalAiContext = false;
// Score threshold below which the destroy button stays hidden. Gates new
// players from the destroy mechanic until they have a few matches under
// their belt and have actually felt the need for it. The rulebook entry
// also stays locked until the same threshold fires for the first time.
const DESTROY_UNLOCK_SCORE = 2000;
function updateDestroyUI() {
  if (!destroyBtn) return;
  const visible = score >= DESTROY_UNLOCK_SCORE;
  destroyBtn.hidden = !visible;
  if (!visible) return;
  if (destroyTextEl) {
    destroyTextEl.textContent = window.QSI18n ? window.QSI18n.t('destroy.cta') : 'Smash cell';
  }
  if (destroyCountEl) {
    // Three visual states:
    //   N > 0          → show the count digit
    //   N = 0, ad > 0  → "AD" badge so a tap opens the rewarded-ad modal
    //   N = 0, ad = 0  → "0" greyed out; button is fully exhausted
    const empty = destroyFreeRemaining <= 0;
    const adGone = destroyAdRemaining <= 0;
    if (empty && adGone) {
      destroyCountEl.textContent = '0';
      destroyCountEl.classList.remove('is-ad');
      destroyCountEl.classList.add('is-exhausted');
    } else if (empty) {
      const adLabel = window.QSI18n ? window.QSI18n.t('destroy.adBadge') : 'AD';
      destroyCountEl.textContent = `${adLabel} ${destroyAdRemaining}`;
      destroyCountEl.classList.add('is-ad');
      destroyCountEl.classList.remove('is-exhausted');
    } else {
      destroyCountEl.textContent = String(destroyFreeRemaining);
      destroyCountEl.classList.remove('is-ad', 'is-exhausted');
    }
  }
  destroyBtn.classList.toggle('is-exhausted', destroyFreeRemaining <= 0 && destroyAdRemaining <= 0);
  destroyBtn.classList.toggle('is-active', destroyMode);
}
function openDestroyModal() {
  const dontShow = $('destroy-dontshow');
  if (dontShow) dontShow.checked = false;
  destroyModal.hidden = false;
}
function closeDestroyModal() { destroyModal.hidden = true; }
function commitDestroyDontShow() {
  const dontShow = $('destroy-dontshow');
  if (dontShow && dontShow.checked) setHideDestroyAdInfo(true);
}
// Shared rewarded-ad path for the destroy button — used both when the
// info modal is shown and when the player has opted out of it. Returns
// true if the ad rewarded and a destroy charge was granted.
async function watchDestroyAdAndGrant() {
  if (destroyConfirm?.dataset.busy === '1') return false;
  if (destroyConfirm) destroyConfirm.dataset.busy = '1';
  try {
    const ok = hooks.requestRewardedAd
      ? await hooks.requestRewardedAd('destroy')
      : true;
    if (!ok) return false;
    destroyFreeRemaining += 1;
    destroyAdRemaining = Math.max(0, destroyAdRemaining - 1);
    enterDestroyMode();
    updateDestroyUI();
    return true;
  } finally {
    if (destroyConfirm) destroyConfirm.dataset.busy = '';
  }
}
const KEY_HIDE_DESTROY_INTRO = 'qstk.hideDestroyIntro';
const KEY_HIDE_AUTOPLAY_AD_INFO = 'qstk.hideAutoplayAdInfo';
const KEY_HIDE_DESTROY_AD_INFO = 'qstk.hideDestroyAdInfo';
function shouldShowDestroyIntro() {
  try { return localStorage.getItem(KEY_HIDE_DESTROY_INTRO) !== '1'; } catch (_) { return true; }
}
function shouldShowAutoplayAdInfo() {
  try { return localStorage.getItem(KEY_HIDE_AUTOPLAY_AD_INFO) !== '1'; } catch (_) { return true; }
}
function shouldShowDestroyAdInfo() {
  try { return localStorage.getItem(KEY_HIDE_DESTROY_AD_INFO) !== '1'; } catch (_) { return true; }
}
function setHideAutoplayAdInfo(hide) {
  try {
    if (hide) localStorage.setItem(KEY_HIDE_AUTOPLAY_AD_INFO, '1');
    else localStorage.removeItem(KEY_HIDE_AUTOPLAY_AD_INFO);
  } catch (_) {}
}
function setHideDestroyAdInfo(hide) {
  try {
    if (hide) localStorage.setItem(KEY_HIDE_DESTROY_AD_INFO, '1');
    else localStorage.removeItem(KEY_HIDE_DESTROY_AD_INFO);
  } catch (_) {}
}
const destroyIntroModal = $('destroy-intro-modal');
const destroyIntroConfirm = $('destroy-intro-confirm');
const destroyIntroCancel = $('destroy-intro-cancel');
const destroyIntroClose = $('destroy-intro-modal-close');
function openDestroyIntroModal() {
  const dontShow = $('destroy-intro-dontshow');
  if (dontShow) dontShow.checked = false;
  if (destroyIntroModal) destroyIntroModal.hidden = false;
}
function closeDestroyIntroModal() {
  if (destroyIntroModal) destroyIntroModal.hidden = true;
}
function commitDestroyIntroDontShow() {
  const dontShow = $('destroy-intro-dontshow');
  if (dontShow && dontShow.checked) {
    try { localStorage.setItem(KEY_HIDE_DESTROY_INTRO, '1'); } catch (_) {}
  }
}
destroyBtn?.addEventListener('click', () => {
  if (gameOverFired) return;
  if (destroyMode) {
    exitDestroyMode();
    updateDestroyUI();
    return;
  }
  if (destroyFreeRemaining > 0) {
    // First-time use of destroy: explain it. Subsequent uses skip
    // straight into destroy mode (the AD badge / count communicates
    // state visually).
    if (shouldShowDestroyIntro()) {
      openDestroyIntroModal();
    } else {
      enterDestroyMode();
      updateDestroyUI();
    }
  } else if (destroyAdRemaining > 0) {
    if (!shouldShowDestroyAdInfo()) {
      watchDestroyAdAndGrant();
    } else {
      openDestroyModal();
    }
  }
  // No free uses and no ad recharges left — button stays inert. updateDestroyUI
  // dims the badge to communicate the exhausted state.
});
destroyIntroConfirm?.addEventListener('click', () => {
  commitDestroyIntroDontShow();
  closeDestroyIntroModal();
  enterDestroyMode();
  updateDestroyUI();
});
destroyIntroCancel?.addEventListener('click', () => {
  commitDestroyIntroDontShow();
  closeDestroyIntroModal();
});
destroyIntroClose?.addEventListener('click', closeDestroyIntroModal);
destroyIntroModal?.addEventListener('click', (e) => {
  if (e.target === destroyIntroModal) closeDestroyIntroModal();
});
destroyCancel?.addEventListener('click', () => {
  if (!destroyModalAiContext) commitDestroyDontShow();
  closeDestroyModal();
  if (destroyModalAiContext) {
    destroyModalAiContext = false;
    autoplayState.pendingDestroy = null;
    stopAutoplay();
    aiResetDestroyModalLabels();
  }
});
destroyModalClose?.addEventListener('click', () => {
  if (destroyModalAiContext) return;
  commitDestroyDontShow();
  closeDestroyModal();
});
destroyModal?.addEventListener('click', (e) => {
  if (e.target === destroyModal && !destroyModalAiContext) {
    commitDestroyDontShow();
    closeDestroyModal();
  }
});
destroyConfirm?.addEventListener('click', async () => {
  if (!destroyModalAiContext) commitDestroyDontShow();
  closeDestroyModal();
  if (destroyConfirm.dataset.busy === '1') return;
  destroyConfirm.dataset.busy = '1';
  try {
    const ok = hooks.requestRewardedAd
      ? await hooks.requestRewardedAd('destroy')
      : true;
    if (!ok) {
      if (destroyModalAiContext) {
        destroyModalAiContext = false;
        autoplayState.pendingDestroy = null;
        stopAutoplay();
        aiResetDestroyModalLabels();
      }
      return;
    }
    destroyFreeRemaining += 1;
    destroyAdRemaining = Math.max(0, destroyAdRemaining - 1);
    if (destroyModalAiContext) {
      const target = autoplayState.pendingDestroy;
      destroyModalAiContext = false;
      aiResetDestroyModalLabels();
      if (target && autoplayState.active && !gameOverFired) {
        executeAIDestroyAndResume(target);
      } else {
        autoplayState.pendingDestroy = null;
        stopAutoplay();
      }
      updateDestroyUI();
    } else {
      enterDestroyMode();
      updateDestroyUI();
    }
  } finally {
    destroyConfirm.dataset.busy = '';
  }
});
updateDestroyUI();

newBoard();
buildDOM();
render();

const _boardResize = new ResizeObserver(() => {
  updateCellSize();
  render();
});
_boardResize.observe(boardEl);

