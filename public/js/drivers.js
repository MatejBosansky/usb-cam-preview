// Camera drivers live in public/drivers/<id>/, one folder each; see public/drivers/README.md.
// A driver handles a camera type that needs code, not just a profile (e.g. decoding the
// temperatures of a thermal camera). The host below gives it a small, stable set of services.
import { validateDriver, PLUGIN_API } from './plugin-validate.js';

/** Loads every driver listed in drivers/index.json. Broken drivers are skipped with a warning. */
export async function loadDrivers() {
  const drivers = new Map();
  let ids = [];
  try {
    const res = await fetch(new URL('../drivers/index.json', import.meta.url), { cache: 'no-cache' });
    if (res.ok) ids = (await res.json()).drivers || [];
  } catch (e) {
    console.warn('Could not load the driver list', e);
  }
  await Promise.all(ids.map(async (id) => {
    try {
      const driver = (await import(new URL(`../drivers/${id}/driver.js`, import.meta.url))).default;
      const errors = validateDriver(driver, id);
      if (errors.length) console.warn(`Skipping driver "${id}":`, errors);
      else drivers.set(id, driver);
    } catch (e) {
      console.warn(`Could not load driver "${id}"`, e);
    }
  }));
  return drivers;
}

const prefsKey = (id) => `usbcam.driver.${id}`;
function readPrefs(id) {
  try { return JSON.parse(localStorage.getItem(prefsKey(id))) || {}; } catch { return {}; }
}
function writePrefs(id, values) {
  try { localStorage.setItem(prefsKey(id), JSON.stringify(values)); } catch { /* private mode */ }
}

export class DriverHost {
  /**
   * elements: { panel, frameLayer, viewerLayer } the driver may fill while it is active.
   * services: functions the app provides (see the ctx built in attach()).
   */
  constructor(elements, services) {
    this.el = elements;
    this.services = services;
    this.driver = null;
    this.instance = null;
    this.busy = false;
    this.styles = [];
  }

  /**
   * Starts the driver named in profile.driver, stopping the previous one.
   * Returns '' on success (or when the profile needs no driver), 'missing' or 'failed'.
   */
  attach(profile, drivers) {
    this.detach();
    const ref = profile?.driver;
    if (!ref) return '';
    const driver = drivers.get(ref.id);
    if (!driver) return 'missing';
    for (const file of driver.styles || []) {
      const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL(`../drivers/${driver.id}/${file}`, import.meta.url).href });
      document.head.append(link);
      this.styles.push(link);
    }
    const ctx = {
      apiVersion: PLUGIN_API,
      profile,
      options: ref.options || {},
      panel: this.el.panel,
      frameLayer: this.el.frameLayer,
      viewerLayer: this.el.viewerLayer,
      prefs: {
        get: (defaults = {}) => ({ ...defaults, ...readPrefs(driver.id) }),
        set: (values) => writePrefs(driver.id, values),
      },
      ...this.services,
    };
    try {
      this.instance = driver.create(ctx) || {};
      this.driver = driver;
    } catch (e) {
      console.error(`Driver "${driver.id}" failed to start`, e);
      this.detach();
      return 'failed';
    }
    this.el.panel.hidden = this.el.panel.childElementCount === 0;
    return '';
  }

  detach() {
    if (this.instance) this.call('destroy');
    this.driver = null;
    this.instance = null;
    this.busy = false;
    this.el.panel.replaceChildren();
    this.el.panel.hidden = true;
    this.el.frameLayer.replaceChildren();
    this.el.viewerLayer.replaceChildren();
    for (const link of this.styles) link.remove();
    this.styles = [];
  }

  get processesFrames() {
    return typeof this.instance?.processFrame === 'function';
  }

  /**
   * Hands the current video frame to the driver. onImage receives what to show (an ImageData or
   * canvas, or null for the video itself). Frames that arrive while the driver is busy are dropped.
   */
  process(video, onImage) {
    if (this.busy) return;
    const instance = this.instance;
    this.busy = true;
    Promise.resolve()
      .then(() => instance.processFrame(video))
      .then((image) => { if (this.instance === instance) onImage(image ?? null); })
      .catch((e) => {
        console.error(`Driver "${this.driver?.id}" could not process a frame`, e);
        if (this.instance === instance) onImage(null);
      })
      .finally(() => { if (this.instance === instance) this.busy = false; });
  }

  /** Calls an optional instance method; a driver error never breaks the app. */
  call(name, ...args) {
    const fn = this.instance?.[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(this.instance, args);
    } catch (e) {
      console.error(`Driver "${this.driver?.id}" failed in ${name}()`, e);
      return undefined;
    }
  }
}
