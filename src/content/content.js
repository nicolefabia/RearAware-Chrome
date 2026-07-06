console.log("🐈 RearAware loaded!");

const MODEL_SIZE = 320;         // model expects [1, 3, 320, 320]
const SCORE_THRESHOLD = 0.28;   // minimum confidence to show the sticker
const DETECT_INTERVAL_MS = 0; // no artificial floor - just run again as soon as the previous detection finishes

let ort = null; // filled in once startDetectionLoop() knows which backend (webgpu/wasm) detector.js actually loaded

let enabled = true;
let mute = false;

let video = null;
let sticker = null;
let session = null;

let canvas = null;
let ctx = null;

let latestDetection = null; // { x1, y1, x2, y2, score } in raw video pixel space, or null
let lastDetectionTime = 0;  // performance.now() timestamp of the last successful detection
let debugFrameCount = 0;    // throttles the confidence-score debug logging below
let wasDetected = false;    // tracks previous tick's state, so a sound fires once per newly-appeared detection
let lastSoundTime = 0;
let detectTimer = null;
let detectionActive = false; // set false to stop the self-rescheduling detection loop
let rafId = null;

let stickerAspect = 1; // width / height of censored.png, filled in once it loads
let smoothedBox = null; // { cx, cy, height } in screen px - eased toward the latest detection each frame

const SOUND_COOLDOWN_MS = 3000; // mirrors sound_cooldown in rearaware.py

const SOUND_FILES = [
    "sounds/duck.wav",
    "sounds/fart1.wav",
    "sounds/fart2.wav",
    "sounds/fart3.wav",
    "sounds/fart4.wav",
    "sounds/fart5.wav",
    "sounds/fart6.wav",
    "sounds/fart7.wav",
    "sounds/fart8.wav",
    "sounds/fart9.wav",
    "sounds/fart10.wav",
    "sounds/fart11.wav",
    "sounds/fart12.wav",
    "sounds/law-and-order.wav",
    "sounds/mgs-alert.wav",
    "sounds/psycho.wav",
    "sounds/wasted.wav",
    "sounds/wilhelm.wav",
    "sounds/windows-error.wav"
];

function playRandomSound() {
    const file = SOUND_FILES[Math.floor(Math.random() * SOUND_FILES.length)];
    const audio = new Audio(chrome.runtime.getURL(file));
    audio.play().catch(() => {}); // ignore autoplay-policy rejections
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

chrome.storage.sync.get({ enabled: true, mute: false }, (settings) => {
    enabled = settings.enabled;
    mute = settings.mute;

    if (enabled) {
        findVideo();
    }
});

chrome.storage.onChanged.addListener((changes) => {

    if (changes.enabled) {

        enabled = changes.enabled.newValue;

        if (enabled) {
            console.log("✅ RearAware enabled");
            findVideo();
        } else {
            console.log("⏸️ RearAware disabled");
            stopEverything();
        }
    }

    if (changes.mute) {
        mute = changes.mute.newValue;
    }

});

// ---------------------------------------------------------------------------
// Find the webcam <video> element
// ---------------------------------------------------------------------------

const observer = new MutationObserver(() => {
    if (!enabled) return;
    findVideo();
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

setInterval(() => {
    if (!enabled) return;
    findVideo();
}, 1000);

let initialized = false; // one-time setup (canvas/sticker/loops) happens only once, video re-acquisition can happen repeatedly

function pickBestVideo() {

    const videos = Array.from(document.querySelectorAll("video"));

    // Meet mutes your own camera tile to avoid audio feedback, so a muted
    // video with real dimensions is a decent signal for "this is you."
    // Other participants' videos are normally unmuted.
    return videos.find(v => v.muted && v.videoWidth > 0)
        || videos.find(v => v.videoWidth > 0)
        || null;

}

function findVideo() {

    // If our current video reference has gone stale (removed from the page,
    // e.g. Meet swapping the preview video out for the in-call one), drop it
    // so the logic below picks a fresh one instead of silently doing nothing.
    if (video && (!video.isConnected || video.videoWidth === 0)) {
        video = null;
    }

    if (!video) {

        const candidate = pickBestVideo();
        if (!candidate) return;

        video = candidate;
        console.log("📹 Webcam detected.");

    }

    if (!initialized) {
        initialized = true;
        setupCanvas();
        createSticker();
        startDetectionLoop();
        startPositionLoop();
    }

}

function setupCanvas() {
    canvas = document.createElement("canvas");
    canvas.width = MODEL_SIZE;
    canvas.height = MODEL_SIZE;
    ctx = canvas.getContext("2d", { willReadFrequently: true });
}

function createSticker() {

    if (sticker) return;

    sticker = document.createElement("img");
    sticker.src = chrome.runtime.getURL("assets/censored.png");

    sticker.onload = () => {
        stickerAspect = sticker.naturalWidth / sticker.naturalHeight;
    };

    sticker.style.position = "fixed";
    sticker.style.pointerEvents = "none";
    sticker.style.zIndex = "999999";
    sticker.style.display = "none"; // hidden until a detection clears the threshold

    document.body.appendChild(sticker);

}

// ---------------------------------------------------------------------------
// Model loading + inference loop
// ---------------------------------------------------------------------------

async function startDetectionLoop() {

    try {
        // Dynamic import() forces this to load as a real module, which is
        // required for onnxruntime-web's code to run without crashing.
        let loadModel, getOrt, getActiveBackend;
        ({ loadModel, getOrt, getActiveBackend } = await import("./detector.js"));

        session = await loadModel();
        ort = getOrt(); // reuse whichever ort module (webgpu or wasm) detector.js actually loaded

        console.log(`🚀 RearAware running on: ${getActiveBackend()}`);
    } catch (err) {
        console.error("❌ RearAware failed to load model:", err);
        return;
    }

    detectionActive = true;
    scheduleNextDetection();

}

function scheduleNextDetection() {

    detectTimer = setTimeout(async () => {

        if (!detectionActive) return;

        await runDetection();

        if (detectionActive) scheduleNextDetection();

    }, DETECT_INTERVAL_MS);

}

async function runDetection() {

    if (!enabled || !video || !session) return;
    if (video.readyState < 2 || video.videoWidth === 0) return; // not ready yet

    // Draw the current frame, stretched to the model's input size
    ctx.drawImage(video, 0, 0, MODEL_SIZE, MODEL_SIZE);

    const { data } = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE); // RGBA, uint8

    const pixelCount = MODEL_SIZE * MODEL_SIZE;
    const chw = new Float32Array(3 * pixelCount);

    for (let i = 0; i < pixelCount; i++) {
        chw[i] = data[i * 4] / 255;                       // R plane
        chw[pixelCount + i] = data[i * 4 + 1] / 255;       // G plane
        chw[2 * pixelCount + i] = data[i * 4 + 2] / 255;   // B plane
    }

    const tensor = new ort.Tensor("float32", chw, [1, 3, MODEL_SIZE, MODEL_SIZE]);

    let results;
    const inferenceStart = performance.now();

    try {
        results = await session.run({ images: tensor });
    } catch (err) {
        console.error("❌ RearAware inference failed:", err);
        return;
    }

    console.log(`⏱️ inference took ${(performance.now() - inferenceStart).toFixed(0)}ms`);

    const BUTT_CLASS = 2; // matches `if cls == 2` in rearaware.py

    const boxes = results.output0.data; // flattened [300, 6]: x1, y1, x2, y2, score, class
    let best = null;
    const bestScorePerClass = [0, 0, 0]; // [cat, face, butt] - for debug logging below

    for (let i = 0; i < 300; i++) {

        const o = i * 6;
        const score = boxes[o + 4];
        const cls = boxes[o + 5];

        if (cls >= 0 && cls <= 2 && score > bestScorePerClass[cls]) {
            bestScorePerClass[cls] = score;
        }

        if (cls !== BUTT_CLASS) continue; // ignore other classes (e.g. "cat" as a whole)
        if (score < SCORE_THRESHOLD) continue;

        if (!best || score > best.score) {
            best = {
                x1: boxes[o],
                y1: boxes[o + 1],
                x2: boxes[o + 2],
                y2: boxes[o + 3],
                score
            };
        }

    }

    // Throttled so it doesn't flood the console at ~30fps - logs roughly
    // twice a second. Watch this while the sticker fails to show: if the
    // "butt" number is just under SCORE_THRESHOLD, lower the threshold. If
    // it's near zero while "cat" is high, the model is misclassifying that
    // angle/pose as "cat" instead of "butt" - a harder, training-data problem.
    debugFrameCount++;
    if (debugFrameCount % 15 === 0) {
        console.log(
            `🔍 best scores - cat: ${bestScorePerClass[0].toFixed(2)}, ` +
            `face: ${bestScorePerClass[1].toFixed(2)}, ` +
            `butt: ${bestScorePerClass[2].toFixed(2)} ` +
            `(threshold: ${SCORE_THRESHOLD})`
        );
    }

    if (best) {

        // Model space (stretched to MODEL_SIZE) -> raw video pixel space
        const scaleX = video.videoWidth / MODEL_SIZE;
        const scaleY = video.videoHeight / MODEL_SIZE;

        latestDetection = {
            x1: best.x1 * scaleX,
            y1: best.y1 * scaleY,
            x2: best.x2 * scaleX,
            y2: best.y2 * scaleY,
            score: best.score
        };

        lastDetectionTime = performance.now();

    } else {
        latestDetection = null;
    }

    // Play a random detection sound once, right when a detection newly
    // appears - matches rearaware.py's rising-edge + cooldown behavior.
    const isDetected = !!latestDetection;
    const now = Date.now();

    if (
        isDetected &&
        !wasDetected &&
        !mute &&
        now - lastSoundTime > SOUND_COOLDOWN_MS
    ) {
        playRandomSound();
        lastSoundTime = now;
    }

    wasDetected = isDetected;

}

// ---------------------------------------------------------------------------
// Sticker positioning (runs every frame for smooth tracking between
// inference ticks, e.g. while the tile is being scrolled/resized)
// ---------------------------------------------------------------------------

function startPositionLoop() {

    function tick() {

        if (!enabled) return;

        positionSticker();

        rafId = requestAnimationFrame(tick);

    }

    rafId = requestAnimationFrame(tick);

}

const SMOOTHING = 0.6;        // higher = snappier but jumpier, lower = smoother but more "laggy"
const STICKER_SCALE = 1.0;    // 1.0 = sticker height matches the detection box height exactly

function isVideoMirrored(el) {

    const transform = getComputedStyle(el).transform;
    if (!transform || transform === "none") return false;

    // CSS transform matrices look like matrix(a, b, c, d, tx, ty) - a
    // negative 'a' component means the element is flipped horizontally.
    const match = transform.match(/matrix\(([-\d.]+),/);
    if (!match) return false;

    return parseFloat(match[1]) < 0;

}

const GRACE_MS = 600; // how long to keep showing the sticker after the last successful detection

function positionSticker() {

    if (!video || !sticker) return;

    if (!latestDetection) {

        const timeSinceLastHit = performance.now() - lastDetectionTime;

        if (!smoothedBox || timeSinceLastHit > GRACE_MS) {
            sticker.style.display = "none";
            smoothedBox = null; // reset so it doesn't glide in from a stale spot next time
        }
        // else: still within the grace period - leave the sticker exactly
        // where it already is rather than hiding it for a single missed frame

        return;

    }

    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!vw || !vh || !rect.width || !rect.height) return;

    // Map raw video pixel space -> the on-screen rect, assuming CSS
    // object-fit: cover (the common case for video call tiles).
    // If a site uses object-fit: contain instead, flip the comparison below.
    const videoAspect = vw / vh;
    const rectAspect = rect.width / rect.height;

    let renderScale, offsetX = 0, offsetY = 0;

    if (videoAspect > rectAspect) {
        // video is relatively wider than the box -> left/right get clipped
        renderScale = rect.height / vh;
        offsetX = (vw * renderScale - rect.width) / 2;
    } else {
        // video is relatively taller than the box -> top/bottom get clipped
        renderScale = rect.width / vw;
        offsetY = (vh * renderScale - rect.height) / 2;
    }

    let x1 = latestDetection.x1 * renderScale - offsetX;
    const y1 = latestDetection.y1 * renderScale - offsetY;
    let x2 = latestDetection.x2 * renderScale - offsetX;
    const y2 = latestDetection.y2 * renderScale - offsetY;

    // Meet mirrors your own camera preview horizontally (like a mirror) so
    // it feels natural to look at, but the raw video data we detect against
    // is NOT mirrored. Flip our x-coordinates to match what's actually shown.
    if (isVideoMirrored(video)) {
        const mirroredX1 = rect.width - x2;
        const mirroredX2 = rect.width - x1;
        x1 = mirroredX1;
        x2 = mirroredX2;
    }

    const target = {
        cx: (x1 + x2) / 2,
        cy: (y1 + y2) / 2,
        height: y2 - y1
    };

    // Ease toward the target instead of snapping straight to it - this is
    // what turns the jumpiness into a smooth glide between detection ticks.
    if (!smoothedBox) {
        smoothedBox = { ...target };
    } else {
        smoothedBox.cx += (target.cx - smoothedBox.cx) * SMOOTHING;
        smoothedBox.cy += (target.cy - smoothedBox.cy) * SMOOTHING;
        smoothedBox.height += (target.height - smoothedBox.height) * SMOOTHING;
    }

    // Scale using the image's own aspect ratio (not the detection box's
    // ratio) so it doesn't stretch/squish - only its size changes.
    const height = smoothedBox.height * STICKER_SCALE;
    const width = height * stickerAspect;

    sticker.style.width = `${width}px`;
    sticker.style.height = `${height}px`;
    sticker.style.left = `${rect.left + smoothedBox.cx - width / 2}px`;
    sticker.style.top = `${rect.top + smoothedBox.cy - height / 2}px`;
    sticker.style.display = "block";

}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function stopEverything() {

    detectionActive = false;

    if (detectTimer) {
        clearTimeout(detectTimer);
        detectTimer = null;
    }

    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }

    if (sticker) {
        sticker.remove();
        sticker = null;
    }

    video = null;
    latestDetection = null;
    wasDetected = false;
    lastSoundTime = 0;
    lastDetectionTime = 0;
    smoothedBox = null;
    initialized = false;

}