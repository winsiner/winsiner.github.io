'use strict';

(async function () {
  const isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const platform = isCapacitor ? window.Capacitor.getPlatform() : 'web';

  const KEY_BEST = 'qstk.bestScore';
  const KEY_BEST_COMBO = 'qstk.bestCombo';
  const KEY_BEST_CHAIN = 'qstk.bestChain';
  const KEY_BEST_MATCHES = 'qstk.bestMatches';
  const KEY_ADS_REMOVED = 'qstk.adsRemoved';
  const KEY_GAMES_PLAYED = 'qstk.gamesPlayed';
  const KEY_COACH_SEEN = 'qstk.coachSeen';
  const KEY_HAPTIC = 'qstk.hapticOn';
  const KEY_AUTOSAVE = 'qstk.autosave';
  const KEY_UNLOCKED_RULES = 'qstk.unlockedRules';
  const AUTOSAVE_INTERVAL_MS = 60 * 1000;

  const SHARE_BASE_HOST = 'https://winsiner.github.io/cell-match';
  // Locales whose landing pages exist on winsiner.github.io. If the user's
  // current app language isn't here we fall back to 'en'.
  const SHARE_SUPPORTED_LANGS = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'pt-BR', 'fr', 'de', 'it', 'tr', 'id'];
  const PRODUCT_ID_REMOVE_ADS = 'com.winsiner.quantummatch.removeads';

  // AdMob ad unit IDs (production).
  //
  // Set true before a dev build to swap in Google's official test ad units.
  // These always fill (test traffic) regardless of AdMob account state — useful
  // to verify the SDK / Info.plist / event wiring while the production app is
  // still pending AdMob review or App Store registration. MUST be false before
  // submitting a release build to the App Store: serving test ads in a release
  // build is a TOS violation and can suspend the AdMob account.
  const USE_TEST_AD_UNITS = false;

  // AdMob registers an app per platform — iOS and Android each get their own
  // GADApplicationIdentifier and their own banner/interstitial/rewarded unit
  // IDs. Reusing one platform's unit ID on the other returns "No ad to show"
  // with policy warnings, so these MUST stay platform-specific.
  const PROD_ADMOB_BANNER_IOS = 'ca-app-pub-8228498239398986/3850945823';
  const PROD_ADMOB_INTERSTITIAL_IOS = 'ca-app-pub-8228498239398986/2537864151';
  const PROD_ADMOB_REWARDED_IOS = 'ca-app-pub-8228498239398986/9814930390';
  const PROD_ADMOB_BANNER_ANDROID = 'ca-app-pub-8228498239398986/1704589205';
  const PROD_ADMOB_INTERSTITIAL_ANDROID = 'ca-app-pub-8228498239398986/8773999827';
  const PROD_ADMOB_REWARDED_ANDROID = 'ca-app-pub-8228498239398986/3420995550';

  // Google's documented test ad unit IDs. Same shape per platform; always
  // returns a fillable test ad, never bills, never counts toward AdMob metrics.
  // https://developers.google.com/admob/ios/test-ads
  // https://developers.google.com/admob/android/test-ads
  const TEST_ADMOB_BANNER_IOS = 'ca-app-pub-3940256099942544/2934735716';
  const TEST_ADMOB_INTERSTITIAL_IOS = 'ca-app-pub-3940256099942544/4411468910';
  const TEST_ADMOB_REWARDED_IOS = 'ca-app-pub-3940256099942544/1712485313';
  const TEST_ADMOB_BANNER_ANDROID = 'ca-app-pub-3940256099942544/6300978111';
  const TEST_ADMOB_INTERSTITIAL_ANDROID = 'ca-app-pub-3940256099942544/1033173712';
  const TEST_ADMOB_REWARDED_ANDROID = 'ca-app-pub-3940256099942544/5224354917';

  const ADMOB = USE_TEST_AD_UNITS ? {
    banner_ios: TEST_ADMOB_BANNER_IOS,
    banner_android: TEST_ADMOB_BANNER_ANDROID,
    interstitial_ios: TEST_ADMOB_INTERSTITIAL_IOS,
    interstitial_android: TEST_ADMOB_INTERSTITIAL_ANDROID,
    rewarded_ios: TEST_ADMOB_REWARDED_IOS,
    rewarded_android: TEST_ADMOB_REWARDED_ANDROID,
  } : {
    banner_ios: PROD_ADMOB_BANNER_IOS,
    banner_android: PROD_ADMOB_BANNER_ANDROID,
    interstitial_ios: PROD_ADMOB_INTERSTITIAL_IOS,
    interstitial_android: PROD_ADMOB_INTERSTITIAL_ANDROID,
    rewarded_ios: PROD_ADMOB_REWARDED_IOS,
    rewarded_android: PROD_ADMOB_REWARDED_ANDROID,
  };

  if (USE_TEST_AD_UNITS) {
    console.warn('[AdMob] USE_TEST_AD_UNITS = true. Disable before App Store submission.');
  }

  const INTERSTITIAL_EVERY = 3;
  let reviveUsedThisGame = false;

  // ─── Storage abstraction (Preferences on device, localStorage in browser) ───
  const Preferences = isCapacitor && window.Capacitor.Plugins.Preferences
    ? window.Capacitor.Plugins.Preferences
    : null;

  async function storeGet(key, fallback = null) {
    if (Preferences) {
      const { value } = await Preferences.get({ key });
      return value ?? fallback;
    }
    return localStorage.getItem(key) ?? fallback;
  }
  async function storeSet(key, value) {
    const v = String(value);
    if (Preferences) await Preferences.set({ key, value: v });
    else localStorage.setItem(key, v);
  }
  async function storeRemove(key) {
    if (Preferences) await Preferences.remove({ key });
    else localStorage.removeItem(key);
  }

  // ─── Autosave: 60s interval + on app hide. Cleared on game over / reset. ───
  let autosaveTimer = null;
  async function persistAutosave() {
    if (!window.QSGame || typeof window.QSGame.getSaveState !== 'function') return;
    if (window.QSGame.isGameOver && window.QSGame.isGameOver()) return;
    // Skip while a cascade is still resolving — snapshotting a board with
    // `matching` cells loses the wave's gravity/spawn step on restore.
    // The next interval (or the hide/pagehide hook) will catch up once
    // the wave settles. For app-hide we still try once below.
    if (window.QSGame.isCascadeBusy && window.QSGame.isCascadeBusy()) return;
    try {
      const data = window.QSGame.getSaveState();
      await storeSet(KEY_AUTOSAVE, JSON.stringify(data));
    } catch (_) { /* ignore */ }
  }
  function scheduleAutosave() {
    clearAutosave();
    autosaveTimer = setInterval(persistAutosave, AUTOSAVE_INTERVAL_MS);
  }
  function clearAutosave() {
    if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; }
  }

  // ─── State ───
  let bestScore = 0;
  let bestCombo = 0;
  let bestChain = 0;
  let bestMatches = 0;
  let gamesPlayed = 0;
  let adsRemoved = false;

  bestScore = Number(await storeGet(KEY_BEST, '0')) || 0;
  bestCombo = Number(await storeGet(KEY_BEST_COMBO, '0')) || 0;
  bestChain = Number(await storeGet(KEY_BEST_CHAIN, '0')) || 0;
  bestMatches = Number(await storeGet(KEY_BEST_MATCHES, '0')) || 0;
  gamesPlayed = Number(await storeGet(KEY_GAMES_PLAYED, '0')) || 0;
  adsRemoved = (await storeGet(KEY_ADS_REMOVED, '0')) === '1';

  // Rulebook unlocks — persisted as a Set of section ids. Once a rule is
  // unlocked it stays unlocked forever (across games, app restarts) because
  // it represents knowledge the player has gained, not progress to grind.
  const unlockedRulesRaw = await storeGet(KEY_UNLOCKED_RULES, '[]');
  let unlockedRules;
  try {
    unlockedRules = new Set(JSON.parse(unlockedRulesRaw));
  } catch (_) {
    unlockedRules = new Set();
  }
  async function persistUnlockedRules() {
    await storeSet(KEY_UNLOCKED_RULES, JSON.stringify(Array.from(unlockedRules)));
  }
  // Public API: call from game.js when a mechanic appears for the first
  // time. If newly unlocked, fires a toast announcing the new rulebook
  // entry. Idempotent — subsequent calls for the same id are no-ops.
  window.QSRules = {
    isUnlocked: (id) => unlockedRules.has(id),
    unlocked: () => Array.from(unlockedRules),
    unlock: (id) => {
      if (unlockedRules.has(id)) return false;
      unlockedRules.add(id);
      persistUnlockedRules();
      const title = (window.QSI18n && window.QSI18n.t)
        ? window.QSI18n.t(`rulebook.${id}.title`)
        : id;
      const msg = (window.QSI18n && window.QSI18n.t)
        ? window.QSI18n.t('rulebook.toastUnlocked', { title })
        : `New rule: ${title}`;
      if (typeof window.QSToast === 'function') window.QSToast(msg);
      return true;
    },
  };

  // Restore any in-progress game saved from a previous session.
  const savedRaw = await storeGet(KEY_AUTOSAVE, null);
  if (savedRaw && window.QSGame && typeof window.QSGame.loadSaveState === 'function') {
    try {
      const parsed = JSON.parse(savedRaw);
      window.QSGame.loadSaveState(parsed);
    } catch (_) {
      await storeRemove(KEY_AUTOSAVE);
    }
  }
  scheduleAutosave();

  const bestEl = document.getElementById('best-score');
  const finalBestEl = document.getElementById('final-best');
  if (bestEl) bestEl.textContent = bestScore;
  if (finalBestEl) finalBestEl.textContent = bestScore;

  // ─── Haptics ───
  const Haptics = isCapacitor && window.Capacitor.Plugins.Haptics
    ? window.Capacitor.Plugins.Haptics
    : null;
  // Per-platform model:
  //   iOS    → Haptics.impact(style)  (Taptic Engine; LIGHT/MED/HEAVY)
  //   Android → Haptics.vibrate({ duration: ms })
  //     Android's impact LIGHT/MED/HEAVY collapsed to the same vibration
  //     on many devices, so the slider had no audible effect. Direct
  //     duration in ms scales linearly with perceived strength.
  let hapticPct = 50; // 0..100
  function setHapticLevel(pct) {
    hapticPct = Math.max(0, Math.min(100, pct | 0));
  }
  // Back-compat: older callers use a boolean. true → 50, false → 0.
  function setHapticsEnabled(v) { hapticPct = v ? 50 : 0; }

  // iOS style mapping: scale a base intensity by hapticPct.
  //   light/medium/heavy base → may shift up/down depending on slider.
  function iosStyleFor(base) {
    if (hapticPct <= 0) return null;
    const ladder = ['LIGHT', 'MEDIUM', 'HEAVY'];
    const baseIdx = base === 'light' ? 0 : base === 'medium' ? 1 : 2;
    let shift;
    if (hapticPct <= 33) shift = -1;
    else if (hapticPct <= 66) shift = 0;
    else shift = 1;
    const idx = Math.max(0, Math.min(ladder.length - 1, baseIdx + shift));
    return ladder[idx];
  }
  // Android duration mapping. Floor at 30ms — anything shorter doesn't
  // give the motor enough time to spin up and reads as silent on most
  // devices. Ceiling at 220ms so heavy taps still feel like a "tap",
  // not a buzzer.
  function androidDurationFor(base) {
    if (hapticPct <= 0) return 0;
    const ranges = {
      light:  [30, 60],
      medium: [50, 110],
      heavy:  [80, 220],
    };
    const r = ranges[base] || ranges.medium;
    const t = hapticPct / 100;
    return Math.round(r[0] + (r[1] - r[0]) * t);
  }
  async function fireHaptic(base) {
    if (!Haptics || hapticPct <= 0) return;
    try {
      if (platform === 'android') {
        const duration = androidDurationFor(base);
        if (duration > 0) await Haptics.vibrate({ duration });
      } else {
        const style = iosStyleFor(base);
        if (style) await Haptics.impact({ style });
      }
    } catch (_) { /* swallow — haptics are best-effort */ }
  }
  async function hapticLight()  { return fireHaptic('light'); }
  async function hapticMedium() { return fireHaptic('medium'); }
  async function hapticHeavy()  { return fireHaptic('heavy'); }
  async function hapticSuccess() {
    if (!Haptics || hapticPct <= 0) return;
    try {
      if (platform === 'android') {
        // Two short pulses to simulate "success" notification on Android.
        await Haptics.vibrate({ duration: androidDurationFor('medium') });
      } else {
        await Haptics.notification({ type: 'SUCCESS' });
      }
    } catch (_) {}
  }

  // ─── App version (read from native bundle when available) ───
  const AppPlugin = isCapacitor && window.Capacitor.Plugins.App
    ? window.Capacitor.Plugins.App
    : null;
  if (AppPlugin) {
    try {
      const info = await AppPlugin.getInfo();
      const versionEl = document.getElementById('app-version');
      if (versionEl && info && info.version) versionEl.textContent = info.version;
    } catch (_) {}
  }

  // ─── Status bar (Android needs explicit dark style for our dark theme) ───
  const StatusBar = isCapacitor && window.Capacitor.Plugins.StatusBar
    ? window.Capacitor.Plugins.StatusBar
    : null;
  if (StatusBar) {
    try {
      await StatusBar.setStyle({ style: 'DARK' });
      if (platform === 'android') {
        await StatusBar.setBackgroundColor({ color: '#06060a' });
      }
    } catch (_) {}
  }

  // ─── AdMob ───
  const AdMob = isCapacitor && window.Capacitor.Plugins.AdMob
    ? window.Capacitor.Plugins.AdMob
    : null;

  let adMobReady = false;
  let bannerShown = false;
  // Rewarded-video preload state. We keep at most one ad warmed up at a
  // time so the player taps "watch ad" → ad starts in ~100-200 ms
  // instead of the 2-5 s prepare round-trip. Match rate stays effectively
  // 1:1 because we only start the next preload after the previous ad is
  // dismissed, mirroring AdMob's recommended pattern. (Multi-buffering
  // preloads tends to drop eCPM via expired impressions and gets the
  // mediation chain to bid more conservatively.)
  let rewardedPreloadPromise = null;
  let rewardedReady = false;

  async function initAdMob() {
    if (!AdMob || adsRemoved) return;
    try {
      // iOS 14+: request App Tracking Transparency permission so AdMob can
      // serve personalized ads. Without this prompt, fill rate is capped by
      // limited-tracking inventory and many mediation partners decline to bid.
      // The native plugin no-ops on Android. Failure is non-fatal.
      if (platform === 'ios' && typeof AdMob.trackingAuthorizationStatus === 'function') {
        try {
          const status = await AdMob.trackingAuthorizationStatus();
          if (status && status.status === 'notDetermined' && typeof AdMob.requestTrackingAuthorization === 'function') {
            await AdMob.requestTrackingAuthorization();
          }
        } catch (_) { /* permission flow failures should not block initialization */ }
      }
      await AdMob.initialize({
        testingDevices: [],
        // When USE_TEST_AD_UNITS is on we also flip initializeForTesting so
        // the SDK marks every request as test traffic. Without it, dev builds
        // hitting test ad unit IDs still work but the SDK warns in console.
        initializeForTesting: USE_TEST_AD_UNITS,
      });
      // Diagnostics: surface the underlying AdMob error code/message so a
      // generic "No ad to show" log line in Xcode is not the only signal.
      // Code 0 = INTERNAL_ERROR, 1 = INVALID_REQUEST, 2 = NETWORK_ERROR,
      // 3 = NO_FILL. The message often contains the mediation chain trace.
      try {
        AdMob.addListener('bannerAdFailedToLoad', (err) => {
          console.warn('[AdMob] bannerAdFailedToLoad', JSON.stringify(err));
        });
        AdMob.addListener('bannerAdLoaded', () => {
          console.log('[AdMob] bannerAdLoaded');
        });
        AdMob.addListener('onRewardedVideoAdFailedToLoad', (err) => {
          console.warn('[AdMob] rewardedVideoFailedToLoad', JSON.stringify(err));
          // A failed preload should not leave the next call thinking an
          // ad is warmed up. Clear state so showRewardedAd falls back to
          // an on-demand prepare.
          rewardedReady = false;
          rewardedPreloadPromise = null;
        });
        AdMob.addListener('onRewardedVideoAdFailedToShow', (err) => {
          console.warn('[AdMob] rewardedVideoFailedToShow', JSON.stringify(err));
        });
      } catch (_) { /* listener registration is diagnostic-only */ }
      adMobReady = true;
      // Warm an ad up immediately so the first rewarded request the user
      // makes doesn't pay the prepare round-trip.
      preloadRewardedAd();
    } catch (e) {
      console.warn('AdMob init failed', e);
    }
  }

  // Kick off a rewarded-video prepare in the background. Safe to call
  // multiple times — concurrent calls share the same promise and a
  // successful preload short-circuits subsequent ones until the ad is
  // consumed or fails. Resolves when the prepare round-trip finishes.
  function preloadRewardedAd() {
    if (!AdMob || adsRemoved || !adMobReady) return Promise.resolve(false);
    if (rewardedReady) return Promise.resolve(true);
    if (rewardedPreloadPromise) return rewardedPreloadPromise;
    rewardedPreloadPromise = (async () => {
      try {
        await AdMob.prepareRewardVideoAd({ adId: adRewardedId() });
        rewardedReady = true;
        return true;
      } catch (e) {
        console.warn('Rewarded preload failed', e);
        rewardedReady = false;
        return false;
      } finally {
        rewardedPreloadPromise = null;
      }
    })();
    return rewardedPreloadPromise;
  }

  function adBannerId() {
    return platform === 'ios' ? ADMOB.banner_ios : ADMOB.banner_android;
  }
  function adInterstitialId() {
    return platform === 'ios' ? ADMOB.interstitial_ios : ADMOB.interstitial_android;
  }
  function adRewardedId() {
    return platform === 'ios' ? ADMOB.rewarded_ios : ADMOB.rewarded_android;
  }

  // Show a rewarded ad and resolve with the user's outcome:
  //   true  → user finished the ad → grant the reward
  //   false → user dismissed without earning the reward, ad failed to load,
  //           or AdMob isn't available
  //
  // If "Remove ads" has been purchased, skip the ad entirely and grant the
  // reward immediately — the user already paid for an ad-free experience.
  // On web/dev (no AdMob), also grant directly so the flow stays testable.
  async function showRewardedAd(reason) {
    if (adsRemoved) return true;
    if (!AdMob) return true;            // web / dev preview — no native AdMob
    if (!adMobReady) {
      console.warn('Rewarded ad requested but AdMob not initialized');
      return false;
    }
    try {
      // AdMob fires `onRewardedVideoAdReward` BEFORE the user closes the ad
      // (often the moment the video finishes). Resolving on reward alone makes
      // the post-ad action (AI autoplay, revive, etc.) start while the ad is
      // still on screen — the user never sees it begin. We must wait for the
      // ad to actually be dismissed, then return whether reward was granted.
      // Listeners and the timeout are tracked outside the promise so the
      // catch block below can tear them down immediately if prepare/show
      // throws — otherwise the listeners would dangle for up to 120s and
      // any reward/dismiss event during that window could flip state.
      let onReward, onDismiss, timeoutHandle;
      let rewarded = false;
      let settled = false;
      const cleanup = () => {
        onReward?.then?.(h => h.remove?.());
        onDismiss?.then?.(h => h.remove?.());
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };
      const rewardPromise = new Promise((resolve) => {
        onReward = AdMob.addListener('onRewardedVideoAdReward', () => {
          rewarded = true;
        });
        onDismiss = AdMob.addListener('onRewardedVideoAdDismissed', () => {
          if (settled) return;
          settled = true;
          cleanup();
          // The ad is gone; the cached prepare is consumed. Kick off
          // the next preload so the player's next tap is also instant.
          rewardedReady = false;
          preloadRewardedAd();
          resolve(rewarded);
        });
        // Fallback if dismiss never fires (rare AdMob bug). Resolve `false`
        // even if reward fired — without an observed dismiss we can't trust
        // that the ad is off-screen, so granting the reward would risk
        // running the post-ad action over a still-visible ad.
        timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          rewardedReady = false;
          preloadRewardedAd();
          resolve(false);
        }, 120000);
      });
      try {
        // If a preload is already in flight or finished, wait on / reuse
        // it. Otherwise this is the first call before the warmup
        // resolved — fall through to a synchronous prepare so we still
        // honor the request.
        if (rewardedReady) {
          // Cached ad ready: skip prepare and show immediately.
        } else if (rewardedPreloadPromise) {
          await rewardedPreloadPromise;
        }
        if (!rewardedReady) {
          await AdMob.prepareRewardVideoAd({ adId: adRewardedId() });
          rewardedReady = true;
        }
        await AdMob.showRewardVideoAd();
      } catch (e) {
        // Show/prepare failed before any listener could fire. Tear them
        // down now rather than leaving them attached for 120s. Also try
        // to keep a future ad warm in case this was a transient error.
        cleanup();
        rewardedReady = false;
        rewardedPreloadPromise = null;
        preloadRewardedAd();
        throw e;
      }
      return await rewardPromise;
    } catch (e) {
      console.warn('Rewarded ad failed', e);
      return false;
    }
  }
  // Back-compat alias for the revive call site.
  const showRewardedRevive = () => showRewardedAd('revive');

  // Briefly disable cell transitions while the layout reflows after an ad
  // appears/disappears. Without this the board frame's new vertical center
  // animates and the cells slide-jitter alongside it.
  let _suppressTimer = null;
  function suppressLayoutTransitions(ms = 400) {
    const root = document.documentElement;
    root.classList.add('ads-reflowing');
    if (_suppressTimer) clearTimeout(_suppressTimer);
    _suppressTimer = setTimeout(() => {
      root.classList.remove('ads-reflowing');
      _suppressTimer = null;
    }, ms);
  }

  async function showBanner() {
    if (!adMobReady || adsRemoved || bannerShown) return;
    try {
      await AdMob.showBanner({
        adId: adBannerId(),
        adSize: 'ADAPTIVE_BANNER',
        position: 'BOTTOM_CENTER',
        margin: -1, // negative pulls banner down past the OS safe area / nav bar
        isTesting: false,
      });
      bannerShown = true;
      // Reserve space so the banner does not cover gameplay; banner sits flush
      // against the bottom edge, so we also collapse safe-area padding below it.
      suppressLayoutTransitions();
      document.documentElement.style.setProperty('--ad-height', '52px');
      document.documentElement.style.setProperty('--safe-bottom-collapsed', '0px');
    } catch (e) {
      console.warn('Banner failed', e);
    }
  }

  async function hideBanner() {
    if (!AdMob || !bannerShown) return;
    try {
      await AdMob.removeBanner();
      bannerShown = false;
      suppressLayoutTransitions();
      document.documentElement.style.setProperty('--ad-height', '0px');
    } catch (_) {}
  }

  async function maybeShowInterstitial() {
    if (!adMobReady || adsRemoved) return;
    if (gamesPlayed % INTERSTITIAL_EVERY !== 0) return;
    try {
      await AdMob.prepareInterstitial({
        adId: adInterstitialId(),
        isTesting: false,
      });
      await AdMob.showInterstitial();
    } catch (e) {
      console.warn('Interstitial failed', e);
    }
  }

  // ─── Share ───
  const Share = isCapacitor && window.Capacitor.Plugins.Share
    ? window.Capacitor.Plugins.Share
    : null;

  async function shareScore(score, stats) {
    const t = window.QSI18n?.t || ((k, p) => p ? Object.keys(p).reduce((s, x) => s.replace(`{{${x}}}`, p[x]), k) : k);
    const text = t('share.text', { score });
    const title = t('app.shareTitle');
    const lang = (window.QSI18n && SHARE_SUPPORTED_LANGS.includes(window.QSI18n.getLang()))
      ? window.QSI18n.getLang()
      : 'en';
    const url = `${SHARE_BASE_HOST}/${lang}/s/?score=${encodeURIComponent(score)}`;
    // Optional stats line — only included if the caller supplied per-game
    // figures. Numbers come straight from the stats object; placeholder
    // names match the i18n template.
    let statsLine = '';
    if (stats) {
      const combo = stats.maxCombo ?? 0;
      const chain = stats.maxChain ?? 0;
      const matches = stats.matches ?? 0;
      statsLine = t('share.statsLine', { combo, chain, matches });
    }
    // Two-line message: score+url on the first line, stats on the second.
    // Messengers that auto-detect URLs still produce a rich preview card.
    const combined = statsLine
      ? `${text} ${url}\n${statsLine}`
      : `${text} ${url}`;
    if (Share) {
      try {
        await Share.share({
          title,
          text: combined,
          dialogTitle: t('share.dialogTitle'),
        });
        return;
      } catch (e) {
        if (e?.message?.includes('canceled')) return;
        console.warn('Share failed', e);
      }
    }
    // Web fallback
    if (navigator.share) {
      try { await navigator.share({ title, text: combined }); return; } catch (_) {}
    }
    try {
      await navigator.clipboard.writeText(combined);
      alert(t('share.copied'));
    } catch (_) {
      alert(combined);
    }
  }

  // ─── IAP (CdvPurchase / cordova-plugin-purchase, lazy-loaded if present) ───
  let iapStore = null;
  function initIAP() {
    if (!isCapacitor) return;
    if (!window.CdvPurchase) {
      // Plugin not installed yet; UI buttons stay hidden
      return;
    }
    const { Platform, ProductType, store } = window.CdvPurchase;
    iapStore = store;

    iapStore.register([{
      id: PRODUCT_ID_REMOVE_ADS,
      type: ProductType.NON_CONSUMABLE,
      platform: platform === 'ios' ? Platform.APPLE_APPSTORE : Platform.GOOGLE_PLAY,
    }]);

    iapStore.when()
      .approved((tx) => tx.verify())
      .verified((receipt) => receipt.finish())
      .finished((tx) => {
        const hasProduct = Array.isArray(tx.products)
          && tx.products.some(p => p && p.id === PRODUCT_ID_REMOVE_ADS);
        if (!hasProduct) return;
        // restoreInProgress flag distinguishes restore from a fresh purchase.
        markAdsRemoved({ source: restoreInProgress ? 'restore' : 'purchase' });
        restoreCompletedTracker.foundAny = true;
      });

    iapStore.initialize([
      platform === 'ios' ? Platform.APPLE_APPSTORE : Platform.GOOGLE_PLAY,
    ]).catch(e => console.warn('IAP init failed', e));

    // Reveal IAP buttons
    document.getElementById('remove-ads-btn')?.removeAttribute('hidden');
    document.getElementById('restore-row')?.removeAttribute('hidden');
  }

  async function markAdsRemoved({ source } = {}) {
    const wasAlreadyRemoved = adsRemoved;
    adsRemoved = true;
    await storeSet(KEY_ADS_REMOVED, '1');
    await hideBanner();
    document.getElementById('remove-ads-btn')?.setAttribute('hidden', '');
    if (!wasAlreadyRemoved && source === 'purchase') {
      iapToast(window.QSI18n?.t('iap.purchaseSuccess') || 'Ads removed — thank you!');
    } else if (source === 'restore') {
      iapToast(window.QSI18n?.t(wasAlreadyRemoved ? 'iap.alreadyOwned' : 'iap.restoreSuccess')
        || (wasAlreadyRemoved ? 'You already own this' : 'Purchases restored'));
    }
  }

  // Small ephemeral toast for IAP feedback (no native toast API on iOS via
  // Capacitor by default — use a DOM element styled like a snackbar).
  let iapToastTimer = null;
  function iapToast(message) {
    let el = document.getElementById('iap-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'iap-toast';
      // Top-anchored so the toast never collides with the AdMob banner at
      // the bottom (banner height varies by device — adaptive banners can
      // be 50-110dp). Respects the status-bar safe area so the toast
      // doesn't stick to the notch.
      el.style.cssText = 'position:fixed;left:50%;top:calc(var(--safe-top, 0px) + 16px);transform:translateX(-50%);background:rgba(20,22,40,0.92);color:#fff;padding:12px 18px;border-radius:14px;font:600 14px/1.3 system-ui,sans-serif;z-index:9999;max-width:min(440px,calc(100vw - 32px));width:max-content;text-align:center;word-break:keep-all;overflow-wrap:normal;box-shadow:0 8px 24px rgba(0,0,0,0.25);opacity:0;transition:opacity 0.22s ease;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = message;
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    if (iapToastTimer) clearTimeout(iapToastTimer);
    iapToastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2600);
  }
  // Expose as a generic toast for non-IAP callers (rulebook unlocks etc).
  window.QSToast = iapToast;

  let purchaseInProgress = false;
  async function purchaseRemoveAds() {
    if (!iapStore) {
      iapToast(window.QSI18n?.t('iap.unavailable') || 'In-app purchases unavailable');
      return;
    }
    if (purchaseInProgress) return;
    const product = iapStore.get(PRODUCT_ID_REMOVE_ADS);
    if (!product) {
      iapToast(window.QSI18n?.t('iap.loading') || 'Loading product info, try again');
      return;
    }
    const btn = document.getElementById('remove-ads-btn');
    purchaseInProgress = true;
    if (btn) btn.setAttribute('disabled', '');
    try {
      await iapStore.order(product.getOffer());
      // Success flows through the iapStore.when().finished() chain →
      // markAdsRemoved({ source: 'purchase' }) shows the toast.
    } catch (e) {
      // Cancellations look like errors but should stay silent.
      const code = e?.code;
      const msg = String(e?.message || '');
      const isCancel = code === 6500 /* PAYMENT_CANCELLED */
        || /cancel/i.test(msg);
      if (!isCancel) {
        console.warn('Purchase failed', e);
        iapToast(window.QSI18n?.t('iap.purchaseFailed') || 'Purchase failed — try again');
      }
    } finally {
      purchaseInProgress = false;
      if (btn) btn.removeAttribute('disabled');
    }
  }

  // Tracked across the restore call so we can show "Nothing to restore" when
  // the finished callback never fires for the remove-ads product.
  const restoreCompletedTracker = { foundAny: false };
  let restoreInProgress = false;
  async function restorePurchases() {
    if (!iapStore) {
      iapToast(window.QSI18n?.t('iap.unavailable') || 'In-app purchases unavailable');
      return;
    }
    if (restoreInProgress) return;
    restoreInProgress = true;
    restoreCompletedTracker.foundAny = false;
    const btn = document.getElementById('restore-btn');
    if (btn) btn.setAttribute('disabled', '');
    try {
      await iapStore.restorePurchases();
      // Give finished() callback a brief window to fire after restore resolves.
      await new Promise(r => setTimeout(r, 600));
      if (!restoreCompletedTracker.foundAny && !adsRemoved) {
        iapToast(window.QSI18n?.t('iap.restoreNothing') || 'No purchases to restore');
      }
    } catch (e) {
      // Apple ID login cancel comes through as an error here.
      const msg = String(e?.message || '');
      const isCancel = /cancel/i.test(msg);
      if (!isCancel) {
        console.warn('Restore failed', e);
        iapToast(window.QSI18n?.t('iap.restoreFailed') || 'Restore failed — try again');
      }
    } finally {
      restoreInProgress = false;
      if (btn) btn.removeAttribute('disabled');
    }
  }

  // ─── Wire-up ───
  const reviveBtn = document.getElementById('revive-btn');
  document.getElementById('share-btn')?.addEventListener('click', () => {
    const stats = window.QSGame.getStats ? window.QSGame.getStats() : null;
    shareScore(window.QSGame.getScore(), stats);
  });

  // Settings modal — volume slider + haptic slider (persisted in storage)
  const KEY_SOUND = 'qstk.soundOn';
  const KEY_VOLUME = 'qstk.volume';      // 0..100
  const KEY_HAPTIC_LEVEL = 'qstk.hapticLevel'; // 0..100
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsClose = document.getElementById('settings-close');
  // Wire up open/close handlers immediately, before any awaited storage
  // calls, so the menu button is responsive even while async init is in
  // flight (Release builds can take a beat to resolve the first
  // Preferences.get call).
  settingsBtn?.addEventListener('click', () => {
    syncAdInfoToggles();
    settingsModal?.removeAttribute('hidden');
  });
  settingsClose?.addEventListener('click', () => settingsModal?.setAttribute('hidden', ''));
  settingsModal?.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.setAttribute('hidden', '');
  });

  // Toggles for "show ad-info modal before AI/destroy ad watch". Checked
  // = modal is shown (default). Unchecked = the modal is bypassed, so the
  // button taps the rewarded-ad flow directly.
  const KEY_HIDE_AUTOPLAY_AD_INFO = 'qstk.hideAutoplayAdInfo';
  const KEY_HIDE_DESTROY_AD_INFO = 'qstk.hideDestroyAdInfo';
  const autoplayAdInfoToggle = document.getElementById('autoplay-ad-info-toggle');
  const destroyAdInfoToggle = document.getElementById('destroy-ad-info-toggle');
  function syncAdInfoToggles() {
    try {
      if (autoplayAdInfoToggle) autoplayAdInfoToggle.checked = localStorage.getItem(KEY_HIDE_AUTOPLAY_AD_INFO) !== '1';
      if (destroyAdInfoToggle) destroyAdInfoToggle.checked = localStorage.getItem(KEY_HIDE_DESTROY_AD_INFO) !== '1';
    } catch (_) {}
  }
  autoplayAdInfoToggle?.addEventListener('change', () => {
    try {
      if (autoplayAdInfoToggle.checked) localStorage.removeItem(KEY_HIDE_AUTOPLAY_AD_INFO);
      else localStorage.setItem(KEY_HIDE_AUTOPLAY_AD_INFO, '1');
    } catch (_) {}
  });
  destroyAdInfoToggle?.addEventListener('change', () => {
    try {
      if (destroyAdInfoToggle.checked) localStorage.removeItem(KEY_HIDE_DESTROY_AD_INFO);
      else localStorage.setItem(KEY_HIDE_DESTROY_AD_INFO, '1');
    } catch (_) {}
  });

  // ── Volume slider (0..100). Real-time preview: every step plays a short
  // tap sound at the new level. Persisted on release ('change') and on each
  // step ('input') so app force-quit mid-drag still keeps the latest value.
  const volumeSlider = document.getElementById('volume-slider');
  const volumeValueEl = document.getElementById('volume-value');
  const initialVolumeStr = await storeGet(KEY_VOLUME, '100');
  const initialVolumePref = await storeGet(KEY_SOUND, '1');
  // Migrate legacy boolean: if old SOUND pref was '0' (off), start muted.
  const initialVolume = initialVolumePref === '0' ? 0 : Math.max(0, Math.min(100, parseInt(initialVolumeStr, 10) || 100));
  function applyVolume(pct) {
    if (window.QSAudio) window.QSAudio.setVolume(pct / 100);
    if (volumeValueEl) volumeValueEl.textContent = String(pct);
  }
  if (volumeSlider) volumeSlider.value = String(initialVolume);
  applyVolume(initialVolume);
  let volumePreviewThrottle = 0;
  // Sync handler — applies the value + plays preview immediately. Async
  // persistence is fire-and-forget so a slow Preferences.set on Android
  // doesn't delay the next input event's preview.
  function onVolumeInput(pct) {
    applyVolume(pct);
    storeSet(KEY_VOLUME, String(pct));
    const now = Date.now();
    if (pct > 0 && now - volumePreviewThrottle > 60 && window.QSAudio) {
      volumePreviewThrottle = now;
      window.QSAudio.playTap('r');
    }
  }
  volumeSlider?.addEventListener('input', (e) => {
    onVolumeInput(parseInt(e.target.value, 10) || 0);
  });
  // Android WKWebView equivalents sometimes only fire `change` (drag end)
  // for range inputs — listen to both so neither platform misses a step.
  volumeSlider?.addEventListener('change', (e) => {
    onVolumeInput(parseInt(e.target.value, 10) || 0);
  });

  // ── Haptic slider (0..100). 0 = off, 1..33 light, 34..66 medium,
  // 67..100 heavy. Every step fires a preview pulse at the matching style.
  const hapticSlider = document.getElementById('haptic-slider');
  const hapticValueEl = document.getElementById('haptic-value');
  const initialHapticStr = await storeGet(KEY_HAPTIC_LEVEL, null);
  const legacyHaptic = await storeGet(KEY_HAPTIC, '1');
  // Migrate legacy boolean: '0' → 0, '1' → 50 (medium-ish default).
  const initialHaptic = initialHapticStr !== null
    ? Math.max(0, Math.min(100, parseInt(initialHapticStr, 10) || 0))
    : (legacyHaptic === '0' ? 0 : 50);
  function applyHaptic(pct) {
    setHapticLevel(pct);
    if (hapticValueEl) hapticValueEl.textContent = String(pct);
  }
  if (hapticSlider) hapticSlider.value = String(initialHaptic);
  applyHaptic(initialHaptic);
  let hapticPreviewThrottle = 0;
  function onHapticInput(pct) {
    applyHaptic(pct);
    storeSet(KEY_HAPTIC_LEVEL, String(pct));
    const now = Date.now();
    if (pct > 0 && now - hapticPreviewThrottle > 60) {
      hapticPreviewThrottle = now;
      const base = pct <= 33 ? 'light' : pct <= 66 ? 'medium' : 'heavy';
      fireHaptic(base);
    }
  }
  hapticSlider?.addEventListener('input', (e) => {
    onHapticInput(parseInt(e.target.value, 10) || 0);
  });
  hapticSlider?.addEventListener('change', (e) => {
    onHapticInput(parseInt(e.target.value, 10) || 0);
  });
  // Language picker — settings row opens a modal that lists every supported
  // language. Click a row to select it; the change is applied immediately and
  // the modal closes.
  const LANGUAGE_DISPLAY_KEY = {
    ko: 'settings.langKo',
    en: 'settings.langEn',
    ja: 'settings.langJa',
    de: 'settings.langDe',
    es: 'settings.langEs',
    'pt-BR': 'settings.langPtBR',
    fr: 'settings.langFr',
    it: 'settings.langIt',
    tr: 'settings.langTr',
    id: 'settings.langId',
    'zh-Hant': 'settings.langZhHant',
    'zh-Hans': 'settings.langZhHans',
  };
  // ALWAYS render a language as its own native name (English, 한국어, 日本語…)
  // so the picker stays usable when the UI is in a language the user can't
  // read. settings.langXx in each locale's own dict is set to that locale's
  // self-name, so tIn(lang, settings.langXx) gives the native form regardless
  // of the currently active language.
  function languageDisplayName(lang) {
    if (!window.QSI18n) return lang;
    const key = LANGUAGE_DISPLAY_KEY[lang];
    if (!key) return lang;
    if (typeof window.QSI18n.tIn === 'function') return window.QSI18n.tIn(lang, key);
    return window.QSI18n.t(key);
  }
  function updateLanguageValueLabel() {
    const valueEl = document.getElementById('language-value');
    if (!valueEl || !window.QSI18n) return;
    const lang = window.QSI18n.getLang();
    valueEl.textContent = languageDisplayName(lang);
    // Tag the native name with its own lang so font fallback picks the
    // language-appropriate glyphs (esp. Han variants for zh-Hans/Hant).
    valueEl.setAttribute('lang', lang);
  }
  function renderLanguageList() {
    const list = document.getElementById('language-list');
    if (!list || !window.QSI18n) return;
    const cur = window.QSI18n.getLang();
    const supported = window.QSI18n.supported || ['ko', 'en'];
    list.innerHTML = '';
    for (const code of supported) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'language-option' + (code === cur ? ' is-active' : '');
      row.dataset.lang = code;
      // Set the HTML lang attribute so the OS picks the language-appropriate
      // glyph variants (esp. for CJK where Han characters differ per locale).
      row.setAttribute('lang', code);
      row.innerHTML = `<span>${languageDisplayName(code)}</span><span class="language-check" data-icon="check"></span>`;
      if (window.QSIcons) window.QSIcons.apply(row);
      row.addEventListener('click', () => {
        window.QSI18n.setLang(code);
        closeLanguageModal();
      });
      list.appendChild(row);
    }
  }
  const languageModal = document.getElementById('language-modal');
  // First-run flow: language modal is shown before the coach. The modal's
  // close button stays hidden until the user picks a language so they can't
  // skip the choice. After selection, we run a callback (start coach).
  let pendingLanguageCallback = null;
  function openLanguageModal({ forcePick = false, onPicked = null } = {}) {
    pendingLanguageCallback = onPicked;
    renderLanguageList();
    const closeBtn = document.getElementById('language-modal-close');
    if (closeBtn) closeBtn.style.display = forcePick ? 'none' : '';
    // Swap the modal title between "Language" (re-entry from settings) and
    // "Choose your language" (first-run forced pick) so the prompt reads
    // like a call-to-action on first launch.
    const heading = languageModal?.querySelector('h3');
    if (heading && window.QSI18n) {
      heading.textContent = window.QSI18n.t(
        forcePick ? 'settings.languagePick' : 'settings.language'
      );
    }
    languageModal?.removeAttribute('hidden');
    languageModal?.classList.toggle('force-pick', forcePick);
  }
  function closeLanguageModal() {
    languageModal?.setAttribute('hidden', '');
    languageModal?.classList.remove('force-pick');
    const cb = pendingLanguageCallback;
    pendingLanguageCallback = null;
    if (cb) cb();
  }
  document.getElementById('language-row')?.addEventListener('click', () => openLanguageModal());

  // Privacy policy — opens hosted page in the system browser. Use a synthetic
  // anchor click so the link is delegated to the OS by the WebView shim
  // (Capacitor 8 routes target=_blank https links to Safari / Chrome).
  document.getElementById('privacy-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    const url = 'https://winsiner.github.io/cell-match/privacy.html';
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  document.getElementById('language-modal-close')?.addEventListener('click', closeLanguageModal);
  languageModal?.addEventListener('click', (e) => {
    if (e.target !== languageModal) return;
    // During the first-run forced pick, the user must commit to a language —
    // backdrop click does not dismiss.
    if (languageModal.classList.contains('force-pick')) return;
    closeLanguageModal();
  });
  window.addEventListener('qsLangChanged', () => {
    updateLanguageValueLabel();
    renderLanguageList();
    if (window.QSGame && typeof window.QSGame.refreshDynamicText === 'function') {
      window.QSGame.refreshDynamicText();
    }
  });
  updateLanguageValueLabel();

  document.getElementById('remove-ads-btn')?.addEventListener('click', purchaseRemoveAds);
  document.getElementById('restore-btn')?.addEventListener('click', restorePurchases);

  reviveBtn?.addEventListener('click', async () => {
    if (reviveUsedThisGame) return;
    if (!window.QSGame.canRevive()) return;
    reviveBtn.setAttribute('disabled', '');
    const ok = await showRewardedRevive();
    reviveBtn.removeAttribute('disabled');
    if (!ok) return;
    reviveUsedThisGame = true;
    reviveBtn.setAttribute('hidden', '');
    window.QSGame.revive();
    await hapticSuccess();
  });

  // Restart: if user skipped revive, show the interstitial we held back, then reset
  document.getElementById('restart')?.addEventListener('click', async () => {
    if (!reviveUsedThisGame && !adsRemoved) {
      await maybeShowInterstitial();
    }
    window.QSGame.reset();
  });

  // Rewarded-ad hook: autoplay/destroy modals delegate to mobile.js so the
  // ad-removed entitlement can short-circuit ad playback.
  window.QSGame.setHook('requestRewardedAd', async (reason) => {
    return await showRewardedAd(reason);
  });

  window.QSGame.setHook('onTap', () => { hapticLight(); });
  window.QSGame.setHook('onMatch', (size, onCycle) => {
    // Only on-cycle matches get haptic feedback. Off-cycle (combo-breaking)
    // matches stay silent kinesthetically — the muted visual is enough.
    if (onCycle) hapticSuccess();
  });
  window.QSGame.setHook('onCombo', (streak) => {
    if (streak >= 3) hapticHeavy();
    else if (streak >= 2) hapticMedium();
  });
  // Color unlock: silent. We previously toasted "GREEN joined!" but it
  // interrupted the player's flow without adding info — the new mascot
  // shows up on the board organically. Keep a small haptic so the player
  // feels the milestone, but no on-screen banner.
  window.QSGame.setHook('onColorUnlock', () => {
    hapticSuccess();
  });
  window.QSGame.setHook('onReset', () => {
    reviveUsedThisGame = false;
    reviveBtn?.setAttribute('hidden', '');
    clearAutosave();
    storeRemove(KEY_AUTOSAVE).catch(() => {});
    scheduleAutosave();
  });
  window.QSGame.setHook('onGameOver', async (score, stats) => {
    const maxCombo = stats?.maxCombo ?? 0;
    const maxChain = stats?.maxChain ?? 0;
    const matches = stats?.matches ?? 0;
    const taps = stats?.taps ?? 0;
    gamesPlayed += 1;
    await storeSet(KEY_GAMES_PLAYED, gamesPlayed);
    if (score > bestScore) {
      bestScore = score;
      await storeSet(KEY_BEST, bestScore);
    }
    if (maxCombo > bestCombo) {
      bestCombo = maxCombo;
      await storeSet(KEY_BEST_COMBO, bestCombo);
    }
    if (maxChain > bestChain) {
      bestChain = maxChain;
      await storeSet(KEY_BEST_CHAIN, bestChain);
    }
    if (matches > bestMatches) {
      bestMatches = matches;
      await storeSet(KEY_BEST_MATCHES, bestMatches);
    }
    if (bestEl) bestEl.textContent = bestScore;
    if (finalBestEl) finalBestEl.textContent = bestScore;
    // Render this-game stats + bests on the gameover screen.
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = Number(v).toLocaleString(); };
    setText('final-combo', maxCombo);
    setText('final-best-combo', bestCombo);
    setText('final-chain', maxChain);
    setText('final-best-chain', bestChain);
    // Match count for this game + all-time best. Replaces the older
    // "taps per match" stat, which mostly regressed toward 3.0 once
    // cascades stabilized and didn't carry useful comparison signal.
    setText('final-matches', matches);
    setText('final-best-matches', bestMatches);
    // Render the gameover trio with whatever colors the player unlocked.
    const goTrio = document.getElementById('go-trio');
    if (goTrio) {
      goTrio.innerHTML = '';
      for (const c of window.QSGame.getActiveColors()) {
        const m = document.createElement('div');
        m.className = `go-mascot ${c}`;
        const gm = document.createElement('div');
        gm.className = 'gm';
        m.appendChild(gm);
        goTrio.appendChild(m);
      }
    }
    await hapticMedium();
    const reviveAvailable = !reviveUsedThisGame && !adsRemoved && window.QSGame.canRevive();
    if (reviveAvailable) {
      reviveBtn?.removeAttribute('hidden');
    } else {
      reviveBtn?.setAttribute('hidden', '');
      await maybeShowInterstitial();
    }
    clearAutosave();
    await storeRemove(KEY_AUTOSAVE);
  });

  // ─── Coach (slide-based first-run tutorial) ───
  const coachEl = document.getElementById('coach');
  const coachSlides = document.querySelectorAll('.coach-slide');
  const coachDots = document.querySelectorAll('.coach-dot');
  const coachNext = document.getElementById('coach-next');
  const coachPrev = document.getElementById('coach-prev');
  const coachSkip = document.getElementById('coach-skip');
  let coachIndex = 0;
  const COACH_TOTAL = coachSlides.length;

  // Each tutorial demo runs its own setTimeout loop. Track them so we
  // can stop them when the user navigates away (or dismisses the coach)
  // without leaving CPU-burning loops running in the background.
  let comboDemoTimer = null;
  let tapDemoTimer = null;
  let neighborDemoTimer = null;
  let matchDemoTimer = null;
  let pressDemoTimer = null;
  function stopComboDemo() {
    if (comboDemoTimer) { clearTimeout(comboDemoTimer); comboDemoTimer = null; }
  }
  function stopTapDemo() {
    if (tapDemoTimer) { clearTimeout(tapDemoTimer); tapDemoTimer = null; }
  }
  function stopNeighborDemo() {
    if (neighborDemoTimer) { clearTimeout(neighborDemoTimer); neighborDemoTimer = null; }
  }
  function stopMatchDemo() {
    if (matchDemoTimer) { clearTimeout(matchDemoTimer); matchDemoTimer = null; }
  }
  function stopPressDemo() {
    if (pressDemoTimer) { clearTimeout(pressDemoTimer); pressDemoTimer = null; }
  }

  // Slide 3: match-of-three demo. Finger taps three cells in a row;
  // each collapses to blue; once all three commit, they pop and a +30
  // score popup floats above.
  function startMatchDemo() {
    stopMatchDemo();
    const demo = document.getElementById('art-match-demo');
    const row = demo && demo.querySelector('.art-md-row');
    const cells = demo && demo.querySelectorAll('.art-md-cell');
    const finger = document.getElementById('art-md-finger');
    const scoreEl = document.getElementById('art-md-score');
    if (!demo || !row || !cells || cells.length !== 3 || !finger || !scoreEl) return;

    // X offsets pre-computed: each cell is 72px wide, 8px gap, three of
    // them centered. Center cell is at 0, side cells at ±80px from
    // center. JS sets --md-finger-x so the same finger glyph travels
    // across cells via a margin-left transition.
    const offsets = [-80, 0, 80];
    const reset = () => {
      cells.forEach((c) => c.classList.remove('is-observed', 'is-popping'));
      demo.classList.remove('is-pressing', 'is-scoring');
      finger.style.setProperty('--md-finger-x', `${offsets[0]}px`);
      scoreEl.textContent = '+0';
    };

    const tapCell = (idx, onDone) => {
      finger.style.setProperty('--md-finger-x', `${offsets[idx]}px`);
      // After the finger travel completes, press down and commit.
      matchDemoTimer = setTimeout(() => {
        demo.classList.add('is-pressing');
        matchDemoTimer = setTimeout(() => {
          cells[idx].classList.add('is-observed');
          matchDemoTimer = setTimeout(() => {
            demo.classList.remove('is-pressing');
            matchDemoTimer = setTimeout(onDone, 200);
          }, 220);
        }, 240);
      }, idx === 0 ? 220 : 360);
    };

    const tick = () => {
      reset();
      // Phase 1: reading time on the three super cells.
      matchDemoTimer = setTimeout(() => {
        tapCell(0, () => tapCell(1, () => tapCell(2, () => {
          // All three observed — celebrate the match.
          cells.forEach((c) => c.classList.add('is-popping'));
          scoreEl.textContent = '+30';
          demo.classList.add('is-scoring');
          matchDemoTimer = setTimeout(() => {
            // Hold the score popup, then loop.
            matchDemoTimer = setTimeout(tick, 1600);
          }, 800);
        })));
      }, 600);
    };
    tick();
  }

  // Slide 5: quest chip ticking forward. Each quest cycles: counter
  // climbs from 0 to target, bar fills, "Unlocked!" toast pulses, then
  // the next quest takes over. Three quests rotate to communicate that
  // unlocks keep coming.
  let questDemoTimer = null;
  let questDemoFrame = null;
  function stopQuestDemo() {
    if (questDemoTimer) { clearTimeout(questDemoTimer); questDemoTimer = null; }
    if (questDemoFrame) { cancelAnimationFrame(questDemoFrame); questDemoFrame = null; }
  }
  function startQuestDemo() {
    stopQuestDemo();
    const demo = document.getElementById('art-quest-demo');
    const iconEl = document.getElementById('art-qd-icon');
    const nameEl = document.getElementById('art-qd-name');
    const fillEl = document.getElementById('art-qd-bar-fill');
    const textEl = document.getElementById('art-qd-bar-text');
    if (!demo || !iconEl || !nameEl || !fillEl || !textEl) return;

    // Pull the actual milestone list + icon renderer from the game so
    // the demo can never drift from the live quest sequence. Fall back
    // to a hand-rolled subset only if QSGame isn't ready yet (early
    // splash, unit tests).
    const t = (key, fallback) => (window.QSI18n ? window.QSI18n.t(key) : fallback);
    const liveMilestones = window.QSGame && typeof window.QSGame.getUnlockMilestones === 'function'
      ? window.QSGame.getUnlockMilestones()
      : null;
    const iconRenderer = window.QSGame && typeof window.QSGame.renderUnlockIcon === 'function'
      ? window.QSGame.renderUnlockIcon
      : null;
    // First milestone is shown with its real name + icon — the player
    // gets a concrete example of what a quest looks like. The next three
    // stay hidden as "???" so the tutorial doesn't spoil future unlocks
    // (and so the player feels there's more to discover).
    const milestones = (liveMilestones && liveMilestones.length >= 4)
      ? liveMilestones.slice(0, 4)
      : [
          { score: 1000, i18nKey: 'nextUnlock.colorG',  icon: 'mascot-g' },
          { score: 2000, i18nKey: 'nextUnlock.destroy', icon: 'destroy' },
          { score: 5000, i18nKey: 'nextUnlock.colorP',  icon: 'mascot-p' },
          { score: 7000, i18nKey: 'nextUnlock.ai',      icon: 'ai' },
        ];
    const quests = milestones.map((m, i) => ({
      locked: i > 0,
      iconKind: m.icon,
      nameKey: m.i18nKey,
      goal: m.score,
    }));
    let questIdx = 0;

    const formatNumber = (n) => n.toLocaleString();

    const runQuest = () => {
      const q = quests[questIdx];
      // Locked quests render with a neutral lock icon + the shared
      // "???" placeholder used by the rulebook for hidden entries, so
      // the tutorial reveals the quest framing without spoiling
      // specifics.
      if (q.locked) {
        iconEl.innerHTML = '<span class="art-qd-lock">🔒</span>';
        nameEl.textContent = t('rulebook.locked', '???');
        nameEl.classList.add('is-locked');
      } else {
        if (iconRenderer) iconEl.innerHTML = iconRenderer(q.iconKind);
        else iconEl.textContent = '🎯';
        nameEl.textContent = t(q.nameKey, q.nameKey);
        nameEl.classList.remove('is-locked');
      }
      const start = 0;
      const end = q.goal;
      const duration = 1800;  // ms to fill this bar
      const t0 = performance.now();
      const animate = (now) => {
        const elapsed = now - t0;
        const ratio = Math.min(1, elapsed / duration);
        const current = Math.round(start + (end - start) * ratio);
        const pct = ratio * 100;
        fillEl.style.width = `${pct}%`;
        textEl.textContent = q.locked
          ? '??? / ???'
          : `${formatNumber(current)} / ${formatNumber(end)}`;
        if (ratio < 1) {
          questDemoFrame = requestAnimationFrame(animate);
        } else {
          // Celebrate, then move to the next quest after a short hold.
          demo.classList.add('is-celebrating');
          questDemoTimer = setTimeout(() => {
            demo.classList.remove('is-celebrating');
            questIdx = (questIdx + 1) % quests.length;
            // Reset the bar visually before the next quest begins so the
            // fill animates from 0 again instead of jumping.
            fillEl.style.transition = 'none';
            fillEl.style.width = '0%';
            void fillEl.offsetWidth;
            fillEl.style.transition = '';
            questDemoTimer = setTimeout(runQuest, 200);
          }, 1100);
        }
      };
      questDemoFrame = requestAnimationFrame(animate);
    };

    // Initial paint.
    fillEl.style.width = '0%';
    runQuest();
  }

  // Slide 3: long-press → probability tooltip. The hold ring fills the
  // cell border, then the tooltip slides in; both reset between loops.
  function startPressDemo() {
    stopPressDemo();
    const demo = document.getElementById('art-press-demo');
    const cell = document.getElementById('art-pd-cell');
    if (!demo || !cell) return;
    const tick = () => {
      demo.classList.remove('is-showing');
      cell.classList.remove('is-holding');
      // Force a fresh animation start every loop.
      void cell.offsetWidth;
      pressDemoTimer = setTimeout(() => {
        cell.classList.add('is-holding');
        // Hold-ring animation runs 480ms; tooltip fires once it completes.
        pressDemoTimer = setTimeout(() => {
          demo.classList.add('is-showing');
          // Hold the tooltip on-screen long enough to read.
          pressDemoTimer = setTimeout(tick, 2200);
        }, 520);
      }, 600);
    };
    tick();
  }

  // Slide 1: single super cell collapses to observed on tap. The
  // sequence reads as a real gesture: finger slides in → presses → cell
  // collapses + tap pulse → finger lifts off → hold → restart.
  function startTapDemo() {
    stopTapDemo();
    const demo = document.getElementById('art-tap-demo');
    const cell = document.getElementById('art-td-cell');
    if (!demo || !cell) return;
    const clearAll = () => {
      cell.classList.remove('is-observed', 'is-tapping');
      demo.classList.remove('is-pressing', 'is-lifting');
    };
    const tick = () => {
      clearAll();
      // Phase 1: super state, no finger. Reading time.
      tapDemoTimer = setTimeout(() => {
        // Phase 2: finger glides in and presses. Press lives on the
        // wrapper because the cell's overflow:hidden would clip the
        // finger glyph if it sat inside.
        demo.classList.add('is-pressing');
        tapDemoTimer = setTimeout(() => {
          // Phase 3: tap pulse + collapse happen at the moment of touch.
          cell.classList.add('is-tapping');
          cell.classList.add('is-observed');
          tapDemoTimer = setTimeout(() => {
            // Phase 4: finger lifts off — cell stays observed.
            demo.classList.remove('is-pressing');
            cell.classList.remove('is-tapping');
            demo.classList.add('is-lifting');
            tapDemoTimer = setTimeout(() => {
              // Phase 5: hold the result, then loop.
              demo.classList.remove('is-lifting');
              tapDemoTimer = setTimeout(tick, 1200);
            }, 420);
          }, 380);
        }, 360);
      }, 800);
    };
    tick();
  }

  // Slide 2: tap the (initially un-tapped) center cell of a 3x3 → it
  // collapses to observed AND the 4 orthogonal neighbors boost toward
  // the tapped color. The pre-tap state shows the center as a super
  // cell just like its neighbors, so the player sees "any of these can
  // be tapped" before the demo picks one.
  function startNeighborDemo() {
    stopNeighborDemo();
    const grid = document.getElementById('art-neighbor-demo');
    const center = document.getElementById('art-nb-center');
    if (!grid || !center) return;
    const clearAll = () => {
      grid.classList.remove('is-boosted');
      center.classList.remove(
        'is-tapping', 'is-pressing', 'is-lifting', 'is-observed',
      );
    };
    const tick = () => {
      clearAll();
      // Phase 1: pre-tap reading time. Center looks identical to the
      // other cells (super state with donut + mini mascot).
      neighborDemoTimer = setTimeout(() => {
        // Phase 2: finger presses center.
        center.classList.add('is-pressing');
        neighborDemoTimer = setTimeout(() => {
          // Phase 3: center collapses to observed (full blue cell),
          //          tap ring pulses, neighbors boost.
          center.classList.add('is-tapping', 'is-observed');
          grid.classList.add('is-boosted');
          neighborDemoTimer = setTimeout(() => {
            // Phase 4: finger lifts; observed state + boost remain.
            center.classList.remove('is-pressing', 'is-tapping');
            center.classList.add('is-lifting');
            neighborDemoTimer = setTimeout(() => {
              // Phase 5: hold the result, then loop.
              center.classList.remove('is-lifting');
              neighborDemoTimer = setTimeout(tick, 1800);
            }, 420);
          }, 420);
        }, 360);
      }, 700);
    };
    tick();
  }
  function startComboDemo() {
    stopComboDemo();
    const demo = document.getElementById('art-combo-demo');
    const strip = document.getElementById('art-cd-next-strip');
    const board = document.getElementById('art-cd-board');
    const nextMascot = document.getElementById('art-cd-next-mascot');
    const nextText = document.getElementById('art-cd-next-text');
    const comboEl = document.getElementById('art-cd-combo');
    if (!demo || !strip || !board || !nextMascot || !nextText || !comboEl) return;
    const cells = board.querySelectorAll('.art-cd-cell');
    if (cells.length !== 3) return;

    // Scripted run. fill = what the player would tap; next = what NEXT
    // says before that tap. When fill === next the move scores combo;
    // mismatch breaks the streak.
    const COLOR_NAMES = { r: 'RED', b: 'BLUE', y: 'YELLOW' };
    const steps = [
      { fill: 'b', next: 'b', onCycle: true  },
      { fill: 'y', next: 'y', onCycle: true  },
      { fill: 'r', next: 'r', onCycle: true  },
      { fill: 'b', next: 'y', onCycle: false },  // NEXT=yellow but blue match → break
    ];

    let combo = 0;
    let stepIdx = 0;

    const setNext = (color) => {
      ['is-r','is-b','is-y'].forEach((cls) => {
        strip.classList.remove(cls);
        nextMascot.classList.remove(cls);
      });
      strip.classList.add(`is-${color}`);
      nextMascot.classList.add(`is-${color}`);
      nextText.textContent = COLOR_NAMES[color] || '';
    };
    const resetCells = () => {
      // Drop the previous step's color + pop animation instantly so the
      // next color doesn't blend through the old hue while the
      // background-color transition runs. Both the cell itself AND its
      // eye/mouth children carry transitions, so we suppress all three
      // for one frame before letting them re-enable.
      cells.forEach((c) => {
        c.style.transition = 'none';
        c.querySelectorAll('.art-cd-eye, .art-cd-mouth').forEach((f) => {
          f.style.transition = 'none';
        });
        c.classList.remove('is-r', 'is-b', 'is-y', 'is-popping', 'is-filled');
      });
      // Force layout so the transition: none change is applied before we
      // restore transitions.
      void board.offsetWidth;
      cells.forEach((c) => {
        c.style.transition = '';
        c.querySelectorAll('.art-cd-eye, .art-cd-mouth').forEach((f) => {
          f.style.transition = '';
        });
      });
    };
    const fillCells = (color) => {
      cells.forEach((c) => {
        c.classList.add('is-filled');
        c.classList.add(`is-${color}`);
      });
    };
    const updateCombo = (n, breaking) => {
      comboEl.textContent = `×${n}`;
      comboEl.classList.remove('is-bumping', 'is-breaking');
      void comboEl.offsetWidth;
      comboEl.classList.add(breaking ? 'is-breaking' : 'is-bumping');
    };

    setNext(steps[0].next);
    resetCells();
    comboEl.textContent = '×0';

    const tick = () => {
      const step = steps[stepIdx];
      // Phase 1: announce NEXT first so the player has time to read it.
      setNext(step.next);
      resetCells();
      // Phase 2: a beat later, the matched cells appear.
      comboDemoTimer = setTimeout(() => {
        fillCells(step.fill);
        // Phase 3: pop and score.
        comboDemoTimer = setTimeout(() => {
          cells.forEach((c) => c.classList.add('is-popping'));
          if (step.onCycle) {
            combo += 1;
            updateCombo(combo, false);
          } else {
            combo = 0;
            updateCombo(combo, true);
          }
          // Phase 4: hold the result, then advance.
          comboDemoTimer = setTimeout(() => {
            stepIdx = (stepIdx + 1) % steps.length;
            if (stepIdx === 0) combo = 0;
            tick();
          }, 1000);
        }, 820);
      }, 680);
    };
    tick();
  }

  function renderCoachSlide() {
    coachSlides.forEach((s, i) => s.classList.toggle('active', i === coachIndex));
    coachDots.forEach((d, i) => d.classList.toggle('active', i === coachIndex));
    if (coachPrev) coachPrev.hidden = coachIndex === 0;
    const isLast = coachIndex === COACH_TOTAL - 1;
    if (coachNext) {
      coachNext.textContent = window.QSI18n
        ? window.QSI18n.t(isLast ? 'coach.start' : 'coach.next')
        : (isLast ? "Let's go" : 'Next →');
      coachNext.classList.toggle('last', isLast);
    }
    // Slide-specific demo loops. Only one runs at a time; the others
    // are paused so we don't keep CPU-burning timers in the background.
    if (coachIndex === 0) startTapDemo();      else stopTapDemo();
    if (coachIndex === 1) startNeighborDemo(); else stopNeighborDemo();
    if (coachIndex === 2) startMatchDemo();    else stopMatchDemo();
    if (coachIndex === 3) startComboDemo();    else stopComboDemo();
    if (coachIndex === 4) startPressDemo();    else stopPressDemo();
    if (coachIndex === 5) startQuestDemo();    else stopQuestDemo();
  }

  function startCoach() {
    if (!coachEl) return;
    coachIndex = 0;
    renderCoachSlide();
    coachEl.hidden = false;
  }
  function endCoach() {
    if (!coachEl) return;
    coachEl.hidden = true;
    stopTapDemo();
    stopNeighborDemo();
    stopMatchDemo();
    stopPressDemo();
    stopComboDemo();
    stopQuestDemo();
    storeSet(KEY_COACH_SEEN, '1');
  }

  coachNext?.addEventListener('click', () => {
    if (coachIndex >= COACH_TOTAL - 1) endCoach();
    else { coachIndex++; renderCoachSlide(); }
  });
  coachPrev?.addEventListener('click', () => {
    if (coachIndex > 0) { coachIndex--; renderCoachSlide(); }
  });
  coachSkip?.addEventListener('click', endCoach);
  coachDots.forEach((d) => d.addEventListener('click', () => {
    coachIndex = parseInt(d.dataset.dot, 10) || 0;
    renderCoachSlide();
  }));

  // Re-watch the tutorial from settings. The "How to play" row sits with
  // the other chevron rows (language, privacy) — clicking anywhere on it
  // launches the coach.
  document.getElementById('help-row')?.addEventListener('click', () => {
    settingsModal?.setAttribute('hidden', '');
    startCoach();
  });

  // Rulebook — list of every game mechanic. Sections start locked and
  // reveal themselves once the player has actually encountered the
  // mechanic in play. Renders fresh each time the modal opens so newly
  // unlocked items appear without a reload.
  const RULEBOOK_SECTIONS = [
    'matchBasic', 'superObserved', 'combo', 'comboMultiplier',
    'cascade', 'unlockColor', 'destroy', 'cursed', 'revive', 'ai',
  ];
  function renderRulebookList() {
    const list = document.getElementById('rulebook-list');
    if (!list) return;
    list.innerHTML = '';
    let unlocked = 0;
    for (const id of RULEBOOK_SECTIONS) {
      const isUnlocked = unlockedRules.has(id);
      if (isUnlocked) unlocked += 1;
      const item = document.createElement('div');
      item.className = 'rulebook-item' + (isUnlocked ? '' : ' locked');
      const title = isUnlocked
        ? (window.QSI18n?.t(`rulebook.${id}.title`) || id)
        : (window.QSI18n?.t('rulebook.locked') || '???');
      const body = isUnlocked
        ? (window.QSI18n?.t(`rulebook.${id}.body`) || '')
        : (window.QSI18n?.t('rulebook.lockedHint') || '');
      item.innerHTML = `
        <div class="rulebook-item-header">
          <span class="rulebook-item-title">${title}</span>
          <span class="rulebook-item-icon">${isUnlocked ? '›' : ''}</span>
        </div>
        <div class="rulebook-item-body">${body}</div>
      `;
      if (isUnlocked) {
        item.addEventListener('click', () => item.classList.toggle('expanded'));
      }
      list.appendChild(item);
    }
    const progressEl = document.getElementById('rulebook-progress-text');
    if (progressEl) {
      progressEl.textContent = window.QSI18n?.t('rulebook.progress', {
        n: unlocked, total: RULEBOOK_SECTIONS.length,
      }) || `${unlocked} / ${RULEBOOK_SECTIONS.length}`;
    }
  }
  function updateRulebookSettingsBadge() {
    const el = document.getElementById('rulebook-progress');
    if (!el) return;
    el.textContent = `${unlockedRules.size} / ${RULEBOOK_SECTIONS.length}`;
  }
  const rulebookModal = document.getElementById('rulebook-modal');
  document.getElementById('rulebook-row')?.addEventListener('click', () => {
    settingsModal?.setAttribute('hidden', '');
    renderRulebookList();
    rulebookModal?.removeAttribute('hidden');
  });
  document.getElementById('rulebook-modal-close')?.addEventListener('click', () => {
    rulebookModal?.setAttribute('hidden', '');
  });
  rulebookModal?.addEventListener('click', (e) => {
    if (e.target === rulebookModal) rulebookModal.setAttribute('hidden', '');
  });
  updateRulebookSettingsBadge();
  // Refresh badge whenever a new unlock happens. Hook into QSRules.unlock.
  const origUnlock = window.QSRules.unlock;
  window.QSRules.unlock = (id) => {
    const fired = origUnlock(id);
    if (fired) updateRulebookSettingsBadge();
    return fired;
  };

  // First run: prompt for a language, then show the coach. The system
  // language has already been auto-detected by QSI18n; the modal lets the
  // user accept or override it before reading the first slide.
  const coachSeen = await storeGet(KEY_COACH_SEEN, '0');
  if (coachSeen !== '1') {
    setTimeout(() => {
      openLanguageModal({
        forcePick: true,
        onPicked: () => {
          // Small delay so the modal close transition doesn't overlap the
          // coach overlay fading in.
          setTimeout(startCoach, 200);
        },
      });
    }, 400);
  }

  // ─── Android back button ───
  // Capacitor's default eats the back button on a single-page game. Wire it
  // up so it (1) dismisses open overlays before (2) exiting the app, which
  // matches typical Android conventions.
  // (AppPlugin is the same plugin declared earlier in this IIFE.)
  if (AppPlugin && platform === 'android') {
    AppPlugin.addListener('backButton', () => {
      // Force-pick language modal absorbs back-press without dismissing —
      // the user must commit to a language before reaching the game.
      if (languageModal && !languageModal.hasAttribute('hidden')
          && languageModal.classList.contains('force-pick')) {
        return;
      }
      const aiDestroyModalEl = document.getElementById('ai-destroy-modal');
      if (aiDestroyModalEl && !aiDestroyModalEl.hidden) {
        return;
      }
      const destroyModalEl = document.getElementById('destroy-modal');
      if (destroyModalEl && !destroyModalEl.hidden) {
        const isAiCtx = window.QSGame && typeof window.QSGame.isDestroyModalAiContext === 'function'
          ? window.QSGame.isDestroyModalAiContext()
          : false;
        if (isAiCtx) return;
      }
      const coachOpen = coachEl && !coachEl.hidden;
      if (coachOpen) {
        endCoach();
        return;
      }
      const settingsOpen = settingsModal && !settingsModal.hasAttribute('hidden');
      if (settingsOpen) {
        settingsModal.setAttribute('hidden', '');
        return;
      }
      // No overlay → exit the app.
      AppPlugin.exitApp();
    });
  }

  // ─── Universal Link / App Link handler ───
  // Show a "friend challenge" modal when the app is opened via a share URL
  // like https://winsiner.github.io/cell-match/s?score=12345.
  // We still accept the legacy /quantum-match/ prefix so share links
  // generated by older builds (in the wild on testers' devices) keep
  // launching the app instead of being treated as untyped web URLs.
  const challengeModal = document.getElementById('challenge-modal');
  const challengeScoreEl = document.getElementById('challenge-score');
  const challengeAccept = document.getElementById('challenge-accept');
  const challengeClose = document.getElementById('challenge-modal-close');
  function showChallengeModal(score) {
    if (!challengeModal || !challengeScoreEl) return;
    challengeScoreEl.textContent = Number(score).toLocaleString();
    challengeModal.hidden = false;
  }
  function hideChallengeModal() {
    if (challengeModal) challengeModal.hidden = true;
  }
  challengeAccept?.addEventListener('click', hideChallengeModal);
  challengeClose?.addEventListener('click', hideChallengeModal);
  challengeModal?.addEventListener('click', (e) => {
    if (e.target === challengeModal) hideChallengeModal();
  });

  function handleIncomingUrl(url, { strict = true } = {}) {
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (strict) {
        if (!/winsiner\.github\.io$/i.test(parsed.hostname)) return;
        // Accept any of (current and legacy folders):
        //   /(cell-match|quantum-match)/s, /(...)/s/          (root)
        //   /(cell-match|quantum-match)/<lang>/s, /<...>/s/   (locale)
        const path = parsed.pathname;
        const matchRoot = /^\/(cell-match|quantum-match)\/s\/?$/.test(path);
        const matchLocale = /^\/(cell-match|quantum-match)\/[a-zA-Z-]+\/s\/?$/.test(path);
        if (!matchRoot && !matchLocale) return;
      }
      const raw = parsed.searchParams.get('score');
      const score = parseInt(raw, 10);
      if (Number.isFinite(score) && score > 0) showChallengeModal(score);
    } catch (_) { /* ignore malformed */ }
  }
  if (AppPlugin && isCapacitor) {
    AppPlugin.addListener('appUrlOpen', (data) => handleIncomingUrl(data?.url));
    // Cold start: check if the app was launched from a URL.
    AppPlugin.getLaunchUrl?.().then((res) => handleIncomingUrl(res?.url)).catch(() => {});
  } else {
    // Web preview: ?score=N on any URL triggers the modal (dev/test only).
    handleIncomingUrl(window.location.href, { strict: false });
  }

  // Save right before the app goes to background — don't wait for the next
  // interval tick. Use both visibilitychange (web/Android) and Capacitor App
  // state changes (iOS/Android native).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistAutosave();
  });
  window.addEventListener('pagehide', () => { persistAutosave(); });
  if (AppPlugin && isCapacitor) {
    AppPlugin.addListener('appStateChange', (state) => {
      if (!state.isActive) persistAutosave();
    });
    AppPlugin.addListener('pause', () => { persistAutosave(); });
  }

  // ─── Boot ───
  await initAdMob();
  await showBanner();
  initIAP();
})();
