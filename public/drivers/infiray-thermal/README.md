# infiray-thermal

Radiometric thermal cameras with the InfiRay frame layout: TOOLTOP T256 (tested), and by the same
layout Topdon TC001 and InfiRay P2 Pro (not tested here).

The camera sends a W×2H YUYV frame, e.g. 256×384 for a 256×192 sensor. The top half is the
camera's own 8-bit picture; the bottom half holds one little-endian uint16 per pixel:
°C = raw / divisor − 273.15.

## Profile

```json
"kind": "thermal",
"defaultMode": { "width": 256, "height": 384, "frameRate": 25 },
"driver": { "id": "infiray-thermal", "options": { "divisor": 64 } }
```

`defaultMode` must be the W×2H mode. `divisor` is 64 for every camera seen so far; if a camera's
centre temperature is implausible (room ≈ 20–25 °C), it is probably different. The compatibility
test suggests this driver for a `thermal` camera that offers both W×H and W×2H.

## What it does

Palettes (Iron, Rainbow, White hot, Black hot), automatic or fixed colour range with a legend, the
hottest and coldest point, the temperature at the centre and under the pointer, CSV export of the
temperature map, and photos with all of that drawn in.

## Files

| | |
|---|---|
| `driver.js` | driver definition and the user interface |
| `pipeline.js` | frame → colourised image and temperature map |
| `decode.js` | decoding the raw half, palettes, CSV |
| `test.mjs` | decoder test on synthetic frames from 80×60 to 640×512, and normal camera pictures that must be rejected (`npm test`) |
| `style.css` | marks, legend, pointer readout |

## How the decoding works, and its limits

Browsers hand the frame over as NV12/I420: the low byte (in Y) survives exactly, but one chroma row
carries the high bytes for two pixel rows. On macOS that row comes from the even row, so even rows
are exact and odd rows are rebuilt from their neighbours (`even-row` model). Converters that
average the two rows (libyuv, likely on Windows and Linux) are detected and decoded per pair
(`averaged` model); that path is covered by `test.mjs` but untested on hardware. Firefox 156 hands
over I420 frames, so temperatures work there too. A browser that only gives RGB frames shows only
the camera's own picture, through the palette.

## Frames without temperatures

Any camera at the W×2H size decodes to numbers, e.g. a normal camera given this camera type in a
browser that scales it to that size (Safari does). `checkTemperatures` in `decode.js` rejects such
frames: real temperatures change smoothly between neighbouring pixels, and the camera's own
picture in the top half shows the same scene, so the two correlate. Measured with a TOOLTOP T256,
an endoscope and a microscope in Chrome and Firefox, both checks have wide margins (see the
comment there). The video is then shown as it is, with "No temperature data" and a hint to check
the camera type. A very even scene cannot be told apart and counts as real.

Tested: TOOLTOP T256 (USB 0bda:5840) on macOS 26 with Chrome 155. It sends black frames for about
4 s after starting, and shifts all readings by about 5 °C some 6 s after that (presumably its own
calibration); the app marks readings as settling for the first 8 s.
