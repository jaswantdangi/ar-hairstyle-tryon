# AR Hairstyle Try-On — Demo

A self-contained, browser-based AR hairstyle try-on demo. It implements the
**Phase 1 MVP** from the implementation guide (live camera, face tracking,
PNG hairstyle overlay that follows position / scale / head-roll, hairstyle
selection, and capture-to-PNG) as a single vanilla HTML/JS page so it runs
without any build step.

> The guide proposes Angular/Ionic + Jeeliz. For a runnable demo this uses the
> same architecture (camera service → tracker → Three.js renderer → capture)
> but as plain JS, and swaps **Jeeliz** for **MediaPipe FaceMesh** (reliable
> CDN, 468-point mesh → accurate forehead/face-width anchoring). The transform
> math and per-asset calibration config are identical in spirit.

## Run it

Camera access requires **HTTPS or `localhost`**. Pick any static server:

```bash
# From this folder (hairstyle-tryon-demo/)

# Option A — Python
python -m http.server 8080

# Option B — Node (no install)
npx serve -l 8080
# or
npx http-server -p 8080
```

Then open <http://localhost:8080> and allow camera access.

> Opening `index.html` directly via `file://` will **not** work — the camera
> and the `fetch` of `config/hairstyles.json` both require an `http(s)` origin.

## What you can do

- See your live (mirrored) camera feed.
- A hairstyle overlay appears once your face is detected and follows it as you
  move, lean (head roll), and move closer/further (scale).
- Tap the thumbnails at the bottom to switch hairstyles (or **None**).
- **⚙︎ Tune** — live sliders for scale / X / Y offset to calibrate placement.
- **●** (center) — capture the camera + overlay, then **Download PNG**.
- **↺ Reset** — clear the overlay.

## Files

```
hairstyle-tryon-demo/
  index.html          # page shell + CDN scripts (Three.js, MediaPipe FaceMesh)
  styles.css          # fullscreen camera UI, selector, controls, overlays
  app.js              # engine: camera, tracking, Three.js overlay, transform, capture, cleanup
  config/
    hairstyles.json   # per-hairstyle calibration (id, name, urls, scale/offset/rotation)
  hairstyles/
    hairstyle-01.png  # real alpha-transparent placeholder assets (512x512 RGBA)
    hairstyle-02.png
    hairstyle-03.png
  make-hairstyles.js  # regenerates the placeholder PNGs (pure Node, no deps)
```

## Swapping in real hairstyle art

The bundled PNGs are simple generated silhouettes so the demo works immediately.
To use real cut-outs:

1. Drop your **alpha-transparent** PNGs into `hairstyles/` (no checkerboard /
   matte backgrounds — true alpha only).
2. Point `config/hairstyles.json` entries at them and tune
   `scaleFactor` / `offsetX` / `offsetY` (use the in-app **⚙︎ Tune** sliders to
   find good values, then copy them into the config).

To regenerate the placeholders: `node make-hairstyles.js`.

## How the transform works (mirrors the guide)

Each frame, MediaPipe FaceMesh gives 468 landmarks. We derive:

- **center** from forehead (10) + chin (152) and cheeks (234/454)
- **scale** from face width (cheek-to-cheek distance)
- **head roll** from the cheek-line angle

These map to a Three.js plane in a normalized orthographic space:

```
position = faceCenter + (offsetX, offsetY)
scale    = faceWidth * scaleFactor   (× texture aspect, so the PNG isn't stretched)
rotationZ = -roll + rotationOffset
```

The overlay is hidden whenever no face is detected.

## Mapping to the guide's Angular services

| Guide service                 | Demo equivalent (in `app.js`)        |
|-------------------------------|--------------------------------------|
| `CameraService`               | `startCamera()` + env checks         |
| `JeelizFaceTrackerService`    | `initFaceMesh()` + `onFaceResults()` |
| `HairstyleRendererService`    | `initThree()` / `updateHairTransform()` |
| `HairstyleAssetsService`      | `loadHairstyles()` / `selectHairstyle()` |
| `CaptureService`              | `capture()` + `drawCover()`          |
| cleanup on destroy            | `cleanup()` (beforeunload/pagehide)  |

## Error states handled

`HTTPS_REQUIRED`, `BROWSER_NOT_SUPPORTED`, `WEBGL_NOT_SUPPORTED`,
tracker/Three.js load failure, `CAMERA_PERMISSION_DENIED`, `CAMERA_NOT_FOUND`,
asset load failure, and `NO_FACE_DETECTED` (center hint).

## Not in this demo (later phases from the guide)

- Occlusion / face masking (Phase 3)
- 3D GLB hairstyles via GLTFLoader (Phase 4)
- Front/back camera switch UI (single front camera here)
