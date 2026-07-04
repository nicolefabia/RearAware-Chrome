# RearAware

Because your cat has no sense of professional boundaries.

RearAware is a real time AI webcam filter that detects and censors cat butts during video calls. Powered by a custom trained YOLO model running fully on-device via WebGPU, it identifies feline rear ends in real time and automatically covers them with a CENSORED sticker. No video ever leaves your computer.

Built for Google Meet and Microsoft Teams.

![RearAware demo](./assets/demo.gif)

## Features

- 🐈 Real-time cat butt detection and censoring, powered by a custom-trained YOLO model
- ⚡ GPU-accelerated (WebGPU) with an automatic fallback to CPU if WebGPU isn't available
- 🔊 Random sound effects on detection (mutable)
- 🔒 100% on-device (no video, images, or data are ever sent anywhere)
- 🎚️ Simple on/off and mute toggles from the extension popup

## Installation

**From the Chrome Web Store** (once published):

[Coming soon]

**Manual install (for now / for developers):**

1. Download or clone this repo.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```
4. Open `chrome://extensions` in Chrome.
5. Enable **Developer mode** (top right).
6. Click **Load unpacked** and select the `dist` folder.

## Using it in a meeting

1. Make sure RearAware is enabled (click the extension icon to check).
2. Join a call on **Google Meet** or **Microsoft Teams**.
3. That's it :) your cat's dignity is now protected.

Toggle it off, or mute the sound effects, from the extension popup at any time.

## Notes

- Works best with good lighting and a clear view of the cat.
- The model was trained on cats only, not dogs, humans, or anything else.
- Sound effects are random. You're welcome.
- Detection isn't perfect — it may occasionally miss a butt at an odd angle, or very rarely censor something that isn't one. It's a fun tool, not a guarantee.
- Requires a browser with WebGPU support (recent versions of Chrome) for full speed; falls back to a slower CPU-only mode otherwise.

## How it works (for the curious)

- A YOLO model (trained via Ultralytics, exported to ONNX) detects three classes: cat, face, and butt.
- Inference runs client-side using [onnxruntime-web](https://github.com/microsoft/onnxruntime), using the WebGPU execution provider when available.
- A content script captures webcam frames from the call's video element, runs detection, and overlays a censor sticker positioned and scaled to match the detected region — including correcting for Meet's mirrored self-view.

