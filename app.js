/* ============================================================
   雨の在処 — Rain Radar
   気象庁ナウキャスト + 降水短時間予報のタイル画像をLeafletに重ねて、
   過去1時間〜予報12時間をスライダーとアニメーションで操作。
   表示中データの概算解像度を精度メッシュとして地図上に重ねる。
   ============================================================ */

(() => {
  'use strict';

  // ---- Constants ------------------------------------------------------------

  const NOWC_BASE = 'https://www.jma.go.jp/bosai/jmatile/data/nowc';
  const RASRF_BASE = 'https://www.jma.go.jp/bosai/jmatile/data/rasrf';

  const N1_URL = `${NOWC_BASE}/targetTimes_N1.json`;       // 実況・高解像度降水ナウキャスト
  const N2_URL = `${NOWC_BASE}/targetTimes_N2.json`;       // 1時間先までの高解像度降水ナウキャスト
  const RASRF_URL = `${RASRF_BASE}/targetTimes.json`;      // 今後の雨・降水短時間予報

  const NOWC_TILE_TPL = (basetime, validtime) =>
    `${NOWC_BASE}/${basetime}/none/${validtime}/surf/hrpns/{z}/{x}/{y}.png`;
  const RASRF_TILE_TPL = (basetime, validtime) =>
    `${RASRF_BASE}/${basetime}/none/${validtime}/surf/rasrf/{z}/{x}/{y}.png`;

  const GSI_PALE = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';

  const PLAY_INTERVAL_MS = 620;
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min
  const RAIN_OPACITY = 0.78;
  const GRID_OPACITY = 0.48;
  const MAX_FORECAST_HOURS = 12;
  const RANGE_PRESETS = [1, 6, 12];

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
    forecastHorizon: $('#forecast-horizon'),
    gridResolution: $('#grid-resolution'),
    dataHealth: $('#data-health'),
    netBanner: $('#net-banner'),
    track: $('#timeline-track'),
    thumbs: $('#track-thumbs'),
    hourmarks: $('#timeline-hourmarks'),
    forecastAxis: $('#forecast-axis'),
    sourceNote: $('#source-note'),
    rangeTabs: document.querySelectorAll('[data-range-hours]'),
    playBtn: $('#play-btn'),
    playIcon: $('#play-icon'),
    pauseIcon: $('#pause-icon'),
    jumpNow: $('#jump-now'),
    stepBack: $('#step-back'),
    stepFwd: $('#step-forward'),
    refreshBtn: $('#refresh-btn'),
    meshBtn: $('#mesh-btn'),
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
    frames: [],          // visible frames after range filter
    fullFrames: [],      // all frames up to MAX_FORECAST_HOURS
    currentIdx: 0,       // index of frame currently shown
    nowIdx: 0,           // index of "now" (last observed)
    forecastHours: MAX_FORECAST_HOURS,
    rasrfOk: false,
    layers: new Map(),   // layerKey(frame) -> Leaflet tileLayer (cached)
    activeLayer: null,
    gridLayer: null,
    meshEnabled: true,
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

  function formatHourMinute(absMins) {
    const h = Math.floor(absMins / 60);
    const m = absMins % 60;
    if (h === 0) return `${m}分`;
    if (m === 0) return `${h}時間`;
    return `${h}時間${m}分`;
  }

  function formatSignedMinutes(mins) {
    if (mins === 0) return '現在';
    if (mins < 0) return `${formatHourMinute(Math.abs(mins))}前`;
    return `${formatHourMinute(mins)}後`;
  }

  function forecastKindLabel(frame, diffMin) {
    if (!frame.isForecast) return '高解像度実況';
    if (frame.source === 'nowc') return '高解像度予報';
    if (diffMin >= 7 * 60) return '15時間予報';
    return '降水短時間予報';
  }

  function getResolutionInfo(frame) {
    if (!frame) return { meters: 1000, label: '--', note: '格子情報なし', tone: 'nowc' };
    const nowFrame = state.frames[state.nowIdx];
    const nowDate = nowFrame ? parseJmaTime(nowFrame.validtime) : parseJmaTime(frame.validtime);
    const diffMin = Math.round((parseJmaTime(frame.validtime) - nowDate) / 60000);

    // 気象庁公表値に合わせた概算表示。
    // 高解像度降水ナウキャストは陸上・海岸近くで30分先まで250m、35〜60分先は1km。
    // 降水短時間予報は6時間先まで1km、7〜15時間先は5km。
    if (frame.source === 'nowc') {
      if (diffMin <= 30) {
        return { meters: 250, label: '250m', note: '高解像度格子', tone: 'nowc' };
      }
      return { meters: 1000, label: '1km', note: '1km格子', tone: 'forecast' };
    }
    if (diffMin >= 7 * 60) {
      return { meters: 5000, label: '5km', note: '長時間予報格子', tone: 'long' };
    }
    return { meters: 1000, label: '1km', note: '短時間予報格子', tone: 'forecast' };
  }

  function layerKey(frame) {
    return `${frame.source}:${frame.basetime}:${frame.validtime}`;
  }

  // ---- Fetch frames ---------------------------------------------------------

  async function fetchJSON(url) {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return res.json();
  }

  function normalizeFrame(f, source) {
    return {
      basetime: f.basetime,
      validtime: f.validtime,
      isForecast: source !== 'past',
      source: source === 'rasrf' ? 'rasrf' : 'nowc',
    };
  }

  function filterFramesByForecastHours(frames, nowIdx, hours) {
    const now = frames[nowIdx] ? parseJmaTime(frames[nowIdx].validtime) : null;
    if (!now) return frames;
    const limit = now.getTime() + hours * 60 * 60 * 1000;
    return frames.filter((f, i) => {
      if (i <= nowIdx) return true;
      const t = parseJmaTime(f.validtime).getTime();
      return t <= limit;
    });
  }

  async function loadFrames() {
    const [n1raw, n2raw] = await Promise.all([
      fetchJSON(N1_URL),
      fetchJSON(N2_URL),
    ]);

    // RASRF is additive. If it is unavailable, keep the existing 1-hour radar usable.
    let rasrfRaw = [];
    let rasrfOk = false;
    try {
      rasrfRaw = await fetchJSON(RASRF_URL);
      rasrfOk = Array.isArray(rasrfRaw) && rasrfRaw.length > 0;
    } catch (err) {
      console.warn('RASRF targetTimes unavailable; falling back to nowcast only.', err);
    }

    // N1 is reverse-chronological — sort ascending by validtime.
    const past = [...n1raw]
      .sort((a, b) => a.validtime.localeCompare(b.validtime))
      .map((f) => normalizeFrame(f, 'past'));

    // Trim past to ~last 60 minutes (12 frames @ 5min + current).
    const trimmedPast = past.slice(-13);
    const nowIdx = Math.max(0, trimmedPast.length - 1);
    const nowFrame = trimmedPast[nowIdx];

    if (!nowFrame) {
      throw new Error('JMA nowcast returned no observed frames');
    }

    const nowDate = parseJmaTime(nowFrame.validtime);
    const maxForecastTime = nowDate.getTime() + MAX_FORECAST_HOURS * 60 * 60 * 1000;
    const seen = new Set(trimmedPast.map((f) => f.validtime));

    // N2: high-resolution forecast up to around 1 hour. Prefer this over RASRF when duplicated.
    const futureNowc = [...n2raw]
      .sort((a, b) => a.validtime.localeCompare(b.validtime))
      .filter((f) => {
        if (seen.has(f.validtime)) return false;
        const t = parseJmaTime(f.validtime).getTime();
        return t > nowDate.getTime() && t <= maxForecastTime;
      })
      .map((f) => {
        seen.add(f.validtime);
        return normalizeFrame(f, 'forecast');
      });

    // RASRF: longer-range “今後の雨”. Use it after N2 dedupe, capped at 12h.
    const futureRasrf = [...rasrfRaw]
      .sort((a, b) => a.validtime.localeCompare(b.validtime))
      .filter((f) => {
        if (!f.basetime || !f.validtime || seen.has(f.validtime)) return false;
        const t = parseJmaTime(f.validtime).getTime();
        return t > nowDate.getTime() && t <= maxForecastTime;
      })
      .map((f) => {
        seen.add(f.validtime);
        return normalizeFrame(f, 'rasrf');
      });

    const frames = [...trimmedPast, ...futureNowc, ...futureRasrf]
      .sort((a, b) => a.validtime.localeCompare(b.validtime));

    const sortedNowIdx = frames.findIndex((f) => f.validtime === nowFrame.validtime);

    if (frames.length === 0 || sortedNowIdx < 0) {
      throw new Error('JMA returned no usable frames');
    }

    return {
      frames,
      nowIdx: sortedNowIdx,
      fetchedAt: new Date(),
      rasrfOk,
    };
  }

  // ---- Map ------------------------------------------------------------------

  function initMap() {
    state.map = L.map('map', {
      center: [35.681, 139.767],   // Tokyo Station as default
      zoom: 8,
      minZoom: 4,
      maxZoom: 14,
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

  function buildRainLayer(frame) {
    const isRasrf = frame.source === 'rasrf';
    const url = isRasrf
      ? RASRF_TILE_TPL(frame.basetime, frame.validtime)
      : NOWC_TILE_TPL(frame.basetime, frame.validtime);

    return L.tileLayer(url, {
      opacity: 0,
      attribution: isRasrf ? '気象庁 降水短時間予報' : '気象庁 高解像度降水ナウキャスト',
      maxNativeZoom: 10,
      maxZoom: 14,
      minZoom: 4,
      tileSize: 256,
      crossOrigin: false,
      errorTileUrl: '',
      className: isRasrf ? 'rain-layer rain-layer-rasrf' : 'rain-layer rain-layer-nowc',
    });
  }

  function buildPrecisionGridLayer() {
    const GridLayer = L.GridLayer.extend({
      createTile(coords) {
        const tile = document.createElement('canvas');
        const size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;

        if (!state.meshEnabled || !state.frames.length) return tile;
        const frame = state.frames[state.currentIdx];
        const info = getResolutionInfo(frame);
        const ctx = tile.getContext('2d');
        if (!ctx || !info || !info.meters) return tile;

        const centerPoint = L.point(
          coords.x * size.x + size.x / 2,
          coords.y * size.y + size.y / 2
        );
        const centerLatLng = state.map.unproject(centerPoint, coords.z);
        const latRad = centerLatLng.lat * Math.PI / 180;
        const metersPerPixel = 156543.03392 * Math.cos(latRad) / Math.pow(2, coords.z);
        let stepPx = info.meters / metersPerPixel;
        if (!Number.isFinite(stepPx) || stepPx <= 0) return tile;

        // Zoom out 時に細かすぎる格子で地図を潰さないため、等倍の粗い補助線に間引く。
        const minPx = 8;
        const skip = Math.max(1, Math.ceil(minPx / stepPx));
        stepPx *= skip;

        let stroke = 'rgba(111, 179, 255, 0.42)';
        if (info.tone === 'forecast') stroke = 'rgba(255, 181, 71, 0.40)';
        if (info.tone === 'long') stroke = 'rgba(209, 124, 255, 0.38)';

        ctx.globalAlpha = GRID_OPACITY;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 5]);

        const offsetX = ((coords.x * size.x) % stepPx + stepPx) % stepPx;
        const offsetY = ((coords.y * size.y) % stepPx + stepPx) % stepPx;

        ctx.beginPath();
        for (let x = -offsetX; x <= size.x; x += stepPx) {
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, size.y);
        }
        for (let y = -offsetY; y <= size.y; y += stepPx) {
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(size.x, Math.round(y) + 0.5);
        }
        ctx.stroke();

        return tile;
      },
    });

    return new GridLayer({
      pane: 'overlayPane',
      opacity: state.meshEnabled ? 1 : 0,
      zIndex: 440,
      tileSize: 256,
      updateWhenIdle: false,
      updateWhenZooming: false,
      className: 'precision-grid-layer',
      interactive: false,
    });
  }

  function ensurePrecisionGrid() {
    if (!state.gridLayer) {
      state.gridLayer = buildPrecisionGridLayer();
    }
    if (state.meshEnabled && !state.map.hasLayer(state.gridLayer)) {
      state.gridLayer.addTo(state.map);
    }
    if (!state.meshEnabled && state.map.hasLayer(state.gridLayer)) {
      state.map.removeLayer(state.gridLayer);
    }
    if (state.gridLayer && state.map.hasLayer(state.gridLayer)) {
      state.gridLayer.redraw();
      state.gridLayer.bringToFront();
    }
  }

  function updateGridUI(frame) {
    const info = getResolutionInfo(frame);
    if (els.gridResolution) {
      els.gridResolution.textContent = state.meshEnabled ? info.label : 'OFF';
      els.gridResolution.title = info.note;
    }
    if (els.meshBtn) {
      els.meshBtn.classList.toggle('is-active', state.meshEnabled);
      els.meshBtn.setAttribute('aria-pressed', state.meshEnabled ? 'true' : 'false');
      els.meshBtn.setAttribute('aria-label', state.meshEnabled ? '精度メッシュを非表示' : '精度メッシュを表示');
      els.meshBtn.title = state.meshEnabled ? `精度メッシュ ON：${info.label}` : '精度メッシュ OFF';
    }
  }

  function toggleMesh() {
    state.meshEnabled = !state.meshEnabled;
    const frame = state.frames[state.currentIdx];
    updateGridUI(frame);
    ensurePrecisionGrid();
    showToast(state.meshEnabled ? '精度メッシュを表示しました。' : '精度メッシュを非表示にしました。', 'success');
  }

  function showFrame(idx, { animate = true } = {}) {
    if (idx < 0 || idx >= state.frames.length) return;
    state.currentIdx = idx;

    const frame = state.frames[idx];
    const key = layerKey(frame);
    let layer = state.layers.get(key);
    if (!layer) {
      layer = buildRainLayer(frame);
      state.layers.set(key, layer);
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
    updateGridUI(frame);
    ensurePrecisionGrid();
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
      els.timeStatus.textContent = forecastKindLabel(frame, diffMin);
      els.timeStatus.classList.add('is-forecast');
      els.timeStatus.classList.toggle('is-long', diffMin >= 7 * 60);
    } else if (state.currentIdx === state.nowIdx) {
      els.timeStatus.textContent = '実況・現在';
      els.timeStatus.classList.remove('is-forecast', 'is-long');
    } else {
      els.timeStatus.textContent = '実況';
      els.timeStatus.classList.remove('is-forecast', 'is-long');
    }

    els.frameOffset.textContent = formatSignedMinutes(diffMin);
    els.frameOffset.classList.toggle('is-now', diffMin === 0);
    els.frameOffset.classList.toggle('is-forecast', diffMin > 0);
    els.jumpNow.classList.toggle('is-active', state.currentIdx === state.nowIdx);

    if (els.sourceNote) {
      if (frame.isForecast && frame.source === 'rasrf') {
        els.sourceNote.textContent = diffMin >= 7 * 60
          ? '7時間以降は1時間間隔・5km格子の予測に切替'
          : '1時間以降は降水短時間予報を表示';
      } else if (frame.isForecast) {
        els.sourceNote.textContent = '1時間先までは高解像度降水ナウキャスト';
      } else {
        els.sourceNote.textContent = '実況は高解像度降水ナウキャスト';
      }
    }
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

    if (els.forecastHorizon) {
      const last = state.frames[state.frames.length - 1];
      if (latest && last) {
        const mins = Math.max(0, Math.round((parseJmaTime(last.validtime) - parseJmaTime(latest.validtime)) / 60000));
        els.forecastHorizon.textContent = mins ? formatHourMinute(mins) : '--';
      }
    }
  }

  function renderTrack() {
    els.thumbs.innerHTML = '';
    if (els.hourmarks) els.hourmarks.innerHTML = '';
    const total = state.frames.length;
    if (total === 0) return;

    const nowFrame = state.frames[state.nowIdx];
    const nowDate = nowFrame ? parseJmaTime(nowFrame.validtime) : null;

    state.frames.forEach((f, i) => {
      const tick = document.createElement('button');
      const date = parseJmaTime(f.validtime);
      const diffMin = nowDate ? Math.round((date - nowDate) / 60000) : 0;
      const isHour = diffMin !== 0 && diffMin % 60 === 0;

      tick.type = 'button';
      tick.className = 'tick'
        + (f.isForecast ? ' is-forecast' : '')
        + (f.source === 'rasrf' ? ' is-rasrf' : '')
        + (diffMin >= 7 * 60 ? ' is-long' : '')
        + (isHour ? ' is-hour' : '');
      const pct = total === 1 ? 0 : (i / (total - 1)) * 100;
      tick.style.left = `${pct}%`;
      tick.setAttribute('aria-label', `${fmtTime(date)} ${forecastKindLabel(f, diffMin)} ${formatSignedMinutes(diffMin)}`);
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
      const pctNow = (state.nowIdx / (total - 1)) * 100;
      const firstLongIdx = state.frames.findIndex((f) => {
        if (!nowDate || !f.isForecast) return false;
        return parseJmaTime(f.validtime) - nowDate >= 7 * 60 * 60000;
      });
      const pctLong = firstLongIdx > -1 ? (firstLongIdx / (total - 1)) * 100 : 100;
      trackLine.style.background =
        `linear-gradient(90deg,
          var(--ink-faint) 0%, var(--ink-faint) ${pctNow}%,
          var(--warn) ${pctNow + 0.5}%, var(--warn) ${pctLong}%,
          var(--long) ${Math.min(100, pctLong + 0.4)}%, var(--long) 100%)`;
    }

    if (els.forecastAxis) {
      els.forecastAxis.textContent = `予報 ${state.forecastHours}時間`;
    }

    renderHourmarks();
    updateRangeTabs();
  }

  function renderHourmarks() {
    if (!els.hourmarks || state.frames.length <= 1) return;
    const now = state.frames[state.nowIdx];
    if (!now) return;
    const nowDate = parseJmaTime(now.validtime);
    const marks = state.forecastHours <= 1 ? [1] : state.forecastHours <= 6 ? [1, 3, 6] : [1, 3, 6, 9, 12];

    marks.forEach((h) => {
      const targetMin = h * 60;
      let bestIdx = -1;
      let bestDiff = Infinity;
      state.frames.forEach((f, i) => {
        const diffMin = Math.round((parseJmaTime(f.validtime) - nowDate) / 60000);
        const d = Math.abs(diffMin - targetMin);
        if (diffMin > 0 && d < bestDiff) {
          bestDiff = d;
          bestIdx = i;
        }
      });
      if (bestIdx < 0 || bestDiff > 35) return;
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'hourmark';
      mark.style.left = `${(bestIdx / (state.frames.length - 1)) * 100}%`;
      mark.textContent = `+${h}h`;
      mark.setAttribute('aria-label', `${h}時間後へ移動`);
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        stopPlaying();
        showFrame(bestIdx);
      });
      els.hourmarks.appendChild(mark);
    });
  }

  function updateRangeTabs() {
    els.rangeTabs.forEach((btn) => {
      const active = Number(btn.dataset.rangeHours) === state.forecastHours;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
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

  function setForecastRange(hours) {
    if (!state.fullFrames.length) return;
    stopPlaying();
    const current = state.frames[state.currentIdx];
    state.forecastHours = hours;
    state.frames = filterFramesByForecastHours(state.fullFrames, state.nowIdx, state.forecastHours);

    let targetIdx = state.nowIdx;
    if (current) {
      const exact = state.frames.findIndex((f) => f.validtime === current.validtime && f.source === current.source);
      if (exact >= 0) targetIdx = exact;
      else if (state.currentIdx > state.nowIdx) targetIdx = state.frames.length - 1;
      else targetIdx = Math.min(state.currentIdx, state.frames.length - 1);
    }

    renderTrack();
    showFrame(targetIdx, { animate: false });
    updateDataPanel();
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
    els.meshBtn.addEventListener('click', toggleMesh);
    els.refreshBtn.addEventListener('click', () => refresh({ manual: true }));
    els.loaderRetry.addEventListener('click', () => refresh({ manual: true, initial: true, jumpToLatest: true }));
    els.rangeTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const hours = Number(btn.dataset.rangeHours);
        if (!RANGE_PRESETS.includes(hours) || hours === state.forecastHours) return;
        setForecastRange(hours);
      });
    });

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
      else if (e.key.toLowerCase() === 'g') { toggleMesh(); }
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
      const { frames: fullFrames, nowIdx, fetchedAt, rasrfOk } = await loadFrames();
      const frames = filterFramesByForecastHours(fullFrames, nowIdx, state.forecastHours);
      const targetIdx = chooseTargetIndex(frames, nowIdx, { jumpToLatest });
      const oldLayers = state.layers;
      const prevActive = state.activeLayer;

      state.layers = new Map();
      state.fullFrames = fullFrames;
      state.frames = frames;
      state.nowIdx = nowIdx;
      state.rasrfOk = rasrfOk;
      state.lastUpdatedAt = fetchedAt;
      state.activeLayer = null;

      renderTrack();
      showFrame(targetIdx, { animate: false });
      updateDataPanel({ kind: rasrfOk ? 'ok' : 'warn', text: rasrfOk ? '最新' : '短期のみ', fetchedAt });
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
    updateRangeTabs();
    updateGridUI(null);

    await refresh({ initial: true, jumpToLatest: true });
    state.refreshTimer = setInterval(() => refresh(), REFRESH_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
