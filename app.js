/* ============================================================
   雨の在処 — Rain Radar
   気象庁ナウキャストのタイル画像をLeafletに重ねて、
   過去1時間〜予報1時間をスライダーとアニメーションで操作。
   ============================================================ */

(() => {
  'use strict';

  // ---- Constants ------------------------------------------------------------

  const JMA_BASE = 'https://www.jma.go.jp/bosai/jmatile/data/nowc';
  const N1_URL = `${JMA_BASE}/targetTimes_N1.json`;  // 実況 (past)
  const N2_URL = `${JMA_BASE}/targetTimes_N2.json`;  // 予報 (forecast)
  const TILE_TPL = (basetime, validtime) =>
    `${JMA_BASE}/${basetime}/none/${validtime}/surf/hrpns/{z}/{x}/{y}.png`;

  const GSI_PALE = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';

  const PLAY_INTERVAL_MS = 600;
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min
  const RAIN_OPACITY = 0.78;

  // ---- DOM ------------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);
  const els = {
    map: $('#map'),
    timeStatus: $('#time-status'),
    timeMain: $('#time-main'),
    timeDate: $('#time-date'),
    frameOffset: $('#frame-offset'),
    lastUpdated: $('#last-updated'),
    latestObserved: $('#latest-observed'),
    dataHealth: $('#data-health'),
    netBanner: $('#net-banner'),
    track: $('#timeline-track'),
    thumbs: $('#track-thumbs'),
    playBtn: $('#play-btn'),
    playIcon: $('#play-icon'),
    pauseIcon: $('#pause-icon'),
    jumpNow: $('#jump-now'),
    stepBack: $('#step-back'),
    stepFwd: $('#step-forward'),
    refreshBtn: $('#refresh-btn'),
    locateBtn: $('#locate-btn'),
    infoBtn: $('#info-btn'),
    infoModal: $('#info-modal'),
    loader: $('#loader'),
    loaderText: $('#loader .loader-text'),
    loaderRetry: $('#loader-retry'),
    toast: $('#toast'),
  };

  // ---- State ----------------------------------------------------------------

  const state = {
    frames: [],          // [{basetime, validtime, isForecast}]
    currentIdx: 0,       // index of frame currently shown
    nowIdx: 0,           // index of "now" (last observed)
    layers: new Map(),   // index -> Leaflet tileLayer (cached)
    activeLayer: null,
    map: null,
    userMarker: null,
    isPlaying: false,
    playTimer: null,
    refreshTimer: null,
    isRefreshing: false,
    lastUpdatedAt: null,
    toastTimer: null,
  };

  // ---- Time parsing ---------------------------------------------------------

  // "20210227064500" -> Date (UTC)
  function parseJmaTime(str) {
    const y = +str.slice(0, 4);
    const mo = +str.slice(4, 6) - 1;
    const d = +str.slice(6, 8);
    const h = +str.slice(8, 10);
    const mi = +str.slice(10, 12);
    const s = +str.slice(12, 14);
    return new Date(Date.UTC(y, mo, d, h, mi, s));
  }

  function fmtTime(date) {
    return date.toLocaleTimeString('ja-JP', {
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function fmtDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const wd = ['日','月','火','水','木','金','土'][date.getDay()];
    return `${y}/${m}/${d} (${wd})`;
  }

  function formatSignedMinutes(mins) {
    if (mins === 0) return '現在';
    if (mins < 0) return `${Math.abs(mins)}分前`;
    return `${mins}分後`;
  }

  // ---- Fetch frames ---------------------------------------------------------

  async function fetchJSON(url) {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return res.json();
  }

  async function loadFrames() {
    const [n1raw, n2raw] = await Promise.all([
      fetchJSON(N1_URL),
      fetchJSON(N2_URL),
    ]);

    // N1 is reverse-chronological — sort ascending by validtime.
    const past = [...n1raw]
      .sort((a, b) => a.validtime.localeCompare(b.validtime))
      .map((f) => ({
        basetime: f.basetime,
        validtime: f.validtime,
        isForecast: false,
      }));

    // N2: forecast frames; sort ascending by validtime, dedupe.
    const seen = new Set(past.map((f) => f.validtime));
    const future = [...n2raw]
      .sort((a, b) => a.validtime.localeCompare(b.validtime))
      .filter((f) => !seen.has(f.validtime))
      .map((f) => ({
        basetime: f.basetime,
        validtime: f.validtime,
        isForecast: true,
      }));

    // Trim past to ~last 60 minutes (12 frames @ 5min + current).
    const trimmedPast = past.slice(-13);
    const frames = [...trimmedPast, ...future];
    const nowIdx = Math.max(0, trimmedPast.length - 1);

    if (frames.length === 0) {
      throw new Error('JMA nowcast returned no frames');
    }

    return { frames, nowIdx, fetchedAt: new Date() };
  }

  // ---- Map ------------------------------------------------------------------

  function initMap() {
    state.map = L.map('map', {
      center: [35.681, 139.767],   // Tokyo Station as default
      zoom: 8,
      minZoom: 4,
      maxZoom: 12,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: false,
      preferCanvas: false,
    });

    const basemap = L.tileLayer(GSI_PALE, {
      attribution: '地理院タイル',
      maxZoom: 18,
      className: 'basemap-layer',
    });
    basemap.addTo(state.map);
    state.map.attributionControl.setPrefix('');
  }

  function buildNowcastLayer(frame) {
    const url = TILE_TPL(frame.basetime, frame.validtime);
    return L.tileLayer(url, {
      opacity: 0,
      attribution: '気象庁ナウキャスト',
      maxNativeZoom: 10,
      maxZoom: 12,
      minZoom: 4,
      tileSize: 256,
      crossOrigin: false,
      errorTileUrl: '',
    });
  }

  function showFrame(idx, { animate = true } = {}) {
    if (idx < 0 || idx >= state.frames.length) return;
    state.currentIdx = idx;

    const frame = state.frames[idx];
    let layer = state.layers.get(idx);
    if (!layer) {
      layer = buildNowcastLayer(frame);
      state.layers.set(idx, layer);
    }

    if (!state.map.hasLayer(layer)) {
      layer.addTo(state.map);
    }

    const prev = state.activeLayer;
    state.activeLayer = layer;

    if (animate) {
      fadeLayer(layer, RAIN_OPACITY, 220);
      if (prev && prev !== layer) {
        fadeLayer(prev, 0, 220);
      }
    } else {
      layer.setOpacity(RAIN_OPACITY);
      if (prev && prev !== layer) prev.setOpacity(0);
    }

    updateTimeDisplay(frame);
    updateActiveTick(idx);
    updateStepButtons();
  }

  function fadeLayer(layer, target, duration, done) {
    const start = layer.options.opacity ?? 0;
    const t0 = performance.now();
    function step(now) {
      const k = Math.min(1, (now - t0) / duration);
      const v = start + (target - start) * k;
      layer.setOpacity(v);
      if (k < 1) requestAnimationFrame(step);
      else if (done) done();
    }
    requestAnimationFrame(step);
  }

  // ---- UI rendering ---------------------------------------------------------

  function updateTimeDisplay(frame) {
    const date = parseJmaTime(frame.validtime);
    const nowFrame = state.frames[state.nowIdx];
    const nowDate = nowFrame ? parseJmaTime(nowFrame.validtime) : date;
    const diffMin = Math.round((date - nowDate) / 60000);

    els.timeMain.textContent = fmtTime(date);
    els.timeDate.textContent = fmtDate(date);

    if (frame.isForecast) {
      els.timeStatus.textContent = '予報';
      els.timeStatus.classList.add('is-forecast');
    } else if (state.currentIdx === state.nowIdx) {
      els.timeStatus.textContent = '実況・現在';
      els.timeStatus.classList.remove('is-forecast');
    } else {
      els.timeStatus.textContent = '実況';
      els.timeStatus.classList.remove('is-forecast');
    }

    els.frameOffset.textContent = formatSignedMinutes(diffMin);
    els.frameOffset.classList.toggle('is-now', diffMin === 0);
    els.frameOffset.classList.toggle('is-forecast', diffMin > 0);
    els.jumpNow.classList.toggle('is-active', state.currentIdx === state.nowIdx);
  }

  function updateDataPanel({ kind = 'ok', text = '最新', fetchedAt = state.lastUpdatedAt } = {}) {
    els.dataHealth.textContent = text;
    els.dataHealth.classList.toggle('is-loading', kind === 'loading');
    els.dataHealth.classList.toggle('is-warn', kind === 'warn');
    els.dataHealth.classList.toggle('is-error', kind === 'error');

    if (fetchedAt) {
      els.lastUpdated.textContent = fmtTime(fetchedAt);
    }

    const latest = state.frames[state.nowIdx];
    if (latest) {
      els.latestObserved.textContent = fmtTime(parseJmaTime(latest.validtime));
    }
  }

  function renderTrack() {
    els.thumbs.innerHTML = '';
    const total = state.frames.length;
    if (total === 0) return;

    state.frames.forEach((f, i) => {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'tick' + (f.isForecast ? ' is-forecast' : '');
      const pct = total === 1 ? 0 : (i / (total - 1)) * 100;
      tick.style.left = `${pct}%`;
      const date = parseJmaTime(f.validtime);
      tick.setAttribute('aria-label', `${fmtTime(date)} ${f.isForecast ? '予報' : '実況'}`);
      tick.dataset.idx = String(i);
      tick.addEventListener('click', (e) => {
        e.stopPropagation();
        stopPlaying();
        showFrame(i);
      });
      els.thumbs.appendChild(tick);
    });

    const nowEl = document.getElementById('track-now');
    if (nowEl && total > 1) {
      const pct = (state.nowIdx / (total - 1)) * 100;
      nowEl.style.left = `${pct}%`;
      nowEl.style.transform = 'translateX(-50%)';
    }

    const trackLine = document.querySelector('.track-line');
    if (trackLine && total > 1) {
      const pct = (state.nowIdx / (total - 1)) * 100;
      trackLine.style.background =
        `linear-gradient(90deg, var(--ink-faint) 0%, var(--ink-faint) ${pct}%, var(--warn) ${pct + 0.5}%, var(--warn) 100%)`;
    }
  }

  function updateActiveTick(idx) {
    const ticks = els.thumbs.querySelectorAll('.tick');
    ticks.forEach((t, i) => {
      t.classList.toggle('is-active', i === idx);
      if (i === idx) t.setAttribute('aria-current', 'true');
      else t.removeAttribute('aria-current');
    });
  }

  function updateStepButtons() {
    els.stepBack.disabled = state.currentIdx <= 0;
    els.stepFwd.disabled = state.currentIdx >= state.frames.length - 1;
  }

  function showToast(message, type = '') {
    clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.classList.toggle('is-error', type === 'error');
    els.toast.classList.toggle('is-success', type === 'success');
    els.toast.hidden = false;
    state.toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 2600);
  }

  function updateNetworkBanner() {
    if (!els.netBanner) return;
    els.netBanner.hidden = navigator.onLine;
    if (!navigator.onLine) {
      updateDataPanel({ kind: 'warn', text: 'オフライン' });
    }
  }

  // ---- Track interaction (drag to scrub) ------------------------------------

  function setupTrackInteraction() {
    let isDragging = false;

    function idxFromClientX(clientX) {
      const rect = els.track.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const pct = x / rect.width;
      const total = state.frames.length;
      if (total === 0) return 0;
      return Math.round(pct * (total - 1));
    }

    function onDown(e) {
      if (e.target.classList.contains('tick')) return;
      isDragging = true;
      stopPlaying();
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      showFrame(idxFromClientX(cx));
      e.preventDefault();
    }
    function onMove(e) {
      if (!isDragging) return;
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const idx = idxFromClientX(cx);
      if (idx !== state.currentIdx) showFrame(idx, { animate: false });
    }
    function onUp() { isDragging = false; }

    els.track.addEventListener('mousedown', onDown);
    els.track.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
  }

  // ---- Playback -------------------------------------------------------------

  function startPlaying() {
    if (state.isPlaying || state.frames.length === 0) return;
    state.isPlaying = true;
    els.playIcon.style.display = 'none';
    els.pauseIcon.style.display = '';
    els.playBtn.setAttribute('aria-label', '一時停止');

    if (state.currentIdx >= state.frames.length - 1) {
      showFrame(0);
    }

    state.playTimer = setInterval(() => {
      let next = state.currentIdx + 1;
      if (next >= state.frames.length) next = 0;
      showFrame(next);
    }, PLAY_INTERVAL_MS);
  }

  function stopPlaying() {
    if (!state.isPlaying) return;
    state.isPlaying = false;
    clearInterval(state.playTimer);
    state.playTimer = null;
    els.playIcon.style.display = '';
    els.pauseIcon.style.display = 'none';
    els.playBtn.setAttribute('aria-label', '再生');
  }

  function togglePlay() {
    if (state.isPlaying) stopPlaying();
    else startPlaying();
  }

  // ---- Locate ---------------------------------------------------------------

  function locate() {
    if (!('geolocation' in navigator)) {
      showToast('このブラウザは位置情報に対応していません。', 'error');
      return;
    }
    els.locateBtn.classList.add('is-active');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        state.map.setView([latitude, longitude], 10, { animate: true });

        if (state.userMarker) {
          state.userMarker.setLatLng([latitude, longitude]);
        } else {
          const icon = L.divIcon({
            className: 'user-loc-icon',
            html: '<div class="user-loc-pulse"></div>',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          });
          state.userMarker = L.marker([latitude, longitude], {
            icon, interactive: false,
          }).addTo(state.map);
        }
        showToast('現在地に移動しました。', 'success');
      },
      (err) => {
        els.locateBtn.classList.remove('is-active');
        const msg = err.code === 1
          ? '位置情報の使用が許可されていません。'
          : '位置情報を取得できませんでした。';
        showToast(msg, 'error');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  // ---- Modal ----------------------------------------------------------------

  function setupModal() {
    const open = () => {
      els.infoModal.hidden = false;
      stopPlaying();
    };
    const close = () => { els.infoModal.hidden = true; };

    els.infoBtn.addEventListener('click', open);
    els.infoModal.querySelectorAll('[data-close]').forEach((el) =>
      el.addEventListener('click', close)
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.infoModal.hidden) close();
    });
  }

  // ---- Controls -------------------------------------------------------------

  function jumpToNow() {
    stopPlaying();
    showFrame(state.nowIdx);
  }

  function setupControls() {
    els.playBtn.addEventListener('click', togglePlay);
    els.jumpNow.addEventListener('click', jumpToNow);
    els.stepBack.addEventListener('click', () => {
      stopPlaying();
      showFrame(Math.max(0, state.currentIdx - 1));
    });
    els.stepFwd.addEventListener('click', () => {
      stopPlaying();
      showFrame(Math.min(state.frames.length - 1, state.currentIdx + 1));
    });
    els.locateBtn.addEventListener('click', locate);
    els.refreshBtn.addEventListener('click', () => refresh({ manual: true }));
    els.loaderRetry.addEventListener('click', () => refresh({ manual: true, initial: true, jumpToLatest: true }));

    window.addEventListener('online', () => {
      updateNetworkBanner();
      refresh({ manual: true });
    });
    window.addEventListener('offline', updateNetworkBanner);

    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, button, a')) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft')  { stopPlaying(); showFrame(Math.max(0, state.currentIdx - 1)); }
      else if (e.key === 'ArrowRight') { stopPlaying(); showFrame(Math.min(state.frames.length - 1, state.currentIdx + 1)); }
      else if (e.key === 'Home') { jumpToNow(); }
      else if (e.key.toLowerCase() === 'r') { refresh({ manual: true }); }
    });
  }

  // ---- Refresh loop ---------------------------------------------------------

  function chooseTargetIndex(newFrames, newNowIdx, { jumpToLatest = false } = {}) {
    if (jumpToLatest || state.activeLayer === null || state.currentIdx === state.nowIdx) {
      return newNowIdx;
    }

    const current = state.frames[state.currentIdx];
    if (!current) return newNowIdx;

    const exact = newFrames.findIndex((f) => f.validtime === current.validtime);
    if (exact >= 0) return exact;

    const currentDate = parseJmaTime(current.validtime);
    let bestIdx = newNowIdx;
    let bestDiff = Infinity;
    newFrames.forEach((f, i) => {
      const diff = Math.abs(parseJmaTime(f.validtime) - currentDate);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    });
    return bestIdx;
  }

  async function refresh({ manual = false, initial = false, jumpToLatest = false } = {}) {
    if (state.isRefreshing) return;

    if (!navigator.onLine) {
      updateNetworkBanner();
      showToast('オフラインのため、雨雲データを再取得できません。', 'error');
      if (initial) {
        els.loaderText.textContent = 'オフラインです。通信復旧後に再読み込みしてください。';
        els.loaderRetry.hidden = false;
      }
      return;
    }

    state.isRefreshing = true;
    els.refreshBtn.classList.add('is-loading');
    els.loaderRetry.hidden = true;
    updateDataPanel({ kind: 'loading', text: '更新中' });
    if (initial) els.loaderText.textContent = '雨雲データを読み込み中…';

    try {
      const { frames, nowIdx, fetchedAt } = await loadFrames();
      const targetIdx = chooseTargetIndex(frames, nowIdx, { jumpToLatest });
      const oldLayers = state.layers;
      const prevActive = state.activeLayer;

      state.layers = new Map();
      state.frames = frames;
      state.nowIdx = nowIdx;
      state.lastUpdatedAt = fetchedAt;
      state.activeLayer = null;

      renderTrack();
      showFrame(targetIdx, { animate: false });
      updateDataPanel({ kind: 'ok', text: '最新', fetchedAt });
      els.loader.classList.add('is-hidden');

      setTimeout(() => {
        oldLayers.forEach((layer) => {
          if (state.map.hasLayer(layer)) state.map.removeLayer(layer);
        });
        if (prevActive && state.map.hasLayer(prevActive)) state.map.removeLayer(prevActive);
      }, 500);

      if (manual && !initial) showToast('雨雲データを更新しました。', 'success');
    } catch (err) {
      console.error('refresh failed', err);
      updateDataPanel({ kind: state.frames.length ? 'warn' : 'error', text: state.frames.length ? '更新失敗' : '取得失敗' });
      if (initial || state.frames.length === 0) {
        els.loader.classList.remove('is-hidden');
        els.loaderText.textContent = '雨雲データを取得できませんでした。通信状態を確認して再読み込みしてください。';
        els.loaderRetry.hidden = false;
      } else {
        showToast('雨雲データの更新に失敗しました。表示中のデータを維持します。', 'error');
      }
    } finally {
      state.isRefreshing = false;
      els.refreshBtn.classList.remove('is-loading');
      updateNetworkBanner();
    }
  }

  // ---- Boot -----------------------------------------------------------------

  async function boot() {
    initMap();
    setupControls();
    setupTrackInteraction();
    setupModal();
    updateNetworkBanner();
    updateStepButtons();

    await refresh({ initial: true, jumpToLatest: true });
    state.refreshTimer = setInterval(() => refresh(), REFRESH_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
