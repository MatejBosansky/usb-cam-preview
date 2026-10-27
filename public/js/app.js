import { APP_NAME, APP_VERSION, REPO_URL } from './config.js';
import { t, applyI18n } from './i18n.js';
import { phoneType, listCameras, hasCameraPermission, requestPermission, constraintsFor, deviceKey, isLikelyExternal, usbText, errorKey } from './devices.js';
import { loadProfiles, bestProfile, identify, evaluateAll, saveLocalProfile, removeLocalProfile, readLocalProfiles } from './profiles.js';
import { validateProfile, KINDS } from './profile-validate.js';
import { Renderer, DEFAULT_ADJUST, uvMatrix } from './renderer.js';
import { loadFilters, formatParam } from './filters.js';
import { loadDrivers, DriverHost } from './drivers.js';
import { Gallery, Recorder, folder, canvasToBlob, stampName, pickRecorderType, downloadBlob, formatBytes } from './capture.js';
import { probeDevice, buildReport, guessKind, CANDIDATE_MODES } from './probe.js';

// ---------- elements, storage, state ----------

const E = {};
for (const node of document.querySelectorAll('[id]')) E[node.id] = node;

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`usbcam.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`usbcam.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const prefs = { photoFormat: 'image/png', applyToCaptures: true, lastDeviceKey: null, github: '', tab: 'image', ...store.get('prefs', {}) };
const savePrefs = () => store.set('prefs', prefs);

const state = {
  profiles: [],
  devices: [],
  dev: null,
  stream: null,
  track: null,
  profile: null,
  autoProfile: null,
  devPrefs: {},
  params: Object.fromEntries(Object.keys(DEFAULT_ADJUST).map((k) => [k, store.get('image', {})[k] ?? DEFAULT_ADJUST[k]])), // brightness, contrast, …
  filters: [], // public/filters/
  filterId: store.get('filter', ''),
  filterValues: store.get('filterValues', {}), // { [filterId]: { [paramId]: value } }
  drivers: new Map(), // public/drivers/
  overlay: 'none',
  frozen: false,
  probe: null,
  evaluations: null,
  button: null,
  recorder: null,
  initialControls: {},
  busy: false,
  detecting: false,
  kindTouched: false,
  reportName: null,
  lastSource: null,
};

let renderer = null;
let rawRenderer = null;
const gallery = new Gallery(renderGallery);

// Services a camera driver may use (public/drivers/README.md documents them).
const driverHost = new DriverHost(
  { panel: E.driverPanel, frameLayer: E.frameLayer, viewerLayer: E.viewerLayer },
  {
    isFrozen: () => state.frozen,
    show: (image) => showSource(image),
    refresh: () => refreshDriverView(),
    frameSize: () => ({ width: E.frame.clientWidth, height: E.frame.clientHeight }),
    sourceToFrame,
    frameToSource,
    saveFile: async (blob, name) => {
      if (folder.handle) await folder.write(name, blob);
      else downloadBlob(blob, name);
    },
    fileName: stampName,
    toast: (message) => toast(message),
  },
);

const SLIDERS = [
  { key: 'brightness', min: -0.5, max: 0.5, step: 0.01, fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}` },
  { key: 'contrast', min: 0, max: 3, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %` },
  { key: 'saturation', min: 0, max: 3, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %` },
  { key: 'gamma', min: 0.3, max: 3, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'hue', min: -180, max: 180, step: 1, fmt: (v) => `${Math.round(v)}°` },
];

const MODE_CONTROLS = ['exposureMode', 'whiteBalanceMode', 'focusMode'];
const NUMERIC_CONTROLS = ['brightness', 'contrast', 'saturation', 'sharpness', 'exposureCompensation', 'exposureTime', 'colorTemperature', 'iso', 'focusDistance', 'zoom'];
const MANUAL_MODE_FOR = { exposureTime: 'exposureMode', colorTemperature: 'whiteBalanceMode', focusDistance: 'focusMode' };

// ---------- startup ----------

init();

async function init() {
  applyI18n();
  try {
    renderer = new Renderer(E.view);
  } catch (e) {
    console.error(e);
    showEmptyError(t('err_webgl'));
    E.startBtn.disabled = true;
    return;
  }
  renderer.params = state.params;
  buildImageControls();
  bindUi();
  startRenderLoop();
  new ResizeObserver(fitFrame).observe(E.viewer);
  selectTab(prefs.tab);

  E.photoFormat.value = prefs.photoFormat;
  E.applyToCaptures.checked = prefs.applyToCaptures;
  E.githubInput.value = prefs.github || '';
  E.repoLink.href = REPO_URL;
  renderFolderStatus();
  renderAgentPrompt();
  renderGallery();
  showBuildInfo();
  showPhoneNotice();

  [state.profiles, state.filters, state.drivers] = await Promise.all([loadProfiles(), loadFilters(), loadDrivers()]);
  buildFilterControls();
  renderKindSelect();
  renderLocalList();

  if (!window.isSecureContext) return showEmptyError(t('err_insecure'));
  if (!navigator.mediaDevices?.getUserMedia) return showEmptyError(t('err_unsupported'));
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (await hasCameraPermission().catch(() => false)) start();
}

async function start() {
  E.startBtn.disabled = true;
  hideEmptyError();
  try {
    if (!(await hasCameraPermission())) await requestPermission();
    await refreshDevices();
    const dev = state.devices.find((d) => deviceKey(d) === prefs.lastDeviceKey) || state.devices.find(isLikelyExternal) || state.devices[0];
    if (!dev) throw Object.assign(new Error('No camera'), { name: 'NotFoundError' });
    await openDevice(dev);
  } catch (err) {
    showError(err);
  } finally {
    E.startBtn.disabled = false;
  }
}

// ---------- devices and streams ----------

async function refreshDevices() {
  state.devices = await listCameras();
  E.deviceSelect.replaceChildren(...state.devices.map((d) => new Option(d.usb ? `${d.base} (${usbText(d.usb)})` : d.base, d.deviceId)));
  E.deviceSelect.disabled = state.devices.length === 0;
  if (state.dev) E.deviceSelect.value = state.dev.deviceId;
}

function resolveProfile() {
  state.autoProfile = bestProfile(state.profiles, state.dev);
  const manual = state.devPrefs.profileId && state.profiles.find((p) => p.id === state.devPrefs.profileId);
  state.profile = manual || state.autoProfile;
}

/** plain: ignore the saved and the profile's resolution (used after a mode turned out to deliver nothing). */
async function openDevice(dev, { plain = false } = {}) {
  if (state.recorder) await stopRecording();
  stopStream();
  state.dev = dev;
  E.deviceSelect.value = dev.deviceId;
  const key = deviceKey(dev);
  prefs.lastDeviceKey = key;
  savePrefs();
  state.devPrefs = store.get(`device.${key}`, {});
  if (state.probe && state.probe.key !== key) {
    state.probe = null;
    state.evaluations = null;
    E.testStatus.textContent = '';
  }
  resolveProfile();
  if (!state.kindTouched) E.kindSelect.value = defaultKind();

  const view = state.profile.view || {};
  renderer.view = {
    rotate: state.devPrefs.rotate ?? view.rotate ?? 0,
    mirror: state.devPrefs.mirror ?? view.mirror ?? false,
    zoom: 1,
    panX: 0,
    panY: 0,
  };
  state.overlay = state.devPrefs.overlay ?? view.overlay ?? 'none';
  const driverProblem = driverHost.attach(state.profile, state.drivers);
  if (driverProblem) toast(t(driverProblem === 'missing' ? 'driverMissing' : 'driverFailed', { id: state.profile.driver.id }), 8000);
  E.imageHeading.hidden = E.driverPanel.hidden;

  const mode = plain ? null : state.devPrefs.mode || state.profile.defaultMode || null;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraintsFor(dev.deviceId, mode));
  } catch (err) {
    if (err.name !== 'OverconstrainedError' || !mode) throw err;
    stream = await navigator.mediaDevices.getUserMedia(constraintsFor(dev.deviceId, null));
  }
  if (state.dev !== dev) {
    // Another camera was chosen while this one was opening.
    stream.getTracks().forEach((tr) => tr.stop());
    return;
  }
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  state.track.addEventListener('ended', onTrackEnded);
  E.video.srcObject = stream;
  // play() only resolves once frames arrive; don't block on it.
  E.video.play().catch(() => {});
  watchForFrames(stream, dev, mode);
  await applyProfileControls();
  state.initialControls = snapshotControls();

  E.emptyState.hidden = true;
  E.frame.hidden = false;
  E.hud.hidden = false;
  setCaptureEnabled(true);
  renderAll();
}

/** A camera can open fine and still send nothing, e.g. when the OS has not given the browser camera access. */
function watchForFrames(stream, dev, mode) {
  setTimeout(() => {
    if (state.stream !== stream || E.video.readyState >= 2) return;
    // Some cameras accept a requested mode and then send nothing (a Galaxy S23 back camera at
    // 640×480/25 fps): try once more without it before giving up.
    if (mode) {
      openDevice(dev, { plain: true }).catch(showError);
      return;
    }
    const mac = /Macintosh/.test(navigator.userAgent) && !('ontouchend' in document);
    let message = t(mac ? 'err_noFramesMac' : 'err_noFrames');
    if (state.devPrefs.profileId) message += ` ${t('noFramesManual')}`;
    toast(message, 10000);
  }, 5000);
}

function stopStream() {
  if (state.stream) {
    for (const tr of state.stream.getTracks()) {
      tr.removeEventListener('ended', onTrackEnded);
      tr.stop();
    }
  }
  state.stream = null;
  state.track = null;
  E.video.srcObject = null;
}

/**
 * Releases the camera while the page is hidden (another tab or app) and takes it back when it is
 * shown again. On phones a hidden tab would otherwise keep the camera busy for every other app and
 * tab. A running recording keeps the camera.
 */
function onVisibilityChange() {
  if (document.hidden) {
    if (!state.stream || state.recorder || state.busy) return;
    state.pausedWhileHidden = state.dev;
    stopStream();
  } else if (state.pausedWhileHidden) {
    const dev = state.pausedWhileHidden;
    state.pausedWhileHidden = null;
    if (state.dev === dev) openDevice(dev).catch(showError);
  }
}

function onTrackEnded() {
  toast(t('deviceGone'));
  if (state.recorder) stopRecording();
  stopStream();
  driverHost.detach();
  E.imageHeading.hidden = true;
  state.dev = null;
  setCaptureEnabled(false);
  E.frame.hidden = true;
  E.hud.hidden = true;
  E.emptyState.hidden = false;
  refreshDevices().catch(() => {});
  renderAll();
}

async function onDeviceChange() {
  if (!(await hasCameraPermission().catch(() => false))) return;
  const before = new Set(state.devices.map((d) => d.deviceId));
  await refreshDevices();
  if (state.dev && !state.devices.some((d) => d.deviceId === state.dev.deviceId)) {
    onTrackEnded();
    return;
  }
  const added = state.devices.find((d) => !before.has(d.deviceId));
  if (!added || state.recorder || state.busy) return;
  // A newly plugged-in USB camera takes over from a built-in one; it is why the app is open.
  if (!state.dev || (isLikelyExternal(added) && !isLikelyExternal(state.dev))) openDevice(added).catch(showError);
}

function saveDevPref(patch) {
  state.devPrefs = { ...state.devPrefs, ...patch };
  for (const [k, v] of Object.entries(state.devPrefs)) if (v === undefined) delete state.devPrefs[k];
  store.set(`device.${deviceKey(state.dev)}`, state.devPrefs);
}

/** Switches the camera type for the current device; null goes back to automatic detection. */
function chooseProfile(id) {
  if (!state.dev) return;
  saveDevPref({ profileId: id && id !== state.autoProfile?.id ? id : undefined, mode: undefined, rotate: undefined, mirror: undefined, overlay: undefined });
  openDevice(state.dev).catch(showError);
}

// ---------- rendering ----------

let lastVideoFrame = 0;
let frames = 0;
let fpsSince = 0;
let measuredFps = 0;
let needsDraw = false;
let fittedSize = '';

function onVideoFrame() {
  if (state.frozen) return;
  if (!driverHost.processesFrames) return showSource(E.video);
  driverHost.process(E.video, (image) => {
    if (state.frozen) return;
    showSource(image || E.video);
    refreshDriverView();
  });
}

/** Puts a frame (the video, or an image a driver made from it) on screen and into an unfiltered recording. */
function showSource(source) {
  if (!renderer.upload(source)) return;
  state.lastSource = source;
  renderer.draw();
  if (state.recorder?.raw) {
    rawRenderer.view = renderer.view;
    rawRenderer.upload(source);
    rawRenderer.draw({ neutral: true });
  }
  state.recorder?.frame();
  checkFrameSize();
}

/** Lets the driver redraw its marks and refreshes the info bar (new frame, or the view changed). */
function refreshDriverView() {
  driverHost.call('layout');
  updateHud();
}

function startRenderLoop() {
  const video = E.video;
  if ('requestVideoFrameCallback' in video) {
    const onFrame = (now) => {
      lastVideoFrame = now;
      frames++;
      if (now - fpsSince >= 1000) {
        measuredFps = (frames * 1000) / (now - fpsSince);
        frames = 0;
        fpsSince = now;
        updateHud();
      }
      onVideoFrame();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }
  const tick = (now) => {
    const fallback = now - lastVideoFrame > 250 && state.stream && video.readyState >= 2 && !state.frozen;
    if (fallback) onVideoFrame();
    else if (needsDraw && renderer.hasFrame) {
      renderer.draw();
      state.recorder?.frame();
      checkFrameSize();
      driverHost.call('layout');
    }
    needsDraw = false;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const requestDraw = () => { needsDraw = true; };

function checkFrameSize() {
  if (`${E.view.width}x${E.view.height}` !== fittedSize) {
    fitFrame();
    updateHud();
  }
}

function fitFrame() {
  const cw = E.view.width, ch = E.view.height;
  if (!cw || !ch) return;
  const scale = Math.min(E.viewer.clientWidth / cw, E.viewer.clientHeight / ch);
  const w = Math.max(1, Math.floor(cw * scale));
  const h = Math.max(1, Math.floor(ch * scale));
  E.frame.style.width = `${w}px`;
  E.frame.style.height = `${h}px`;
  fittedSize = `${cw}x${ch}`;
  renderOverlay(w, h);
  driverHost.call('layout');
}

function renderOverlay(w = E.frame.clientWidth, h = E.frame.clientHeight) {
  const svg = E.overlay;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const cx = w / 2, cy = h / 2;
  let shapes = '';
  if (state.overlay === 'crosshair') {
    const r = Math.min(w, h) * 0.08;
    shapes = `<line x1="${cx}" y1="0" x2="${cx}" y2="${h}"/><line x1="0" y1="${cy}" x2="${w}" y2="${cy}"/><circle cx="${cx}" cy="${cy}" r="${r}"/>`;
  } else if (state.overlay === 'grid') {
    const step = Math.min(w, h) / 10;
    for (let x = cx % step; x < w; x += step) shapes += `<line x1="${x}" y1="0" x2="${x}" y2="${h}"/>`;
    for (let y = cy % step; y < h; y += step) shapes += `<line x1="0" y1="${y}" x2="${w}" y2="${y}"/>`;
  }
  svg.innerHTML = shapes;
  E.overlaySelect.value = state.overlay;
}

function updateHud() {
  if (!state.track) {
    E.hudInfo.textContent = '';
    return;
  }
  const s = state.track.getSettings();
  const fps = performance.now() - lastVideoFrame < 1500 ? measuredFps : s.frameRate;
  const parts = [`${renderer.srcW || s.width}×${renderer.srcH || s.height}`];
  if (fps) parts.push(`${Math.round(fps)} fps`);
  if (renderer.view.zoom > 1) parts.push(`${renderer.view.zoom.toFixed(1)}×`);
  E.hudInfo.textContent = parts.join(' · ');
  const extra = driverHost.call('hud') || '';
  E.hudDriver.hidden = !extra;
  E.hudDriver.textContent = extra;
}

// ---------- view: rotate, mirror, zoom, pan, freeze ----------

function rotate(delta) {
  const r = (((renderer.view.rotate + delta) % 360) + 360) % 360;
  Object.assign(renderer.view, { rotate: r, panX: 0, panY: 0 });
  if (state.dev) saveDevPref({ rotate: r });
  requestDraw();
}

function toggleMirror() {
  renderer.view.mirror = !renderer.view.mirror;
  if (state.dev) saveDevPref({ mirror: renderer.view.mirror });
  syncViewButtons();
  requestDraw();
}

function clampPan() {
  const v = renderer.view;
  const lim = 0.5 - 0.5 / v.zoom;
  v.panX = Math.min(lim, Math.max(-lim, v.panX));
  v.panY = Math.min(lim, Math.max(-lim, v.panY));
}

/** Zooms; with an anchor (centred, normalised frame coordinates) the point under the pointer stays put. */
function setZoom(zoom, anchor = null) {
  const v = renderer.view;
  const next = Math.min(8, Math.max(1, zoom));
  if (anchor) {
    const m = uvMatrix({ ...v, zoom: 1 });
    const k = 1 / v.zoom - 1 / next;
    v.panX += (m.a * anchor.x + m.b * anchor.y) * k;
    v.panY += (m.c * anchor.x + m.d * anchor.y) * k;
  }
  v.zoom = next;
  clampPan();
  syncViewButtons();
  updateHud();
  requestDraw();
}

function toggleFreeze() {
  state.frozen = !state.frozen;
  syncViewButtons();
  requestDraw();
}

function syncViewButtons() {
  E.mirrorBtn.setAttribute('aria-pressed', String(!!renderer.view.mirror));
  E.freezeBtn.setAttribute('aria-pressed', String(state.frozen));
  E.hudFrozen.hidden = !state.frozen;
  E.zoomRange.value = renderer.view.zoom;
  E.zoomOut.textContent = `${renderer.view.zoom.toFixed(1)}×`;
  E.frame.classList.toggle('pannable', renderer.view.zoom > 1);
}

function setOverlay(kind) {
  state.overlay = kind;
  if (state.dev) saveDevPref({ overlay: kind });
  renderOverlay();
}

function bindPanZoom() {
  const frame = E.frame;
  frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = frame.getBoundingClientRect();
    const anchor = { x: (e.clientX - rect.left) / rect.width - 0.5, y: (e.clientY - rect.top) / rect.height - 0.5 };
    setZoom(renderer.view.zoom * Math.exp(-e.deltaY * 0.0015), anchor);
  }, { passive: false });

  let drag = null;
  frame.addEventListener('pointerdown', (e) => {
    if (renderer.view.zoom <= 1) return;
    drag = { x: e.clientX, y: e.clientY };
    frame.setPointerCapture(e.pointerId);
    frame.classList.add('panning');
  });
  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const rect = frame.getBoundingClientRect();
    const dx = (e.clientX - drag.x) / rect.width;
    const dy = (e.clientY - drag.y) / rect.height;
    drag = { x: e.clientX, y: e.clientY };
    const m = uvMatrix(renderer.view);
    renderer.view.panX -= m.a * dx + m.b * dy;
    renderer.view.panY -= m.c * dx + m.d * dy;
    clampPan();
    requestDraw();
  });
  const end = () => {
    drag = null;
    frame.classList.remove('panning');
  };
  frame.addEventListener('pointerup', end);
  frame.addEventListener('pointercancel', end);
  // Drivers get the pointer position, e.g. to show the temperature under it.
  frame.addEventListener('pointermove', (e) => {
    const rect = frame.getBoundingClientRect();
    const box = E.viewer.getBoundingClientRect();
    const fx = e.clientX - rect.left, fy = e.clientY - rect.top;
    const src = frameToSource(fx, fy);
    driverHost.call('pointer', { frameX: fx, frameY: fy, sourceX: src.x, sourceY: src.y, viewerX: e.clientX - box.left, viewerY: e.clientY - box.top });
  });
  frame.addEventListener('pointerleave', () => driverHost.call('pointer', null));
  frame.addEventListener('dblclick', () => {
    Object.assign(renderer.view, { panX: 0, panY: 0 });
    setZoom(1);
  });
}

// ---------- image adjustments and filters ----------

function buildImageControls() {
  E.imageSliders.replaceChildren(...SLIDERS.map((s) => {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    wrap.dataset.key = s.key;
    wrap.innerHTML = `<span class="slider-head"><span data-i18n="${s.label || s.key}"></span><output></output></span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}">`;
    const input = wrap.querySelector('input');
    input.addEventListener('input', () => setParam(s.key, Number(input.value)));
    input.addEventListener('dblclick', () => setParam(s.key, DEFAULT_ADJUST[s.key]));
    return wrap;
  }));
  applyI18n(E.imageSliders);
  syncImageControls();
}

function setParam(key, value) {
  state.params[key] = value;
  store.set('image', state.params);
  syncImageControls();
  requestDraw();
}

function syncImageControls() {
  for (const wrap of E.imageSliders.children) {
    const s = SLIDERS.find((x) => x.key === wrap.dataset.key);
    wrap.querySelector('input').value = state.params[s.key];
    wrap.querySelector('output').textContent = s.fmt(state.params[s.key]);
  }
}

/** The Filter menu lists every filter in public/filters/. */
function buildFilterControls() {
  E.filterSelect.replaceChildren(new Option(t('filterNone'), ''), ...state.filters.map((f) => new Option(f.name, f.id)));
  selectFilter(state.filterId);
}

function selectFilter(id) {
  let filter = state.filters.find((f) => f.id === id) || null;
  try {
    renderer.setFilter(filter);
  } catch (err) {
    console.error(`Filter "${filter.id}" does not compile:`, err.message);
    toast(t('filterFailed', { name: filter.name }), 6000);
    filter = null;
    renderer.setFilter(null);
  }
  state.filterId = filter?.id || '';
  store.set('filter', state.filterId);
  E.filterSelect.value = state.filterId;
  renderer.filterValues = filterValues(filter);
  renderFilterParams(filter);
  requestDraw();
}

/** Saved slider values of a filter, falling back to its defaults. */
function filterValues(filter) {
  const saved = (filter && state.filterValues[filter.id]) || {};
  return Object.fromEntries((filter?.params || []).map((p) => [p.id, saved[p.id] ?? p.default]));
}

function setFilterValue(filter, param, value) {
  state.filterValues[filter.id] = { ...filterValues(filter), [param.id]: value };
  store.set('filterValues', state.filterValues);
  renderer.filterValues = filterValues(filter);
  requestDraw();
}

function renderFilterParams(filter) {
  E.filterDescription.textContent = filter?.description || '';
  E.filterDescription.hidden = !filter?.description;
  const values = filterValues(filter);
  E.filterParams.replaceChildren(...(filter?.params || []).map((param) => {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    wrap.innerHTML = '<span class="slider-head"><span></span><output></output></span><input type="range">';
    wrap.querySelector('.slider-head span').textContent = param.name;
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('output');
    Object.assign(input, { min: param.min, max: param.max, step: param.step });
    input.value = values[param.id];
    out.textContent = formatParam(param, values[param.id]);
    const set = (value) => {
      input.value = value;
      out.textContent = formatParam(param, value);
      setFilterValue(filter, param, value);
    };
    input.addEventListener('input', () => set(Number(input.value)));
    input.addEventListener('dblclick', () => set(param.default));
    return wrap;
  }));
}

// ---------- photos, recording, gallery ----------

function setCaptureEnabled(on) {
  E.photoBtn.disabled = !on;
  E.recBtn.disabled = !on && !state.recorder;
}

async function takePhoto() {
  if (!renderer.hasFrame || !state.stream) return;
  const type = prefs.photoFormat;
  // toBlob copies the canvas synchronously, so the unfiltered frame is never shown on screen.
  if (!prefs.applyToCaptures) renderer.draw({ neutral: true });
  // A driver may compose its own photo (e.g. with temperatures drawn in).
  const image = driverHost.call('photo', E.view) || E.view;
  const pending = canvasToBlob(image, type, 0.92);
  if (!prefs.applyToCaptures) renderer.draw();
  E.flash.classList.remove('on');
  void E.flash.offsetWidth;
  E.flash.classList.add('on');
  try {
    const blob = await pending;
    await saveCapture(blob, stampName('photo', type === 'image/jpeg' ? 'jpg' : 'png'), 'photo');
  } catch (err) {
    showError(err);
  }
}

async function saveCapture(blob, name, kind) {
  let savedToFolder = false;
  if (folder.handle) {
    try {
      await folder.write(name, blob);
      savedToFolder = true;
    } catch (err) {
      toast(t('err_generic', { msg: err.message }), 5000);
    }
  }
  gallery.add({ blob, name, kind, savedToFolder });
  toast(kind === 'photo' ? t('photoSaved') : t('videoSaved'));
}

function rawCanvas() {
  if (!rawRenderer) rawRenderer = new Renderer(document.createElement('canvas'));
  rawRenderer.view = renderer.view;
  rawRenderer.upload(state.lastSource || E.video);
  rawRenderer.draw({ neutral: true });
  return rawRenderer.canvas;
}

async function toggleRecording() {
  if (state.recorder) return stopRecording();
  if (!state.stream || !renderer.hasFrame) return;
  const type = pickRecorderType();
  if (type === null) return toast(t('recUnsupported'));
  const raw = !prefs.applyToCaptures;
  const canvas = raw ? rawCanvas() : E.view;
  const fps = Math.round(state.track.getSettings().frameRate || 30);
  const ext = (type || '').startsWith('video/mp4') ? 'mp4' : 'webm';
  const name = stampName('video', ext);
  let target = null;
  if (folder.handle) {
    try { target = await folder.open(name); } catch (err) { toast(t('err_generic', { msg: err.message }), 5000); }
  }
  try {
    const rec = new Recorder(canvas, { type, fps, target });
    rec.raw = raw;
    rec.name = target ? name : stampName('video', rec.type.startsWith('video/mp4') ? 'mp4' : 'webm');
    rec.start();
    state.recorder = rec;
  } catch (err) {
    return showError(err);
  }
  syncRecordUi();
  state.recTimer = setInterval(syncRecordUi, 500);
}

async function stopRecording() {
  const rec = state.recorder;
  if (!rec) return;
  state.recorder = null;
  clearInterval(state.recTimer);
  syncRecordUi();
  try {
    const { blob, savedToFolder } = await rec.stop();
    if (!blob.size) return toast(t('recEmpty'), 8000);
    gallery.add({ blob, name: rec.name, kind: 'video', savedToFolder });
    toast(t('videoSaved'));
  } catch (err) {
    showError(err);
  }
}

function syncRecordUi() {
  const rec = state.recorder;
  E.recBtn.classList.toggle('recording', !!rec);
  E.recBtn.dataset.i18nTitle = rec ? 'stopRecording' : 'record';
  applyI18n(E.recBtn.parentElement);
  E.recBtn.disabled = !rec && !state.stream;
  E.hudRec.hidden = !rec;
  if (rec) {
    const s = Math.floor(rec.elapsed / 1000);
    E.hudRec.textContent = `● REC ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  E.runTestBtn.disabled = !state.dev || state.busy || !!rec;
}

function renderGallery() {
  const items = gallery.items;
  E.galleryCount.hidden = items.length === 0;
  E.galleryCount.textContent = items.length;
  E.galleryEmpty.hidden = items.length > 0;
  E.downloadAllBtn.hidden = items.length < 2;
  E.galleryList.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    let media;
    if (item.kind === 'video') {
      media = Object.assign(document.createElement('video'), { src: item.url, controls: true, preload: 'metadata', muted: true, playsInline: true });
    } else {
      media = Object.assign(document.createElement('img'), { src: item.url, alt: item.name });
      media.addEventListener('click', () => window.open(item.url, '_blank'));
    }
    media.className = 'thumb';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: item.name, title: item.name });
    const info = Object.assign(document.createElement('span'), { className: 'muted small', textContent: formatBytes(item.size) + (item.savedToFolder ? ` · ${t('inFolder')}` : '') });
    meta.append(name, info);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      iconButton('i-download', t('download'), () => downloadBlob(item.blob, item.name)),
      iconButton('i-trash', t('remove'), () => gallery.remove(item.id)),
    );
    li.append(media, meta, actions);
    return li;
  }));
}

function iconButton(icon, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = `<svg><use href="#${icon}"/></svg>`;
  b.addEventListener('click', onClick);
  return b;
}

function renderFolderStatus() {
  E.folderBtn.hidden = !folder.supported;
  E.folderStatus.textContent = !folder.supported ? t('folderUnsupported') : folder.handle ? t('folderActive', { name: folder.handle.name }) : '';
}

// ---------- camera tab ----------

const modeLabel = (m) => `${m.width}×${m.height}${m.frameRate ? ` @ ${m.frameRate} fps` : ''}`;
const modeValue = (m) => `${m.width}x${m.height}@${m.frameRate || ''}`;

function modeChoices() {
  const measured = state.probe?.modes.filter((m) => m.ok && m.native !== false);
  let list;
  if (measured?.length) list = measured.map((m) => ({ width: m.width, height: m.height, ...(m.frameRate ? { frameRate: Math.round(m.frameRate) } : {}) }));
  else if (state.profile?.modes?.length) list = state.profile.modes;
  else {
    const caps = state.track?.getCapabilities?.() || {};
    const maxW = caps.width?.max || 1920, maxH = caps.height?.max || 1080;
    list = CANDIDATE_MODES.filter(([w, h]) => w <= maxW && h <= maxH && w >= 320).map(([width, height]) => ({ width, height }));
  }
  return [...list].sort((a, b) => b.width * b.height - a.width * a.height);
}

function renderCameraTab() {
  const def = state.profile?.defaultMode;
  const choices = modeChoices();
  const auto = new Option(def ? t('profileDefault', { mode: modeLabel(def) }) : t('bestAvailable'), '');
  E.modeSelect.replaceChildren(auto, ...choices.map((m) => new Option(modeLabel(m), modeValue(m))));
  E.modeSelect.value = state.devPrefs.mode ? modeValue(state.devPrefs.mode) : '';
  if (E.modeSelect.selectedIndex < 0) E.modeSelect.value = '';
  E.modeSelect.disabled = !state.track;

  const rows = [];
  if (state.dev) {
    const s = state.track?.getSettings() || {};
    rows.push(['i_camera', state.dev.base]);
    rows.push(['i_usb', state.dev.usb ? usbText(state.dev.usb) : t('notExposed')]);
    if (s.width) rows.push(['i_stream', `${s.width}×${s.height}${s.frameRate ? ` · ${Math.round(s.frameRate)} fps` : ''}${s.resizeMode ? ` · ${s.resizeMode}` : ''}`]);
    rows.push(['i_type', `${state.profile.name}${state.profile.source === 'local' ? t('localSuffix') : ''}`]);
    if (state.profile.aliases?.length) rows.push(['i_aliases', state.profile.aliases.join(', ')]);
    if (state.profile.driver) rows.push(['i_driver', state.drivers.get(state.profile.driver.id)?.name || state.profile.driver.id]);
    if (state.profile.connection?.needsHub) rows.push(['i_connection', t('hubNote', { notes: state.profile.connection.notes || '' })]);
  }
  E.streamInfo.replaceChildren(...rows.flatMap(([k, v]) => [
    Object.assign(document.createElement('dt'), { textContent: t(k) }),
    Object.assign(document.createElement('dd'), { textContent: v }),
  ]));
  E.profileNotes.hidden = !state.profile?.notes;
  E.profileNotes.textContent = state.profile?.notes || '';
  renderControls();
}

function renderControls() {
  const box = E.controls;
  box.replaceChildren();
  const track = state.track;
  if (!track) return;
  const caps = track.getCapabilities?.() || {};
  const settings = track.getSettings();
  let count = 0;

  for (const key of MODE_CONTROLS) {
    const values = caps[key];
    if (!Array.isArray(values) || values.length < 2) continue;
    const select = document.createElement('select');
    select.append(...values.map((v) => new Option(v, v)));
    select.value = settings[key] ?? values[0];
    select.addEventListener('change', () => applyControl({ [key]: select.value }));
    box.append(controlField(t(`c_${key}`), select));
    count++;
  }

  for (const key of NUMERIC_CONTROLS) {
    const c = caps[key];
    if (!c || typeof c.min !== 'number' || !(c.max > c.min)) continue;
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    wrap.innerHTML = '<span class="slider-head"><span></span><output></output></span><input type="range">';
    wrap.querySelector('.slider-head span').textContent = t(`c_${key}`);
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('output');
    Object.assign(input, { min: c.min, max: c.max, step: c.step || (c.max - c.min) / 100 });
    input.value = settings[key] ?? c.min;
    out.textContent = settings[key] ?? '';
    let timer;
    input.addEventListener('input', () => {
      out.textContent = input.value;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const patch = { [key]: Number(input.value) };
        const modeKey = MANUAL_MODE_FOR[key];
        if (modeKey && caps[modeKey]?.includes('manual')) patch[modeKey] = 'manual';
        applyControl(patch);
      }, 60);
    });
    box.append(wrap);
    count++;
  }

  if (caps.torch) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!settings.torch });
    input.addEventListener('change', () => applyControl({ torch: input.checked }));
    label.append(input, Object.assign(document.createElement('span'), { textContent: t('c_torch') }));
    box.append(label);
    count++;
  }

  if (!count) box.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: t('controlsNone') }));
  E.resetControlsBtn.hidden = !count;
}

function controlField(labelText, control) {
  const label = document.createElement('label');
  label.className = 'field block';
  label.append(Object.assign(document.createElement('span'), { textContent: labelText }), control);
  return label;
}

async function applyControl(patch) {
  const track = state.track;
  if (!track) return;
  try {
    // applyConstraints replaces all constraints, so keep the resolution ones.
    await track.applyConstraints({ ...track.getConstraints(), advanced: [patch] });
  } catch (err) {
    toast(err.message || err.name, 4000);
  }
}

async function applyProfileControls() {
  const wanted = state.profile.controls || {};
  const caps = state.track.getCapabilities?.() || {};
  for (const [key, value] of Object.entries(wanted)) {
    if (key in caps) await applyControl({ [key]: value });
  }
}

function snapshotControls() {
  const caps = state.track?.getCapabilities?.() || {};
  const settings = state.track?.getSettings() || {};
  const out = {};
  for (const key of [...MODE_CONTROLS, ...NUMERIC_CONTROLS, 'torch']) if (key in caps && key in settings) out[key] = settings[key];
  return out;
}

async function resetControls() {
  const initial = state.initialControls;
  for (const key of MODE_CONTROLS) if (key in initial) await applyControl({ [key]: initial[key] });
  for (const [key, value] of Object.entries(initial)) if (!MODE_CONTROLS.includes(key)) await applyControl({ [key]: value });
  renderControls();
}

// ---------- camera type selector ----------

/** Profile name with the other names it is sold under, e.g. "TOOLTOP T256 … · InfiRay". */
const profileLabel = (p) => (p.aliases?.length ? `${p.name} · ${p.aliases.join(' · ')}` : p.name);

function renderProfileSelect() {
  const sel = E.profileSelect;
  if (!state.dev) {
    sel.replaceChildren();
    sel.disabled = true;
    return;
  }
  const groups = { specific: document.createElement('optgroup'), generic: document.createElement('optgroup') };
  groups.specific.label = t('groupSpecific');
  groups.generic.label = t('groupGeneric');
  for (const p of state.profiles) {
    const usbMatch = identify(p, state.dev).level === 'usb';
    const option = new Option(`${profileLabel(p)}${p.source === 'local' ? t('localSuffix') : ''}${usbMatch ? ' ✓' : ''}`, p.id);
    groups[p.generic ? 'generic' : 'specific'].append(option);
  }
  sel.replaceChildren(new Option(t('autoProfile', { name: profileLabel(state.autoProfile) }), ''), ...Object.values(groups).filter((g) => g.children.length));
  sel.value = state.devPrefs.profileId || '';
  sel.title = sel.selectedOptions[0]?.text || '';
  sel.disabled = false;
}

// ---------- compatibility lab ----------

function renderLab() {
  if (state.dev && state.autoProfile) {
    const how = identify(state.autoProfile, state.dev).level;
    let text = t('detectedAs', { name: profileLabel(state.autoProfile), how: t(`id_${how}`) });
    if (state.profile !== state.autoProfile) text += ` ${t('manualOverride', { name: profileLabel(state.profile) })}`;
    if (!state.dev.usb) text += ` ${t('noUsbId')}`;
    E.detectedInfo.textContent = text;
    E.detectedInfo.hidden = false;
  } else {
    E.detectedInfo.hidden = true;
  }
  E.runTestBtn.disabled = !state.dev || state.busy || !!state.recorder;
  E.downloadReportBtn.disabled = E.copyReportBtn.disabled = !state.probe;
  renderTestResults();
}

function renderTestResults() {
  const box = E.testResults;
  box.replaceChildren();
  const probe = state.probe;
  if (!probe) return;

  const ok = probe.modes.filter((m) => m.ok && m.native !== false);
  const scaled = probe.modes.filter((m) => m.ok && m.native === false);
  const failed = probe.modes.filter((m) => !m.ok);
  const list = document.createElement('ul');
  list.className = 'list';
  for (const m of [...ok].reverse()) {
    const li = document.createElement('li');
    li.className = 'mode-row';
    const fps = m.measuredFps ? `${Math.round(m.measuredFps)} fps` : m.frameRate ? `${Math.round(m.frameRate)} fps` : '';
    li.innerHTML = '<span class="res"></span><span class="badge"></span><span class="muted small"></span>';
    li.children[0].textContent = `${m.width}×${m.height}`;
    li.children[1].textContent = m.native ? t('native') : t('unknownNative');
    li.children[1].classList.add(m.native ? 'ok' : 'dim');
    li.children[2].textContent = fps;
    list.append(li);
  }
  box.append(heading(t('resolutions')), list);
  const fmt = (arr) => arr.map((m) => `${m.width}×${m.height}`).join(', ');
  if (scaled.length) box.append(smallText(t('scaledOnly', { list: fmt(scaled) })));
  if (failed.length) box.append(smallText(t('notSupported', { list: fmt(failed) })));
  if (ok.length && ok.every((m) => m.native === null)) box.append(smallText(t('nativeUnknownHint')));

  const fits = document.createElement('ul');
  fits.className = 'list';
  for (const ev of state.evaluations || []) {
    const li = document.createElement('li');
    li.className = 'fit';
    const what = document.createElement('div');
    what.className = 'what';
    const title = document.createElement('div');
    const name = Object.assign(document.createElement('strong'), { textContent: profileLabel(ev.profile) + (ev.profile.source === 'local' ? t('localSuffix') : '') });
    const badge = Object.assign(document.createElement('span'), {
      className: `badge st-${ev.best ? 'best' : ev.status}`,
      textContent: t(ev.best ? 'st_best' : `st_${ev.status}`),
    });
    title.append(name, ' ', badge);
    const details = [t(ev.identity.level === 'none' && ev.profile.generic ? 'id_generic' : `id_${ev.identity.level}`)];
    if (ev.total) details.push(t('modesFit', { a: ev.supported, b: ev.total }));
    if (ev.controlsMissing.length) details.push(t('missingControls', { list: ev.controlsMissing.join(', ') }));
    what.append(title, smallText(details.join(' · ')));
    const inUse = state.profile?.id === ev.profile.id;
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: t(inUse ? 'inUse' : 'use'), disabled: inUse });
    button.addEventListener('click', () => chooseProfile(ev.profile.id));
    li.append(what, button);
    fits.append(li);
  }
  box.append(heading(t('libraryFit')), fits);
}

const heading = (text) => Object.assign(document.createElement('h4'), { textContent: text });
const smallText = (text) => Object.assign(document.createElement('p'), { className: 'muted small', textContent: text });

async function runTest() {
  if (!state.dev || state.busy) return;
  if (state.recorder) return toast(t('busyRecording'));
  const dev = state.dev;
  state.busy = true;
  renderLab();
  stopStream();
  setCaptureEnabled(false);
  try {
    const probe = await probeDevice(dev.deviceId, {
      extraModes: [...state.drivers.values()].flatMap((d) => d.probeModes || []),
      onProgress: ({ i, n, width, height }) => { E.testStatus.textContent = t('testing', { w: width, h: height, i, n }); },
    });
    probe.key = deviceKey(dev);
    state.probe = probe;
    state.evaluations = evaluateAll(state.profiles, dev, probe);
    E.testStatus.textContent = t('testDone');
  } catch (err) {
    console.error(err);
    E.testStatus.textContent = t('err_generic', { msg: err.message || err.name });
  } finally {
    state.busy = false;
    await openDevice(dev).catch(showError);
  }
}

function defaultKind() {
  const p = state.profile;
  if (p && !p.match.fallback) return p.kind;
  return state.dev ? guessKind(state.dev.base) : 'other';
}

function renderKindSelect() {
  const current = E.kindSelect.value;
  E.kindSelect.replaceChildren(...KINDS.map((k) => new Option(t(`k_${k}`), k)));
  E.kindSelect.value = current || defaultKind();
}

function detectButton() {
  if (state.detecting) return;
  state.detecting = true;
  E.detectBtn.disabled = true;
  const keys = [];
  let left = 10;
  let settle = 0;
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const key = e.code || e.key;
    if (!keys.includes(key)) keys.push(key);
    E.buttonStatus.textContent = t('buttonFound', { key: keys.join(', ') });
    clearTimeout(settle);
    settle = setTimeout(finish, 1200);
  };
  const tick = setInterval(() => {
    left--;
    if (left <= 0) finish();
    else if (!keys.length) E.buttonStatus.textContent = t('pressNow', { s: left });
  }, 1000);
  function finish() {
    clearInterval(tick);
    clearTimeout(settle);
    window.removeEventListener('keydown', onKey, true);
    state.detecting = false;
    E.detectBtn.disabled = false;
    state.button = keys.length ? { type: 'keyboard', keys } : { type: 'unknown' };
    E.buttonStatus.textContent = keys.length ? t('buttonFound', { key: keys.join(', ') }) : t('buttonNone');
  }
  window.addEventListener('keydown', onKey, true);
  E.buttonStatus.textContent = t('pressNow', { s: left });
}

async function currentReport() {
  return buildReport({
    dev: state.dev,
    probe: state.probe,
    kind: E.kindSelect.value,
    needsHub: E.needsHubInput.checked,
    notes: E.notesInput.value.trim(),
    github: E.githubInput.value.trim(),
    button: state.button,
    evaluations: state.evaluations,
    drivers: [...state.drivers.values()],
  });
}

async function downloadReport() {
  if (!state.probe || !state.dev) return toast(t('needTest'));
  const report = await currentReport();
  state.reportName = `camera-report-${report.draftProfile.id}.json`;
  downloadBlob(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }), state.reportName);
  renderAgentPrompt();
}

async function copyReport() {
  if (!state.probe || !state.dev) return;
  const report = await currentReport();
  await copyText(JSON.stringify(report, null, 2));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('copied'));
  } catch (err) {
    showError(err);
  }
}

function renderAgentPrompt() {
  const report = state.reportName
    ? `My camera report from the app is the file ${state.reportName} (in my Downloads folder).`
    : 'My camera report from the app is the downloaded camera-report-<id>.json file (in my Downloads folder).';
  E.agentPrompt.textContent = [
    `I want to add support for my camera to ${APP_NAME} (${REPO_URL}).`,
    '1. Clone the repository (fork it first if you cannot push to it).',
    '2. Read AGENTS.md and follow the section "Adding a camera profile".',
    `3. ${report}`,
    '4. The camera is plugged into this computer, so you can also inspect it with the OS tools listed in AGENTS.md.',
    '5. When `npm run check` passes, open a pull request.',
  ].join('\n');
  E.issueLink.href = `${REPO_URL}/issues/new?template=new-camera.yml`;
}

function renderLocalList() {
  E.localList.replaceChildren(...readLocalProfiles().map((p) => {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('span'), { textContent: `${p.name} (${p.id})` }));
    li.append(iconButton('i-trash', t('remove'), async () => {
      removeLocalProfile(p.id);
      await reloadProfiles();
    }));
    return li;
  }));
}

async function loadProfileFile(file) {
  let profile;
  try {
    profile = JSON.parse(await file.text());
  } catch (err) {
    return toast(t('invalidProfile', { errors: err.message }), 6000);
  }
  if (profile?.draftProfile) profile = profile.draftProfile; // a whole camera report
  const errors = validateProfile(profile);
  if (errors.length) return toast(t('invalidProfile', { errors: errors.join('; ') }), 8000);
  saveLocalProfile(profile);
  await reloadProfiles();
  toast(t('localLoaded', { name: profile.name }));
}

async function reloadProfiles() {
  state.profiles = await loadProfiles();
  renderLocalList();
  if (!state.dev) return renderAll();
  const before = state.profile?.id;
  resolveProfile();
  if (state.probe) state.evaluations = evaluateAll(state.profiles, state.dev, state.probe);
  if (state.profile.id !== before) await openDevice(state.dev).catch(showError);
  else renderAll();
}

// ---------- view coordinates ----------

/**
 * Position inside the displayed frame (CSS px, or a w×h target such as a photo) of a source image
 * pixel, through rotation, mirror and zoom; frameToSource is the inverse.
 */
function sourceToFrame(px, py, w = E.frame.clientWidth, h = E.frame.clientHeight) {
  const v = renderer.view;
  const m = uvMatrix(v);
  const sx = px / renderer.srcW - 0.5 - v.panX;
  const sy = py / renderer.srcH - 0.5 - v.panY;
  const det = m.a * m.d - m.b * m.c;
  return {
    x: ((m.d * sx - m.b * sy) / det + 0.5) * w,
    y: ((-m.c * sx + m.a * sy) / det + 0.5) * h,
  };
}

function frameToSource(fx, fy, w = E.frame.clientWidth, h = E.frame.clientHeight) {
  const v = renderer.view;
  const m = uvMatrix(v);
  const ox = fx / w - 0.5;
  const oy = fy / h - 0.5;
  return {
    x: (m.a * ox + m.b * oy + 0.5 + v.panX) * renderer.srcW,
    y: (m.c * ox + m.d * oy + 0.5 + v.panY) * renderer.srcH,
  };
}

// ---------- phones ----------

/** Tells phone users up front that USB cameras will most likely not work there; dismissed for good with "Got it". */
function showPhoneNotice() {
  const phone = phoneType();
  if (!phone || prefs.phoneNoticeDismissed) return;
  E.phoneNoticeText.textContent = t(phone === 'iphone' ? 'phoneNoticeIphone' : 'phoneNoticeAndroid');
  E.phoneNotice.hidden = false;
  E.phoneNoticeClose.addEventListener('click', () => {
    E.phoneNotice.hidden = true;
    prefs.phoneNoticeDismissed = true;
    savePrefs();
  }, { once: true });
}

// ---------- release info ----------

/**
 * Shows at the bottom of the page which release this is: build.json is written by `npm run build`
 * at deployment (and served live by `npm run dev`). It is fetched fresh, never from the cache.
 */
async function showBuildInfo() {
  let info = null;
  try {
    const res = await fetch('build.json', { cache: 'no-cache' });
    if (res.ok) info = await res.json();
  } catch { /* not built: show the version only */ }
  const version = info?.version || APP_VERSION;
  if (!info?.updatedAt) {
    E.buildInfo.textContent = `Version ${version}`;
    return;
  }
  const when = new Date(info.updatedAt);
  const date = when.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  E.buildInfo.textContent = t(info.source === 'dev' ? 'buildDev' : 'buildRelease', { version, date }) + (info.commit ? ` · ${info.commit}` : '');
  E.buildInfo.title = `${info.updatedAt}${info.commit ? `, commit ${info.commit}` : ''}`;
}

// ---------- UI plumbing ----------

function renderAll() {
  renderProfileSelect();
  renderCameraTab();
  renderLab();
  syncViewButtons();
  syncRecordUi();
  renderOverlay();
  updateHud();
}

function selectTab(name) {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  if (!tabs.some((tab) => tab.dataset.tab === name)) name = 'image';
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of document.querySelectorAll('.tabpanel')) panel.hidden = panel.id !== `tab-${name}`;
  prefs.tab = name;
  savePrefs();
}

function bindUi() {
  E.startBtn.addEventListener('click', start);

  E.deviceSelect.addEventListener('change', () => {
    const dev = state.devices.find((d) => d.deviceId === E.deviceSelect.value);
    if (dev) openDevice(dev).catch(showError);
  });
  E.profileSelect.addEventListener('change', () => chooseProfile(E.profileSelect.value || null));
  E.modeSelect.addEventListener('change', () => {
    const mode = modeChoices().find((m) => modeValue(m) === E.modeSelect.value);
    saveDevPref({ mode: mode || undefined });
    openDevice(state.dev).catch(showError);
  });

  E.rotLeftBtn.addEventListener('click', () => rotate(-90));
  E.rotRightBtn.addEventListener('click', () => rotate(90));
  E.mirrorBtn.addEventListener('click', toggleMirror);
  E.freezeBtn.addEventListener('click', toggleFreeze);
  E.zoomRange.addEventListener('input', () => setZoom(Number(E.zoomRange.value)));
  E.overlaySelect.addEventListener('change', () => setOverlay(E.overlaySelect.value));
  bindPanZoom();

  E.photoBtn.addEventListener('click', takePhoto);
  E.recBtn.addEventListener('click', toggleRecording);
  E.resetImageBtn.addEventListener('click', () => {
    Object.assign(state.params, DEFAULT_ADJUST);
    setParam('brightness', DEFAULT_ADJUST.brightness);
    selectFilter('');
  });
  E.filterSelect.addEventListener('change', () => selectFilter(E.filterSelect.value));
  E.applyToCaptures.addEventListener('change', () => {
    prefs.applyToCaptures = E.applyToCaptures.checked;
    savePrefs();
  });
  E.photoFormat.addEventListener('change', () => {
    prefs.photoFormat = E.photoFormat.value;
    savePrefs();
  });
  E.folderBtn.addEventListener('click', async () => {
    try {
      await folder.choose();
    } catch (err) {
      if (err.name !== 'AbortError') showError(err);
    }
    renderFolderStatus();
  });
  E.downloadAllBtn.addEventListener('click', async () => {
    for (const item of [...gallery.items].reverse()) {
      downloadBlob(item.blob, item.name);
      await new Promise((r) => setTimeout(r, 250));
    }
  });
  E.resetControlsBtn.addEventListener('click', resetControls);

  for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));

  E.runTestBtn.addEventListener('click', runTest);
  E.detectBtn.addEventListener('click', detectButton);
  E.kindSelect.addEventListener('change', () => { state.kindTouched = true; });

  E.githubInput.addEventListener('change', () => {
    prefs.github = E.githubInput.value.trim();
    savePrefs();
  });
  E.downloadReportBtn.addEventListener('click', () => downloadReport().catch(showError));
  E.copyReportBtn.addEventListener('click', () => copyReport().catch(showError));
  E.copyPromptBtn.addEventListener('click', () => copyText(E.agentPrompt.textContent));
  E.profileFile.addEventListener('change', () => {
    const file = E.profileFile.files[0];
    E.profileFile.value = '';
    if (file) loadProfileFile(file);
  });

  window.addEventListener('keydown', (e) => {
    if (state.detecting || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
    const button = state.profile?.button;
    if (button?.type === 'keyboard' && button.keys.some((k) => k === e.code || k === e.key)) {
      e.preventDefault();
      takePhoto();
    } else if (e.code === 'Space') {
      e.preventDefault();
      takePhoto();
    } else if (e.code === 'KeyR') {
      toggleRecording();
    } else if (e.code === 'KeyF') {
      toggleFreeze();
    }
  });
}

let toastTimer = 0;
function toast(message, ms = 2500) {
  E.toast.textContent = message;
  E.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { E.toast.hidden = true; }, ms);
}

function showError(err) {
  console.error(err);
  let key = errorKey(err);
  // iPhones cannot use USB cameras at all, so the USB hub advice does not apply there.
  if (key === 'err_notFound' && /iPhone|iPod/.test(navigator.userAgent)) key = 'err_notFoundIphone';
  const message = key ? t(key) : t('err_generic', { msg: err?.message || String(err) });
  if (state.stream) toast(message, 6000);
  else showEmptyError(message);
}

function showEmptyError(message) {
  E.frame.hidden = true;
  E.hud.hidden = true;
  E.emptyState.hidden = false;
  E.emptyError.textContent = message;
  E.emptyError.hidden = false;
}

function hideEmptyError() {
  E.emptyError.hidden = true;
}
