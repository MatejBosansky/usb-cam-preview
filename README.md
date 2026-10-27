# USB Cam Preview

**Live: https://usbcam.bosansky.com**

A webcam, USB microscope and USB endoscope viewer that runs entirely in your browser.
Nothing is installed and nothing is uploaded.

- Live view from any UVC camera, with resolution choice and hardware controls where the browser exposes them
- Filters from a menu: black & white, sepia, negative, two-tone, false color, edge detection, plus
  brightness, contrast, saturation, gamma and hue
- Rotate, mirror, zoom and pan, crosshair and grid overlays, freeze frame
- Photos (PNG/JPEG) and video (MP4 in Chrome/Edge/Safari, WebM in Firefox), optionally saved
  straight into a folder (Chrome/Edge)
- Camera profiles: cameras are recognised by USB ID and opened with settings that suit them
- Thermal cameras (InfiRay family: TOOLTOP T256, Topdon TC001, InfiRay P2 Pro): palettes, automatic
  or fixed color range, temperatures (center, hottest and coldest point, under the pointer, CSV
  export) and photos with the temperatures and a legend drawn in, in Chrome, Edge and Firefox.
  Cameras without their own profile can use the camera type "Generic thermal camera (InfiRay format)"
- Compatibility test: measures what the connected camera really delivers and shows which
  profiles fit it, then produces a report for adding the camera to the project

Keyboard: `Space` photo, `R` record, `F` freeze. Mouse wheel zooms, drag pans, double-click resets.

## Run locally

```
npm run dev
```

Open http://localhost:8080. Requires Node 18+, nothing to install.

## Browser support

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Live view, filters, photos | yes | yes | yes |
| Video recording | MP4 | WebM | MP4 |
| Cameras recognised automatically (USB ID) | yes | no: pick the camera type by hand | no: pick the camera type by hand |
| Native vs scaled resolutions in the test | yes | no | no |
| Thermal camera temperatures | yes | yes (camera type picked by hand) | not tested with a real camera |
| Hardware controls (exposure, focus, …) | if the camera offers them | no | no |
| Save straight to a folder | yes | no (download) | no (download) |

Tested on macOS 26 with an endoscope, a USB microscope, a thermal camera and a Logitech webcam:
Chrome 155 and Firefox 156 with the real cameras; Safari 26 only with its built-in test cameras
(Safari's automation replaces real cameras with mock ones), so real cameras in Safari still need a
manual check. On macOS, Chrome exposed no hardware controls for any of the USB cameras.

macOS asks once per browser whether it may use the camera (System Settings → Privacy & Security →
Camera); until that is allowed, the camera opens but sends no image, and the app says so.

**Phones.** On Android (Chrome 155, Galaxy S23, Android 16) the phone's own cameras work,
including hardware controls (exposure, white balance, focus, ISO, zoom); big pictures are recorded
as video at up to 1920×1080. USB cameras plugged into that phone through a hub showed up on its
USB bus but Android did not offer them to apps (no external-camera support on that model); Chrome,
Samsung Internet and Firefox all listed only the four built-in cameras, also with a camera plugged
straight into the phone. Every Android browser takes cameras from Android, so whether USB cameras
work depends on the phone (Google lists USB camera support for Pixel 6 and later). When a USB
camera is plugged in, Android may ask which app should open it: browsers are never on that list,
and the choice does not affect them. iPhone cannot use USB cameras at all;
the layout was checked in Safari on an iPhone simulator. iPad with USB-C and iPadOS 17+ may work
but is untested.

WiFi endoscopes that need a phone app do not work: they are not USB video devices.

If a USB camera does not show up at all, try a USB hub (ideally powered): some cheap cameras fail
to connect straight to a laptop's port. A camera's profile says so when this is known.

## Deploy to Cloudflare Pages

Connect the repository and use:

- Build command: `npm run build` (validates everything and writes the generated lists of cameras,
  drivers and filters)
- Build output directory: `public`

The live site, https://usbcam.bosansky.com, is a Cloudflare Pages project built this way from the
`main` branch, with `usbcam.bosansky.com` as its custom domain.

`public/_headers` sets a camera-only permissions policy.

## Extending

Everything camera- or filter-specific lives outside the core, one file or folder each:

| | |
|---|---|
| `public/cameras/<id>.json` | one camera model (a profile) |
| `public/drivers/<id>/` | one camera type that needs code, e.g. thermal cameras ([guide](public/drivers/README.md)) |
| `public/filters/<id>.js` | one image filter ([guide](public/filters/README.md)) |

The app finds them on its own; `npm run check` validates them and `npm test` runs their tests.

## Supported cameras

See `public/cameras/`. To add yours, see [CONTRIBUTING.md](CONTRIBUTING.md); AI agents follow [AGENTS.md](AGENTS.md).
