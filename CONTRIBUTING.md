# Contributing

The most useful contribution is **support for your camera**. Each supported camera is one small
JSON file in `public/cameras/`. You can add yours in one of three ways.

## Camera not showing up?

If the camera does not appear in the app (or in your system's camera or USB list) at all, plug it
in through a **USB hub, ideally a powered one**. Some cheap cameras fail to connect straight to a
laptop's port but work through a hub. Also try another cable or adapter, flipping the USB-C plug,
and another port. If only a hub works, tick **It only works through a USB hub** when you create
the report, so the camera's profile can warn the next person.

## 1. With an AI coding agent (easiest)

1. Open USB Cam Preview (https://usbcam.bosansky.com, or `npm run dev` locally) in **Chrome or Edge** with the camera plugged in.
2. Go to **Compatibility**, click **Run test**, choose what the camera is, tick **It only works
   through a USB hub** if that applies, and click **Download report**.
3. Copy the prompt shown under **Prompt for your AI agent** and give it to Claude Code, Codex or a
   similar agent. It reads [AGENTS.md](AGENTS.md), writes the profile, validates it and opens a pull request.

## 2. Through a GitHub issue

Do steps 1–2 above, then open a **New camera** issue and attach the report. A maintainer turns it
into a profile.

## 3. By hand

1. Run the test and download the report as above.
2. Copy `draftProfile` from the report into `public/cameras/<id>.json` and tidy it up following
   the rules in [AGENTS.md → Write the profile](AGENTS.md#4-write-the-profile).
3. Run `npm run check` and fix any problems it lists.
4. Open a pull request with the profile file.

You can try a profile before it is merged: **Compatibility → Try a profile file** loads it into
your browser only.

## New camera types and filters

- A camera type that needs code (its own frame format, controls or readouts) is a **driver**: one
  folder in `public/drivers/`. See [public/drivers/README.md](public/drivers/README.md) and copy
  `public/drivers/_example/`.
- A filter is **one file** in `public/filters/`. See [public/filters/README.md](public/filters/README.md).

Neither needs changes anywhere else in the app.

## Development

```
npm run dev     # http://localhost:8080
npm run check   # validate profiles, drivers and filters (CI runs this)
npm test        # tests inside driver and filter folders
```

No dependencies. Node 18+ is needed for the dev server, the checks and `npm run build`.
