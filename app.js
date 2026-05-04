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

  // ---- DOM ------------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);
  const els = {
    map: $('#map'),
    timeStatus: $('#time-status'),
    timeMain: $('#time-main'),
    timeDate: $('#time-date'),
    track: $('#timeline-track'),
    thumbs: $('#track-thumbs'),
    playBtn: $('#play-btn'),
    playIcon: $('#play-icon'),
    pauseIcon: $('#pause-icon'),
    stepBack: $('#step-back'),
    stepFwd: $('#step-forward'),
    locateBtn: $('#locate-btn'),
    infoBtn: $('#info-btn'),
    infoModal: $('#info-modal'),
    loader: $('#loader'),
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

  // ---- Fetch frames ---------------------------------------------------------

  async function fetchJSON(url) {
    const res = await fetch(`${url}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return res.json();
  }

  async function loadFrames() {
    const [n1raw, n2raw] = await Promise.all([
      fetchJSON(N1_URL),
      fetchJSON(N2_URL),
    ]);

    // N1 is reverse-chronological — sort ascending by validtime
    const past = [...n1raw]
      .sort((a, b) => a.validtime.localeCompare(b.validtime))
      .map((f) => ({
        basetime: f.basetime,
        validtime: f.validtime,
        isForecast: false,
      }));

    // N2: forecast frames; sort ascending by validtime, dedupe
    const seen = new Set(past.map((f) => f.validtime));
    const future = [...n2raw]
      .sort((a, b) => a.validtime.localeCompare(b.validtime))
      .filter((f) => !seen.has(f.validtime))
      .map((f) => ({
        basetime: f.basetime,
        validtime: f.validtime,
        isForecast: true,
      }));

    // Trim past to ~last 60 minutes (avoid loading too much)
    const trimmedPast = past.slice(-13); // 12 frames @ 5min ≈ 60min + current

    const frames = [...trimmedPast, ...future];
    const nowIdx = trimmedPast.length - 1;

    return { frames, nowIdx };
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

    // Basemap (lightly desaturated via CSS filter)
    const basemap = L.tileLayer(GSI_PALE, {
      attribution: '地理院タイル',
      maxZoom: 18,
      className: 'basemap-layer',
    });
    basemap.addTo(state.map);

    // Show legend zoom-control attribution position
    state.map.attributionControl.setPrefix('');
  }

  function buildNowcastLayer(frame) {
    const url = TILE_TPL(frame.basetime, frame.validtime);
    return L.tileLayer(url, {
      opacity: 0,                  // start transparent for crossfade
      attribution: '気象庁ナウキャスト',
      maxNativeZoom: 10,
      maxZoom: 12,
      minZoom: 4,
      tileSize: 256,
      crossOrigin: false,
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

    // Add new layer below current, then fade
    if (!state.map.hasLayer(layer)) {
      layer.addTo(state.map);
    }

    const prev = state.activeLayer;
    state.activeLayer = layer;

    // Crossfade
    const targetOpacity = 0.78;
    if (animate) {
      // Animate via rAF for smoothness
      fadeLayer(layer, targetOpacity, 220);
      if (prev && prev !== layer) {
        fadeLayer(prev, 0, 220, () => {
          // Optionally remove very old layers from map (keep cached)
          // Keep them on the map but invisible to avoid re-fetches
        });
      }
    } else {
      layer.setOpacity(targetOpacity);
      if (prev && prev !== layer) prev.setOpacity(0);
    }

    updateTimeDisplay(frame);
    updateActiveTick(idx);
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
    const localTime = fmtTime(date);
    const localDate = fmtDate(date);

    els.timeMain.textContent = localTime;
    els.timeDate.textContent = localDate;

    if (frame.isForecast) {
      els.timeStatus.textContent = '予報';
      els.timeStatus.classList.add('is-forecast');
    } else if (state.frames.indexOf(frame) === state.nowIdx) {
      els.timeStatus.textContent = '実況・現在';
      els.timeStatus.classList.remove('is-forecast');
    } else {
      els.timeStatus.textContent = '実況';
      els.timeStatus.classList.remove('is-forecast');
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
      const pct = (i / (total - 1)) * 100;
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

    // Position the "NOW" line marker
    const nowEl = document.getElementById('track-now');
    if (nowEl && total > 1) {
      const pct = (state.nowIdx / (total - 1)) * 100;
      nowEl.style.left = `${pct}%`;
      nowEl.style.transform = 'translateX(-50%)';
    }

    // Update track-line gradient stop based on now position
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
    });
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
      // Ignore clicks on tick buttons themselves (handled separately)
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

    // If at the end, restart from beginning
    if (state.currentIdx >= state.frames.length - 1) {
      showFrame(0);
    }

    state.playTimer = setInterval(() => {
      let next = state.currentIdx + 1;
      if (next >= state.frames.length) next = 0;  // loop
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
      alert('このブラウザは位置情報に対応していません。');
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
      },
      (err) => {
        els.locateBtn.classList.remove('is-active');
        const msg = err.code === 1
          ? '位置情報の使用が許可されていません。'
          : '位置情報を取得できませんでした。';
        alert(msg);
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

  // ---- Wire up controls -----------------------------------------------------

  function setupControls() {
    els.playBtn.addEventListener('click', togglePlay);
    els.stepBack.addEventListener('click', () => {
      stopPlaying();
      showFrame(Math.max(0, state.currentIdx - 1));
    });
    els.stepFwd.addEventListener('click', () => {
      stopPlaying();
      showFrame(Math.min(state.frames.length - 1, state.currentIdx + 1));
    });
    els.locateBtn.addEventListener('click', locate);

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft')  { stopPlaying(); showFrame(Math.max(0, state.currentIdx - 1)); }
      else if (e.key === 'ArrowRight') { stopPlaying(); showFrame(Math.min(state.frames.length - 1, state.currentIdx + 1)); }
    });
  }

  // ---- Refresh loop ---------------------------------------------------------

  async function refresh() {
    try {
      const { frames, nowIdx } = await loadFrames();
      // Discard cached layers no longer matching
      const oldLayers = state.layers;
      state.layers = new Map();
      state.frames = frames;
      state.nowIdx = nowIdx;

      // Default to "now"
      const targetIdx = state.currentIdx === 0 && state.activeLayer === null
        ? nowIdx
        : Math.min(state.currentIdx, frames.length - 1);

      renderTrack();
      // Snap activeLayer to null so showFrame creates fresh
      const prevActive = state.activeLayer;
      state.activeLayer = null;
      showFrame(targetIdx, { animate: false });
      // Clean up: remove old layers after a moment
      setTimeout(() => {
        oldLayers.forEach((layer) => {
          if (state.map.hasLayer(layer)) state.map.removeLayer(layer);
        });
        if (prevActive && state.map.hasLayer(prevActive)) {
          state.map.removeLayer(prevActive);
        }
      }, 500);
    } catch (err) {
      console.error('refresh failed', err);
    }
  }

  // ---- Boot -----------------------------------------------------------------

  async function boot() {
    initMap();
    setupControls();
    setupTrackInteraction();
    setupModal();

    try {
      const { frames, nowIdx } = await loadFrames();
      state.frames = frames;
      state.nowIdx = nowIdx;
      renderTrack();
      showFrame(nowIdx, { animate: false });
      els.loader.classList.add('is-hidden');
    } catch (err) {
      console.error(err);
      els.loader.querySelector('.loader-text').textContent =
        '雨雲データを取得できませんでした。時間をおいて再読込してください。';
    }

    // Periodic refresh
    state.refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
