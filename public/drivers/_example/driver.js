// A minimal driver to copy (folders starting with "_" are not loaded by the app).
// It measures the average brightness of each frame and shows it in the info bar and the panel.
// Copy the folder to public/drivers/<your-id>/, change `id` to match, and point a profile at it:
//   "driver": { "id": "<your-id>", "options": { "every": 5 } }
export default {
  apiVersion: 1,
  id: 'example', // must equal the folder name once copied
  name: 'Example driver',
  description: 'Shows the average brightness of the image.',

  validateOptions(options) {
    const errors = [];
    for (const key of Object.keys(options)) if (key !== 'every') errors.push(`unknown option "${key}"`);
    if ('every' in options && !(Number.isInteger(options.every) && options.every > 0)) errors.push('every must be a positive whole number');
    return errors;
  },

  create(ctx) {
    const every = ctx.options.every ?? 5; // measure every n-th frame
    const prefs = ctx.prefs.get({ showInBar: true });
    const canvas = Object.assign(document.createElement('canvas'), { width: 32, height: 24 });
    const g = canvas.getContext('2d', { willReadFrequently: true });
    let count = 0;
    let brightness = null;

    ctx.panel.innerHTML = `
      <h3>Example driver</h3>
      <p class="muted small" data-ref="value">Waiting for a frame…</p>
      <label class="check"><input type="checkbox" data-ref="bar"><span>Show in the info bar</span></label>`;
    const value = ctx.panel.querySelector('[data-ref="value"]');
    const bar = ctx.panel.querySelector('[data-ref="bar"]');
    bar.checked = prefs.showInBar;
    bar.addEventListener('change', () => {
      prefs.showInBar = bar.checked;
      ctx.prefs.set(prefs);
      ctx.refresh();
    });

    return {
      processFrame(video) {
        if (count++ % every === 0) {
          g.drawImage(video, 0, 0, canvas.width, canvas.height);
          const px = g.getImageData(0, 0, canvas.width, canvas.height).data;
          let sum = 0;
          for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          brightness = Math.round((sum / (px.length / 4) / 255) * 100);
        }
        return null; // show the video unchanged
      },
      layout() {
        if (brightness != null) value.textContent = `Average brightness: ${brightness} %`;
      },
      hud() {
        return prefs.showInBar && brightness != null ? `☀ ${brightness} %` : '';
      },
    };
  },
};
