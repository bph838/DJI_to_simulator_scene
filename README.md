# DJI_to_simulator_scene

**Sim Scene Maker** turns the 35 photos a DJI Mini 4 Pro takes for a sphere panorama into a SkyBox scene for
RC flight simulators. Supported so far: **Heli-X**.

Everything runs in the browser (Chrome or Edge): photos are read from your disk and never uploaded.

## Run it

```sh
npm install
npm run dev        # open the printed http://localhost:5173 link in Chrome
```

1. **Choose photo folder**: the folder with `PANO_0001.JPG` … `PANO_0035.JPG`.
2. **Set the front**: click the flight line on the panorama, or look at it in the viewer and press
   *Use this view as front*. The heading is remembered for that shoot.
3. **Make scene**: pick sizes (1024 / 2048 / 4096 / 8192), JPG or PNG, and an output folder.
   The app writes `<output>/<scene>/<size>/<scene>_front.jpg` etc. and creates or updates `<scene>.xml`
   with the matching `<ResolutionNNNN>` flags. Copy the `<scene>` folder into Heli-X's
   `resources/environments/SkyBox/` folder.

## How it works

- Each DJI photo has the gimbal's compass heading and tilt in its XMP metadata
  (`drone-dji:GimbalYawDegree`, `GimbalPitchDegree`, `GimbalRollDegree`), plus the focal length and shutter speed in EXIF.
  These place every photo on the sphere without any image matching.
- The GPU renders each cube face directly from the photos, blending overlaps in linear light with
  shutter-speed exposure correction and edges that fade into each other.
- DJI leaves a small uncovered patch straight overhead; it is filled from the surrounding sky.
- Heli-X face pictures are **mirrored** compared with looking at them from inside the box, so `_left`
  shows what is to the pilot's right. This was verified against a working Heli-X scene and is covered by
  unit tests (`src/core/geometry.js`).
- 4096 is about the most detail the photos hold (~56 px per degree); 8192 is upscaled.

## Development

```sh
npm test              # unit tests (geometry, metadata, hole fill, XML)
npm run test:browser  # end-to-end in headless Chrome/Edge with sample photos; output in test/browser/out
npm run build         # static site in dist/, ready to host
```

`test:browser` takes optional arguments: `[photoFolder] [faceSize] [frontHeading]`
(defaults: `../Higher_Res/001_0039 1024 152.5`).

## Roadmap

- Refine photo alignment by matching features between overlapping photos (gimbal angles are ~1–3° off,
  which can show as seams at 4096).
- Multi-band blending and vignetting correction for invisible seams and an even sky.
- Sun direction (`LightDir`) for the airport XML from the photo's time and GPS position.
- Hosted version.
