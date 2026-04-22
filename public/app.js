'use strict';

const WS_PORT  = 8765;
let   vuSegs   = parseInt(localStorage.getItem('pw-vu-segs') || '32');
const VU_BOOST = 1.13; // sensitivity multiplier — lifts quiet peaks
const ZOOM_STEP = 0.1;
const ZOOM_MIN  = 0.4;
const ZOOM_MAX  = 2.5;

const sendTimers = {};
let currentSinks = [];
let sourceRoutes  = {};   // source_name -> sink_name

const VIRTUAL_COLOR = '#7744cc';
const SINK_PALETTE  = [
  '#00d4aa',  // teal
  '#e07030',  // orange
  '#3090e0',  // blue
  '#60c040',  // green
  '#d4b820',  // yellow
  '#d040a0',  // pink
  '#e04030',  // red
  '#30c0d0',  // cyan
];

// ── Sink colors ───────────────────────────────────────────────────────────

const SINK_COLORS_KEY = 'pw-sink-colors';

function loadSinkColors() {
  try { return JSON.parse(localStorage.getItem(SINK_COLORS_KEY) || '{}'); }
  catch { return {}; }
}

function saveSinkColor(sinkIndex, color) {
  const map = loadSinkColors();
  map[sinkIndex] = color;
  localStorage.setItem(SINK_COLORS_KEY, JSON.stringify(map));
  schedSendSettings();
}

function getSinkColor(sinkIndex) {
  return loadSinkColors()[sinkIndex] || null;
}

function applyColorToStrip(strip, color) {
  strip.style.setProperty('--strip-color', color || 'transparent');
  const band = strip.querySelector('.color-band');
  if (band) band.style.background = color || 'transparent';
}

// Returns saved color, or VIRTUAL_COLOR if the sink is virtual, or null
function getEffectiveSinkColor(sinkIndex) {
  const saved = getSinkColor(sinkIndex);
  if (saved) return saved;
  const idx = parseInt(sinkIndex);
  const sinks = lastState ? lastState.sinks : [];
  const sink = sinks.find(s => s.index === idx);
  return (sink && sink.virtual) ? VIRTUAL_COLOR : null;
}

function applyColorsToAppStrips(sinkIndex) {
  const color = getEffectiveSinkColor(sinkIndex);
  document.querySelectorAll(`.strip[data-type="sink-input"][data-sink="${sinkIndex}"]`)
    .forEach(s => applyColorToStrip(s, color));
}

// Populate a source-routing dropdown with virtual sinks
function fillSourceRouteSel(sel, currentRoute) {
  const prev = sel.value !== undefined ? sel.value : currentRoute;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '— no route —';
  sel.appendChild(none);
  (lastState ? lastState.sinks : []).filter(s => s.virtual).forEach(s => {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = shortLabel(s.description || s.name);
    o.selected = s.name === (prev || currentRoute);
    sel.appendChild(o);
  });
  if (!sel.value) sel.value = '';
}

function refreshAllAppColors() {
  document.querySelectorAll('.strip[data-type="sink-input"]').forEach(s => {
    const sinkIdx = s.dataset.sink;
    if (sinkIdx != null) applyColorToStrip(s, getEffectiveSinkColor(sinkIdx));
  });
}

// ── Server settings sync ──────────────────────────────────────────────────

let settingsApplied = false;
let settingsTimer   = null;

function sendSettings() {
  const panelWidths = {};
  for (const id of ['panel-inputs', 'panel-outputs', 'panel-media']) {
    const p = document.getElementById(id);
    if (p && p.style.width) panelWidths[id] = p.style.width;
  }
  const mediaTop = document.getElementById('media-top');
  send({
    type: 'save_settings',
    hidden_devices: [...getHidden()],
    ui: {
      zoom,
      vu_segs: vuSegs,
      media_visible: mediaVisible,
      panel_widths: panelWidths,
      media_top_height: (mediaTop && mediaTop.style.height) || null,
      sink_colors: loadSinkColors(),
    },
  });
}

function schedSendSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(sendSettings, 300);
}

function applyServerSettings(settings) {
  if (settings.hidden_devices !== undefined) {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(settings.hidden_devices));
  }
  const ui = settings.ui || {};
  if (ui.zoom != null) {
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parseFloat(ui.zoom) || 1));
    localStorage.setItem('pw-zoom', zoom);
    applyZoom();
  }
  if (ui.vu_segs != null) {
    vuSegs = Math.max(8, Math.min(64, parseInt(ui.vu_segs) || 32));
    localStorage.setItem('pw-vu-segs', vuSegs);
  }
  if (ui.media_visible != null) {
    mediaVisible = !!ui.media_visible;
    localStorage.setItem('pw-media-visible', mediaVisible);
    applyMediaVisibility();
  }
  if (ui.sink_colors && Object.keys(ui.sink_colors).length > 0) {
    localStorage.setItem(SINK_COLORS_KEY, JSON.stringify(ui.sink_colors));
  }
  const pw = ui.panel_widths || {};
  for (const id of ['panel-inputs', 'panel-outputs', 'panel-media']) {
    const w = pw[id];
    if (w) {
      const p = document.getElementById(id);
      if (p) { p.style.width = w; p.style.flexShrink = '0'; localStorage.setItem('pw-panel-' + id, w); }
    }
  }
  if (ui.media_top_height) {
    const el = document.getElementById('media-top');
    if (el) { el.style.height = ui.media_top_height; el.style.flexShrink = '0'; localStorage.setItem('pw-media-top-h', ui.media_top_height); }
  }
}

function hasServerSettings(settings) {
  if (!settings) return false;
  if (settings.hidden_devices && settings.hidden_devices.length > 0) return true;
  const ui = settings.ui || {};
  return ui.zoom != null || ui.vu_segs != null || ui.media_visible != null ||
         ui.panel_widths || ui.media_top_height ||
         (ui.sink_colors && Object.keys(ui.sink_colors).length > 0);
}

// ── Media panel visibility ────────────────────────────────────────────────

let mediaVisible = localStorage.getItem('pw-media-visible') !== 'false';

function applyMediaVisibility() {
  document.getElementById('panel-media').classList.toggle('collapsed', !mediaVisible);
  document.getElementById('rh-media').classList.toggle('collapsed', !mediaVisible);
  document.getElementById('toggle-media').classList.toggle('toggled', !mediaVisible);
}

// ── Zoom ──────────────────────────────────────────────────────────────────

let zoom = parseFloat(localStorage.getItem('pw-zoom') || '1');

function applyZoom() {
  document.documentElement.style.setProperty('--zoom', zoom);
  document.getElementById('zoom-label').textContent = Math.round(zoom * 100) + '%';
}

function adjustZoom(d) {
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round((zoom + d) * 10) / 10));
  localStorage.setItem('pw-zoom', zoom);
  applyZoom();
  schedSendSettings();
}

// ── Panel resize ──────────────────────────────────────────────────────────

function initResize(handle, panel, panelOnLeft) {
  // panelOnLeft=true  → drag right widens the panel (panel is left of handle)
  // panelOnLeft=false → drag left  widens the panel (panel is right of handle)
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = panel.offsetWidth;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';

    function onMove(ev) {
      const delta = panelOnLeft ? ev.clientX - x0 : x0 - ev.clientX;
      const newW  = Math.max(90, Math.min(w0 + delta, window.innerWidth * 0.55 / zoom));
      panel.style.width      = newW + 'px';
      panel.style.flexShrink = '0';
    }
    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup',   onUp);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      localStorage.setItem('pw-panel-' + panel.id, panel.style.width);
      schedSendSettings();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',   onUp);
  });
}

// ── WebSocket ──────────────────────────────────────────────────────────────

let ws = null;

function connect() {
  setStatus('connecting');
  ws = new WebSocket(`ws://${window.location.hostname}:${WS_PORT}`);
  ws.addEventListener('open',    ()   => setStatus('connected'));
  ws.addEventListener('message', (ev) => onMsg(JSON.parse(ev.data)));
  ws.addEventListener('close',   ()   => { setStatus('disconnected'); setTimeout(connect, 2500); });
  ws.addEventListener('error',   ()   => ws.close());
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setStatus(s) {
  document.getElementById('status-dot').className    = 'status-dot ' + s;
  document.getElementById('status-label').textContent =
    s === 'connected' ? 'Connected' : s === 'connecting' ? 'Connecting…' : 'Disconnected — retrying…';
}

// ── Message routing ────────────────────────────────────────────────────────

function onMsg(msg) {
  if      (msg.type === 'state')  onState(msg);
  else if (msg.type === 'peaks')  onPeaks(msg.data);
  else if (msg.type === 'media')  onMedia(msg);
  else if (msg.type === 'sounds') renderSoundboard(msg.sounds);
}

// ── VU meter ───────────────────────────────────────────────────────────────

function mkVu() {
  const el = document.createElement('div');
  el.className = 'vu';
  for (let i = 0; i < vuSegs; i++) {
    const s = document.createElement('div');
    s.className = 'vu-seg';
    el.appendChild(s);
  }
  return el;
}

function rebuildAllVu() {
  document.querySelectorAll('.vu').forEach(vu => {
    vu.innerHTML = '';
    for (let i = 0; i < vuSegs; i++) {
      const s = document.createElement('div');
      s.className = 'vu-seg';
      vu.appendChild(s);
    }
  });
}

function setVu(vu, level) {
  const segs = vu.children.length;
  const lit  = Math.round(Math.min(level * VU_BOOST, 100) / 100 * segs);
  const ylw  = Math.round(segs * 0.58);
  const red  = Math.round(segs * 0.83);
  for (let i = 0; i < segs; i++) {
    const s = vu.children[i];
    s.className = i < lit
      ? 'vu-seg ' + (i >= red ? 'r' : i >= ylw ? 'y' : 'g')
      : 'vu-seg';
  }
}

function onPeaks(data) {
  for (const [key, peak] of Object.entries(data)) {
    let type, idx;
    if      (key.startsWith('sink-input-')) { type = 'sink-input'; idx = key.slice(11); }
    else if (key.startsWith('sink-'))        { type = 'sink';       idx = key.slice(5);  }
    else if (key.startsWith('source-'))      { type = 'source';     idx = key.slice(7);  }
    else continue;

    const strip = document.querySelector(`.strip[data-type="${type}"][data-index="${idx}"]`);
    if (strip) setVu(strip.querySelector('.vu'), peak);
  }
}

// ── Volume send (debounced) ────────────────────────────────────────────────

function schedVol(type, index, vol) {
  const k = type + index;
  clearTimeout(sendTimers[k]);
  sendTimers[k] = setTimeout(() => send({ type: 'set_volume', target: type, index, volume: vol }), 40);
}

// ── Sink selector helpers ──────────────────────────────────────────────────

function shortLabel(str, max = 13) {
  if (!str) return '?';
  str = str.replace(/\s+(Analogue?s?\s+(Stereo|Mono)|Digital\s+Stereo|Analoges\s+Stereo)\s*$/i, '');
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function fillSelect(sel, activeSinkIdx) {
  // Preserve whatever the user has selected; only use activeSinkIdx as fallback
  const prev = sel.options.length > 0 ? parseInt(sel.value, 10) : activeSinkIdx;
  sel.innerHTML = '';
  for (const sink of currentSinks) {
    const o   = document.createElement('option');
    o.value   = sink.index;
    o.textContent = shortLabel(sink.description || sink.name);
    o.selected    = sink.index === prev;
    sel.appendChild(o);
  }
  // Fallback if nothing matched
  if (!sel.value) {
    const fb = [...sel.options].find(o => parseInt(o.value) === activeSinkIdx);
    if (fb) fb.selected = true;
  }
}

// ── Strip creation ─────────────────────────────────────────────────────────

function mkStrip(item, type, chNum) {
  const hw = type === 'sink' || type === 'source';

  const strip = document.createElement('div');
  strip.className       = 'strip';
  strip.dataset.index   = item.index;
  strip.dataset.type    = type;
  if (type === 'sink-input' && item.sink != null) strip.dataset.sink = item.sink;

  // ── Color band ──────────────────────────────────────────
  const band = document.createElement('div');
  band.className = 'color-band';
  strip.appendChild(band);

  // ── Header ──────────────────────────────────────────────
  const hdr = document.createElement('div');
  hdr.className = 's-header';
  if (hw) {
    hdr.classList.add('hw');
    const topRow = document.createElement('div');
    topRow.className = 'ch-top-row';

    const b = document.createElement('div');
    b.className   = item.virtual ? 'ch-badge ch-badge-virtual' : 'ch-badge';
    b.textContent = item.virtual ? 'V' : chNum;
    topRow.appendChild(b);

    if (type === 'sink') {
      // Auto-assign a palette colour on first encounter and persist it
      if (!getSinkColor(item.index)) {
        const auto = item.virtual
          ? VIRTUAL_COLOR
          : SINK_PALETTE[(chNum - 1) % SINK_PALETTE.length];
        saveSinkColor(item.index, auto);
      }
      const colorInput = document.createElement('input');
      colorInput.type      = 'color';
      colorInput.className = 'color-pick';
      colorInput.value     = getSinkColor(item.index);
      colorInput.addEventListener('input', () => {
        const c = colorInput.value;
        saveSinkColor(item.index, c);
        applyColorToStrip(strip, c);
        applyColorsToAppStrips(item.index);
      });
      topRow.appendChild(colorInput);
    }
    hdr.appendChild(topRow);

    const nameEl = document.createElement('div');
    nameEl.className = 'ch-name';
    nameEl.title     = item.description || item.name || '';
    nameEl.textContent = shortLabel(item.description || item.name || '', 11);
    hdr.appendChild(nameEl);
  } else {
    const n = document.createElement('div');
    n.className   = 'app-name';
    n.title       = item.appName || item.mediaName || 'Stream';
    n.textContent = shortLabel(item.appName || item.mediaName || 'Stream', 10);
    hdr.appendChild(n);
  }
  strip.appendChild(hdr);

  // ── Body: VU + fader ────────────────────────────────────
  const body = document.createElement('div');
  body.className = 's-body';

  // .vu-col stretches to full body height; .vu inside it is 50%
  const vuCol = document.createElement('div');
  vuCol.className = 'vu-col';
  const vu = mkVu();
  vuCol.appendChild(vu);
  body.appendChild(vuCol);

  const fw = document.createElement('div');
  fw.className = 'fader-wrap';
  const fader = document.createElement('input');
  fader.type      = 'range';
  fader.className = 'fader';
  fader.min = 0; fader.max = 150; fader.step = 1;
  fader.value = item.volume;
  fader.addEventListener('input', () => {
    const v = +fader.value;
    setVol(strip, v);
    schedVol(type, item.index, v);
  });
  fw.appendChild(fader);
  body.appendChild(fw);
  strip.appendChild(body);

  // ── Footer: vol% / sink-sel / mute ──────────────────────
  const foot = document.createElement('div');
  foot.className = 's-footer';

  const volEl = document.createElement('div');
  volEl.className = 'vol-pct';
  foot.appendChild(volEl);

  if (type === 'sink-input') {
    const sel = document.createElement('select');
    sel.className = 'sink-sel';
    fillSelect(sel, item.sink);
    sel.addEventListener('change', (e) => {
      e.stopPropagation();
      const sinkIdx = parseInt(sel.value, 10);
      if (!isNaN(sinkIdx)) {
        strip.dataset.sink = sinkIdx;
        applyColorToStrip(strip, getEffectiveSinkColor(sinkIdx));
        send({ type: 'move_sink_input', index: item.index, sink: sinkIdx });
      }
    });
    foot.appendChild(sel);
  }

  if (type === 'source') {
    const routeSel = document.createElement('select');
    routeSel.className = 'sink-sel route-sel';
    fillSourceRouteSel(routeSel, sourceRoutes[item.name] || '');
    routeSel.addEventListener('change', (e) => {
      e.stopPropagation();
      const sinkName = routeSel.value;
      const targetSink = (lastState ? lastState.sinks : []).find(s => s.name === sinkName);
      const color = targetSink ? getEffectiveSinkColor(targetSink.index) : null;
      applyColorToStrip(strip, color);
      send({ type: 'route_source', source_name: item.name, sink_name: sinkName });
    });
    foot.appendChild(routeSel);
  }

  const muteBtn = document.createElement('button');
  muteBtn.type      = 'button';
  muteBtn.className = 'mute-btn';
  muteBtn.textContent = 'MUTE';
  // Read mute state from DOM (button class), not from stale item closure
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowMuted = !muteBtn.classList.contains('on');
    setMute(strip, muteBtn, nowMuted);
    send({ type: 'set_mute', target: type, index: item.index, mute: nowMuted });
  });
  foot.appendChild(muteBtn);
  strip.appendChild(foot);

  // Apply initial state
  setVol(strip, item.volume);
  setVu(vu, 0);
  setMute(strip, muteBtn, item.mute);
  if (item.corked) strip.classList.add('corked');

  // Apply color
  if (type === 'sink') {
    const c = getEffectiveSinkColor(item.index);
    if (c) applyColorToStrip(strip, c);
  } else if (type === 'sink-input' && item.sink != null) {
    const c = getEffectiveSinkColor(item.sink);
    if (c) applyColorToStrip(strip, c);
  } else if (type === 'source') {
    const routedName = sourceRoutes[item.name] || '';
    if (routedName) {
      const targetSink = (lastState ? lastState.sinks : []).find(s => s.name === routedName);
      if (targetSink) applyColorToStrip(strip, getEffectiveSinkColor(targetSink.index));
    }
  }

  return strip;
}

function setMute(strip, btn, muted) {
  strip.classList.toggle('muted', muted);
  btn.classList.toggle('on', muted);
}

function setVol(strip, vol) {
  const el = strip.querySelector('.vol-pct');
  if (el) { el.textContent = vol + '%'; el.classList.toggle('clip', vol > 100); }
}

// ── Label bars ─────────────────────────────────────────────────────────────

function updateLabels(barId, items) {
  const bar = document.getElementById(barId);
  if (!bar) return;
  bar.innerHTML = '';
  items.forEach((item, i) => {
    const d = document.createElement('div');
    d.className = 'ch-lbl';
    d.innerHTML = `<span class="ch-lbl-n">${i + 1}</span>`
                + `<span class="ch-lbl-d" title="${item.description || item.name || ''}">${item.description || item.name || '—'}</span>`;
    bar.appendChild(d);
  });
}

// ── Section render (diff-based) ─────────────────────────────────────────────

function renderSection(stripsId, items, type, labelsId) {
  const cont  = document.getElementById(stripsId);
  const empty = document.getElementById(stripsId.replace('strips-', 'empty-'));

  const existing = {};
  cont.querySelectorAll('.strip').forEach(el => { existing[el.dataset.index] = el; });

  const newSet = new Set(items.map(i => String(i.index)));

  // Remove gone strips
  Object.keys(existing).forEach(k => { if (!newSet.has(k)) existing[k].remove(); });

  items.forEach((item, pos) => {
    const key = String(item.index);
    if (key in existing) {
      // ── Update existing strip in place ──
      const strip = existing[key];
      const fader = strip.querySelector('.fader');
      const muteBtn = strip.querySelector('.mute-btn');

      if (fader !== document.activeElement) {
        fader.value = item.volume;
        setVol(strip, item.volume);
      }
      // Only update mute if it differs from DOM state (avoid overwriting user action mid-flight)
      const domMuted = muteBtn.classList.contains('on');
      if (domMuted !== item.mute) setMute(strip, muteBtn, item.mute);

      strip.classList.toggle('corked', !!item.corked);

      if (type === 'sink-input') {
        if (item.sink != null) {
          strip.dataset.sink = item.sink;
          applyColorToStrip(strip, getEffectiveSinkColor(item.sink));
        }
        const sel = strip.querySelector('.sink-sel');
        if (sel) fillSelect(sel, item.sink);
      }

      if (type === 'source') {
        const routeSel = strip.querySelector('.route-sel');
        if (routeSel) fillSourceRouteSel(routeSel, sourceRoutes[item.name] || '');
        const routedName = sourceRoutes[item.name] || '';
        if (routedName) {
          const targetSink = (lastState ? lastState.sinks : []).find(s => s.name === routedName);
          if (targetSink) applyColorToStrip(strip, getEffectiveSinkColor(targetSink.index));
        } else {
          applyColorToStrip(strip, null);
        }
      }

      // Re-order if needed
      if (cont.children[pos] !== strip) cont.insertBefore(strip, cont.children[pos] || null);
    } else {
      cont.insertBefore(mkStrip(item, type, pos + 1), cont.children[pos] || null);
    }
  });

  if (empty) empty.classList.toggle('on', items.length === 0);
  if (labelsId) updateLabels(labelsId, items);
}

// ── Settings ────────────────────────────────────────────────────────────────

const HIDDEN_KEY = 'pw-hidden';
let lastState = null;

function getHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); }
  catch { return new Set(); }
}
function setHidden(set) {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]));
  schedSendSettings();
}

function openSettings() {
  if (!lastState) return;
  const body = document.getElementById('settings-body');
  const hidden = getHidden();
  body.innerHTML = '';

  function makeSection(title, items) {
    if (!items.length) return;
    const sec = document.createElement('div');
    sec.className = 'settings-section';
    const h = document.createElement('div');
    h.className = 'settings-section-title';
    h.textContent = title;
    sec.appendChild(h);
    items.forEach(item => {
      const lbl = document.createElement('label');
      lbl.className = 'settings-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !hidden.has(item.name);
      cb.addEventListener('change', () => {
        const h2 = getHidden();
        if (cb.checked) h2.delete(item.name); else h2.add(item.name);
        setHidden(h2);
        if (lastState) applyState(lastState);
      });
      lbl.appendChild(cb);
      const txt = document.createElement('span');
      txt.textContent = item.description || item.name || 'Unknown';
      lbl.appendChild(txt);
      sec.appendChild(lbl);
    });
    body.appendChild(sec);
  }

  // ── Display ──
  const dsec = document.createElement('div');
  dsec.className = 'settings-section';
  const dh = document.createElement('div');
  dh.className = 'settings-section-title';
  dh.textContent = 'Display';
  dsec.appendChild(dh);

  const vuRow = document.createElement('div');
  vuRow.className = 'settings-row settings-slider-row';
  const vuLbl = document.createElement('span');
  vuLbl.textContent = 'VU segments';
  const vuVal = document.createElement('span');
  vuVal.className = 'settings-slider-val';
  vuVal.textContent = vuSegs;
  const vuSlider = document.createElement('input');
  vuSlider.type = 'range'; vuSlider.min = 8; vuSlider.max = 64; vuSlider.step = 4;
  vuSlider.value = vuSegs;
  vuSlider.className = 'settings-slider';
  vuSlider.addEventListener('input', () => {
    vuVal.textContent = vuSlider.value;
  });
  vuSlider.addEventListener('change', () => {
    vuSegs = parseInt(vuSlider.value);
    localStorage.setItem('pw-vu-segs', vuSegs);
    rebuildAllVu();
    schedSendSettings();
  });
  vuRow.appendChild(vuLbl);
  vuRow.appendChild(vuSlider);
  vuRow.appendChild(vuVal);
  dsec.appendChild(vuRow);
  body.appendChild(dsec);

  makeSection('Hardware Inputs',  lastState.sources);
  makeSection('Hardware Outputs', lastState.sinks);

  // ── Virtual Outputs ──
  const vsec = document.createElement('div');
  vsec.className = 'settings-section';
  const vh = document.createElement('div');
  vh.className = 'settings-section-title';
  vh.textContent = 'Virtual Outputs';
  vsec.appendChild(vh);

  (lastState.virtualSinks || []).forEach(vs => {
    const row = document.createElement('div');
    row.className = 'settings-row settings-vs-row';
    const info = document.createElement('span');
    info.style.flex = '1';
    info.textContent = vs.display_name + (vs.loopback_sink ? ' → ' + shortLabel(vs.loopback_sink, 18) : '');
    row.appendChild(info);
    const del = document.createElement('button');
    del.className = 'settings-del-btn';
    del.textContent = '🗑';
    del.title = 'Delete virtual output';
    del.addEventListener('click', () => {
      send({ type: 'delete_virtual_sink', sink_name: vs.sink_name });
      row.remove();
    });
    row.appendChild(del);
    vsec.appendChild(row);
  });

  // Add form
  const addRow = document.createElement('div');
  addRow.className = 'settings-add-row';
  const nameIn = document.createElement('input');
  nameIn.type = 'text'; nameIn.placeholder = 'Name…'; nameIn.className = 'settings-text-input';
  const loopSel = document.createElement('select');
  loopSel.className = 'settings-loop-sel';
  const noneOpt = document.createElement('option');
  noneOpt.value = ''; noneOpt.textContent = '(no loopback)';
  loopSel.appendChild(noneOpt);
  // Populate with physical (non-virtual) sinks
  (lastState.sinks || []).filter(s => !s.virtual).forEach(s => {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = shortLabel(s.description || s.name, 16);
    loopSel.appendChild(o);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'settings-add-btn';
  addBtn.textContent = '+ Add';
  addBtn.addEventListener('click', () => {
    const name = nameIn.value.trim();
    if (!name) return;
    send({ type: 'create_virtual_sink', name, loopback_sink: loopSel.value });
    nameIn.value = '';
  });
  addRow.appendChild(nameIn);
  addRow.appendChild(loopSel);
  addRow.appendChild(addBtn);
  vsec.appendChild(addRow);
  body.appendChild(vsec);

  document.getElementById('settings-overlay').classList.remove('hidden');
}

// ── Media controls ──────────────────────────────────────────────────────────

let currentMediaPlayer = '';

function onMedia(data) {
  currentMediaPlayer = data.player || '';
  document.getElementById('media-player').textContent = data.player ? '[' + data.player + ']' : '';
  document.getElementById('media-title').textContent  = data.title  || 'Nothing playing';
  document.getElementById('media-artist').textContent = data.artist || '';
  document.getElementById('mc-play').textContent = data.status === 'Playing' ? '⏸' : '▶';
}

// ── Soundboard ───────────────────────────────────────────────────────────────

function fillSbSinkSel(sinks) {
  const sel = document.getElementById('sb-sink');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  sinks.forEach(s => {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = shortLabel(s.description || s.name);
    o.selected = s.name === prev;
    sel.appendChild(o);
  });
}

function renderSoundboard(sounds) {
  const grid = document.getElementById('sb-grid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!sounds || sounds.length === 0) {
    grid.innerHTML = '<div class="sb-empty">Drop .mp3 / .wav files<br>into <code>sounds/</code></div>';
    return;
  }
  sounds.forEach(name => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sb-btn';
    btn.textContent = name.replace(/\.[^.]+$/, '');
    btn.title = name;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sb-btn.active').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      send({ type: 'play_sound', file: name, sink: document.getElementById('sb-sink').value });
    });
    grid.appendChild(btn);
  });
}

// ── State handler ───────────────────────────────────────────────────────────

function applyState(state) {
  const hidden = getHidden();
  currentSinks = state.sinks.filter(s => !hidden.has(s.name));  // shared by all dropdowns
  renderSection('strips-sources',    state.sources.filter(s => !hidden.has(s.name)), 'source',     null);
  renderSection('strips-sinkinputs', state.sinkInputs, 'sink-input', null);
  renderSection('strips-sinks',      currentSinks,                                   'sink',       null);
  fillSbSinkSel(currentSinks);
}

function onState(state) {
  if (!settingsApplied) {
    if (hasServerSettings(state.settings)) {
      applyServerSettings(state.settings);
    }
    settingsApplied = true;
    // Push current settings to server (migration from localStorage, or keep server in sync)
    sendSettings();
  }
  lastState     = state;
  sourceRoutes  = state.sourceRoutes || {};
  applyState(state);
  renderSoundboard(state.sounds);
  // Refresh settings modal only if open and user isn't typing inside it
  const overlay = document.getElementById('settings-overlay');
  if (!overlay.classList.contains('hidden') && !overlay.contains(document.activeElement)) {
    openSettings();
  }
}

// ── Vertical resize (inside media panel) ────────────────────────────────────

function initVResize(handle, topEl) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = topEl.offsetHeight;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    function onMove(ev) {
      const newH = Math.max(80, Math.min(h0 + ev.clientY - y0,
                            topEl.parentElement.offsetHeight - 80));
      topEl.style.height = newH + 'px';
      topEl.style.flexShrink = '0';
    }
    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup',   onUp);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      localStorage.setItem('pw-media-top-h', topEl.style.height);
      schedSendSettings();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',   onUp);
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────

// Media panel toggle
applyMediaVisibility();
document.getElementById('toggle-media').addEventListener('click', () => {
  mediaVisible = !mediaVisible;
  localStorage.setItem('pw-media-visible', mediaVisible);
  applyMediaVisibility();
  schedSendSettings();
});

// Zoom
applyZoom();
document.getElementById('zoom-in') .addEventListener('click', () => adjustZoom(+ZOOM_STEP));
document.getElementById('zoom-out').addEventListener('click', () => adjustZoom(-ZOOM_STEP));

// Panel resize handles
initResize(document.getElementById('rh-left'),  document.getElementById('panel-inputs'),  true);
initResize(document.getElementById('rh-right'), document.getElementById('panel-outputs'), false);
initResize(document.getElementById('rh-media'), document.getElementById('panel-media'),   false);

// Restore saved panel widths
['panel-inputs', 'panel-outputs', 'panel-media'].forEach(id => {
  const w = localStorage.getItem('pw-panel-' + id);
  if (w) { const p = document.getElementById(id); p.style.width = w; p.style.flexShrink = '0'; }
});

// Vertical resize inside media panel
initVResize(document.getElementById('rh-media-v'), document.getElementById('media-top'));
const savedMTH = localStorage.getItem('pw-media-top-h');
if (savedMTH) {
  const el = document.getElementById('media-top');
  el.style.height = savedMTH; el.style.flexShrink = '0';
}

// Settings
document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', () =>
  document.getElementById('settings-overlay').classList.add('hidden'));
document.getElementById('settings-overlay').addEventListener('click', e => {
  if (e.target.id === 'settings-overlay')
    document.getElementById('settings-overlay').classList.add('hidden');
});

// Media controls — always target the currently displayed player by name
document.getElementById('mc-prev').addEventListener('click', () => send({ type: 'media_cmd', action: 'previous',   player: currentMediaPlayer }));
document.getElementById('mc-play').addEventListener('click', () => send({ type: 'media_cmd', action: 'play-pause', player: currentMediaPlayer }));
document.getElementById('mc-next').addEventListener('click', () => send({ type: 'media_cmd', action: 'next',       player: currentMediaPlayer }));

// Soundboard stop / rescan
document.getElementById('sb-stop').addEventListener('click', () => {
  document.querySelectorAll('.sb-btn.active').forEach(b => b.classList.remove('active'));
  send({ type: 'stop_sounds' });
});
document.getElementById('sb-rescan').addEventListener('click', () => send({ type: 'rescan_sounds' }));

// Connect
connect();
