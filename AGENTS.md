# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, …) working on USB Cam Preview.
Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project is

USB Cam Preview is a static web app that shows a webcam, USB microscope or USB endoscope in the browser,
applies filters, and saves photos and videos. Everything runs client-side; there is no backend.
It is hosted as a static site (Cloudflare Pages, output directory `public/`).

## Where things go: three extension points

Each kind of addition lives in **one file or one folder**. The app finds it on its own; nothing in
`public/js/`, `index.html` or the CSS has to change, and a broken addition is skipped instead of
breaking the page.

| To add… | Create | Guide |
|---|---|---|
| a camera that works like a normal camera | one file `public/cameras/<id>.json` (a profile) | "Adding a camera profile" below |
| a camera **type** that needs code (special frame format, its own controls or readouts, e.g. thermal) | one folder `public/drivers/<id>/` + a profile with `"driver"` | `public/drivers/README.md` |
| an image filter | one file `public/filters/<id>.js` (or folder `<id>/filter.js`) | `public/filters/README.md` |

Most contributions are a profile. Write a driver only when a profile cannot express what the camera
needs. Never put code for one camera type into `public/js/`: the core stays camera-agnostic.

## Layout

```
public/                 the whole website (deployed as is)
  cameras/*.json        camera profiles (+ schema.json)
  drivers/<id>/         camera drivers; README.md = the driver API; _example/ to copy
  filters/<id>.js       filters; README.md = the filter API
  index.html, css/      UI
  faq/index.html        FAQ page; its answers are also structured data (schema.org FAQPage)
  robots.txt, sitemap.xml, llms.txt, og-image.png   for search engines, AI assistants and link previews
  js/app.js             UI wiring and state
  js/drivers.js         loads drivers and hosts the active one (the services a driver gets)
  js/filters.js         loads filters
  js/renderer.js        WebGL: colour adjustments, the selected filter, rotation, mirror, zoom
  js/devices.js         camera discovery; parses "(vid:pid)" from Chrome's camera labels
  js/profiles.js        loading profiles, matching a camera, compatibility verdicts
  js/profile-validate.js, js/plugin-validate.js   validation, shared with the Node scripts
  js/probe.js           compatibility test and the camera report / draft profile
  js/capture.js         photos, recording, gallery, saving to a folder
  js/i18n.js            UI strings of the core (drivers and filters carry their own)
scripts/serve.mjs       dev server (zero dependencies)
scripts/build.mjs       validates everything; writes the generated lists for deployment
scripts/test.mjs        runs drivers' and filters' own test.mjs files
docs/examples/          example camera reports
docs/og-image.html      source of public/og-image.png (how to regenerate it is inside)
```

`cameras/index.json`, `drivers/index.json` and `filters/index.json` are **generated** (by
`npm run dev` on the fly, by `npm run build` for deployment) and not committed. Never edit them.

## Commands

```
npm run dev       # http://localhost:8080 (camera access works on localhost without HTTPS)
npm run check     # validate all profiles, drivers and filters (CI runs this)
npm test          # run the tests in drivers' and filters' folders (CI runs this)
npm run build     # check + write the generated lists (Cloudflare Pages build command)
```

There are no dependencies. Keep it that way: vanilla ES modules, no frameworks, no npm packages.
The project is English only: code, comments, docs and UI.

## Adding a camera profile

Goal: one new file `public/cameras/<id>.json` that passes `npm run check`, built only from
measured data. Never invent resolutions, frame rates or features, and never copy them from the
box or the shop listing.

### 0. Make sure the computer sees the camera

Before anything else, check that the operating system lists the camera (commands in step 2).
If it does not show up at all, it may need a **USB hub, ideally a powered one**: some cheap
cameras (the TOOLTOP T256 thermal camera, for one) fail to connect when plugged straight into a
laptop and work fine through a hub. Typical signs that the camera is electrically there but fails
to connect:

- **macOS:** the USB-C port reports a device (`ioreg -r -d 1 -n "Port-USB-C@1" -l | grep -E 'ConnectionActive|IOAccessoryUSBConnectString'`
  shows `Yes` / `"Device"`) but nothing appears in `ioreg -p IOUSB`, and
  `/usr/bin/log show --last 5m --predicate 'process == "kernel" AND eventMessage CONTAINS "createDevice"'`
  shows `setAddress: completed with result code 4` and `persistent enumeration failures`.
- **Linux:** `dmesg` shows `device descriptor read/64, error -71` or `unable to enumerate USB device`.
- **Windows:** Device Manager shows "Unknown USB Device (Device Descriptor Request Failed)".

Then ask the human to try, in this order: a USB hub (powered if possible), a different cable or
adapter, flipping the USB-C plug, another port. If only a hub works, record it in the profile
(`connection`, step 4): the next person with this camera needs to know.

### 1. Get the camera report from the app (preferred source)

The browser is what the app uses, so its view of the camera is the one that matters.

1. Run `npm run dev`.
2. Ask the human to open http://localhost:8080 in **Chrome or Edge** (they report the USB ID and
   tell native resolutions apart from scaled ones; Firefox and Safari do not), pick the camera,
   open the **Compatibility** tab, click **Run test**, choose what the camera is, tick
   **It only works through a USB hub** if that is the case, optionally press **Detect** for a
   photo button, and click **Download report**.
3. Ask for the path of the downloaded `camera-report-<id>.json` (usually in Downloads).

If you can drive a browser that has camera access yourself, you may do these steps yourself.
On macOS, a browser started from your shell may get no frames because camera permission is
attributed to the parent app; launching Chrome with `open -na "Google Chrome" --args …` avoids that.

The report contains `device` (label, USB ID), `modes` (every tested resolution with `native`,
`frameRate` and `measuredFps`), `capabilities`, `button`, `libraryMatches` and a ready
`draftProfile`. See `docs/examples/camera-report-endoscope-0bda-5806.json`.

### 2. Cross-check with the operating system (optional, recommended)

The camera is usually plugged into the machine you run on. Use what is available:

- **macOS:** `system_profiler SPCameraDataType` (Model ID shows `VendorID_<decimal> ProductID_<decimal>`),
  `ioreg -p IOUSB -l -w 0 | grep -E '"(USB Product Name|USB Vendor Name|idVendor|idProduct)"'`,
  and with ffmpeg: `ffmpeg -f avfoundation -list_devices true -i ""` and
  `ffmpeg -f avfoundation -video_size 1x1 -i "<camera name>"` (prints the supported modes).
- **Linux:** `lsusb`, `v4l2-ctl --list-devices`, `v4l2-ctl -d /dev/videoN --list-formats-ext`,
  `v4l2-ctl -d /dev/videoN --list-ctrls`.
- **Windows (PowerShell):** `Get-PnpDevice -PresentOnly -Class Camera,Image | Format-List FriendlyName,InstanceId`
  (the InstanceId contains `VID_xxxx&PID_xxxx`), and `ffmpeg -list_options true -f dshow -i video="<camera name>"`.

USB IDs in profiles are 4 lowercase hex digits; convert decimal values (e.g. 3034 → `0bda`).
If the OS and the browser disagree, trust the browser report and mention the difference in `notes`.

Without any browser report (the human cannot run the app), you may build a profile from OS data
alone; then say so in the `tested` entry's `notes`.

### 3. Check whether the camera is already known

```
grep -ril '"<vendorId>"' public/cameras/ | xargs grep -il '"<productId>"'
```

If a profile with the same USB ID exists, do not create a second one (`npm run check` rejects
duplicates). Add a `tested` entry to the existing profile instead, and fix its `modes` or `notes`
if the new report shows something different.

### 4. Write the profile

Start from `draftProfile` in the report and save it as `public/cameras/<id>.json`. Then:

- **`id`**: kebab-case, equal to the file name. Use `<brand-or-kind>-<vendorId>-<productId>`,
  e.g. `endoscope-0bda-5806`, `dino-lite-am2111-a168-0613`.
- **`name`**: what a person would recognise; include the brand if known and the USB ID, e.g.
  `USB endoscope (Realtek 0bda:5806)`.
- **`aliases`**: other names the same camera is sold under, or the maker of the module inside it,
  e.g. `["InfiRay"]`. Cheap cameras are rebranded a lot; the app shows aliases next to the name so
  people find their camera. Only names you have evidence for (label, packaging, the human).
- **`kind`**: `webcam`, `endoscope`, `microscope`, `thermal`, `document-camera` or `other`.
- **`match.usb`**: always, when the USB ID is known. It is the reliable way to recognise a camera.
  Cheap cameras often carry the USB ID of their bridge chip's maker (Realtek `0bda`, Genesys Logic
  `05e3`, Sonix `0c45`, …), which other cameras built on the same chip share; say so in `notes`.
- **`match.labels`**: only for distinctive names. Remove it for generic names like
  "USB Camera" or "USB2.0 HD UVC WebCam", which thousands of unrelated cameras share.
- **`modes`**: only entries the report marks `"ok": true` and `"native": true`. Round `frameRate`.
- **`defaultMode`**: the largest native mode that still runs smoothly (≥ 15 fps); must be in `modes`.
- **`view`**: `mirror: true` only for selfie webcams; `overlay: "crosshair"` suits microscopes.
- **`controls`**: only keys that appear in the report's `capabilities`, and only if a default
  other than the camera's own is clearly better.
- **`button`**: from the report's `button`. `keyboard` with `keys` if detected; `none` only if the
  human confirms the camera has no button; otherwise leave it out.
- **`connection`**: `{ "needsHub": true, "notes": "…" }` when the camera only connected through a
  USB hub (step 0). Say in `notes` what failed and what worked, e.g. "MacBook Air USB-C ports:
  enumeration fails; works through a USB 2.0 hub". The app shows this to users of the camera.
  Leave the field out when a direct connection works.
- **`driver`**: only when an existing driver in `public/drivers/` handles this camera type, e.g.
  `{ "id": "infiray-thermal", "options": { "divisor": 64 } }` for InfiRay-style thermal cameras
  (TOOLTOP, Topdon TC001, InfiRay P2 Pro); until such a camera has its own profile, the generic
  type `generic-thermal` handles it at any sensor size. The draft adds it when a driver
  recognises the camera from the test (see each driver's README for its options and checks). If no
  driver fits and the camera needs code, write one (`public/drivers/README.md`); otherwise leave
  the field out.
- **`notes`**: facts a user benefits from, e.g. real vs advertised resolution, frame rate in low
  light, how the LED is controlled, warm-up time. Only what was observed or the human told you.
- **`tested`**: keep the entry from the draft (date, OS, browser, result).
- **`contributors`**: the human's GitHub username, if they want to be credited.

Remove `$schema` only if you must; keeping `"$schema": "./schema.json"` gives editors validation.

### 5. Validate

```
npm run check
```

Fix every reported problem.

### 6. Verify in the app

With `npm run dev` running, ask the human to reload the page (or reload it yourself). The
**Camera type** picker should show `Auto: <your profile name>`, and **Compatibility → Run test**
should list your profile as **Best match**. If not, fix `match` or `modes`.

### 7. Contribute

- With GitHub access: create a branch `camera/<id>`, commit the profile (only that file), push,
  and open a pull request titled `Add camera: <name>`. In the
  description include the camera name, where it was bought if known, OS and browser, whether it
  needed a USB hub, and paste the report's `modes` section. Do not commit the report file itself.
- Without GitHub access: give the human the finished profile file and ask them to open a
  "New camera" issue (`.github/ISSUE_TEMPLATE/new-camera.yml`) and attach it with the report.

### Do not

- Edit the generic profiles (`generic-*.json`) to fit one device.
- Put serial numbers, device IDs from the browser, or other personal data in a profile.
- Add a profile for a camera that does not work at all; open an issue describing the failure instead.

## Adding a driver or a filter

Follow `public/drivers/README.md` or `public/filters/README.md`. Keep everything inside the new
folder or file, run `npm run check` and `npm test`, then try it in the app with `npm run dev`
(restart it after adding a driver; new filters and profiles show up on reload). A pull request
for a new driver should also contain the profile of at least one camera that uses it.

## Changing the app itself

- Profile format changes need three edits in sync: `public/cameras/schema.json`,
  `public/js/profile-validate.js`, and this file. Old profiles must stay valid.
- The driver and filter APIs (`apiVersion: 1`) are a contract with code outside the core. Change
  them only compatibly; document every change in the two READMEs.
- `npm run dev` loads the validators once: restart it after changing them.
- The FAQ (`public/faq/index.html`), `public/llms.txt` and the description in `index.html` (meta tags,
  JSON-LD, `<noscript>`) say what the app does. Update them when a feature, a supported camera or
  browser support changes, and keep their claims to what was tested.
- Test camera features in a real browser with a real camera. `npm test` covers what drivers and
  filters test themselves; `node --check` catches syntax errors.
