console.log("🐈 RearAware loaded!");

const MODEL_SIZE = 320;         // model expects [1, 3, 320, 320]
let scoreThreshold = 0.22;   // minimum confidence to show the sticker - adjustable live via the popup slider
const DETECT_INTERVAL_MS = 20; // small safety floor - cheap insurance against overload if multiple frames ever detect concurrently

let enabled = true;
let mute = false;
let debug = false;

let video = null;
let sticker = null;
let debugBoxes = null; // { cat, face, butt } DOM elements, created lazily

let canvas = null;
let ctx = null;

let latestDetection = null; // { x1, y1, x2, y2, score } in raw video pixel space, or null - the butt box, used for the sticker
let latestDetections = [null, null, null]; // [cat, face, butt] in raw video pixel space, or null each - used for debug view
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

// Uses chrome.storage.local, matching popup.js's actual key names (this
// previously used chrome.storage.sync with made-up key names, which meant
// the popup and content script were never actually talking to each other).
// "confidence" arrives as a 0-100 percentage from the popup slider.
chrome.storage.local.get(
    {
        detectionEnabled: true,
        soundEnabled: true,
        debugEnabled: false,
        confidence: 22,
        obfuscation: "standard"
    },
    (settings) => {
        enabled = settings.detectionEnabled;
        mute = !settings.soundEnabled;
        debug = settings.debugEnabled;
        scoreThreshold = settings.confidence / 100;
        obfuscationType = settings.obfuscation;

        if (enabled) {
            findVideo();
        }
    }
);

chrome.storage.onChanged.addListener((changes) => {

    if (changes.detectionEnabled) {

        enabled = changes.detectionEnabled.newValue;

        if (enabled) {
            console.log("✅ RearAware enabled");
            findVideo();
        } else {
            console.log("⏸️ RearAware disabled");
            stopEverything();
        }
    }

    if (changes.soundEnabled) {
        mute = !changes.soundEnabled.newValue;
    }

    if (changes.debugEnabled) {
        debug = changes.debugEnabled.newValue;
    }

    if (changes.obfuscation) {
        obfuscationType = changes.obfuscation.newValue;
        if (sticker) setObfuscationMode(obfuscationType); // live-swap the sticker mid-call
    }

    if (changes.confidence) {
        scoreThreshold = changes.confidence.newValue / 100;
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

const MIN_VIDEO_DIMENSION = 100; // filters out tiny decorative/thumbnail videos, not real webcam tiles

function pickBestVideo() {

    const videos = Array.from(document.querySelectorAll("video"))
        .filter(v => v.videoWidth >= MIN_VIDEO_DIMENSION && v.videoHeight >= MIN_VIDEO_DIMENSION);

    // Meet mutes your own camera tile to avoid audio feedback, so a muted
    // video with real dimensions is a decent signal for "this is you."
    // Other participants' videos are normally unmuted.
    return videos.find(v => v.muted)
        || videos[0]
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

// Sticker (obfuscation overlay) - three modes, one shared position/sizing
// pipeline. Each mode maps to a media file; "all-seeing" is a looping video
// (canvas-composited GIFs don't animate, so it ships as webm instead),
// the other two are static images.
const STICKER_ASSETS = {
    "standard": { type: "image", src: "assets/censored.png", scale: 1.6 },
    "all-seeing": { type: "video", src: "assets/sauron.webm", scale: 2.4 },
    "nicolas-cage": { type: "image", src: "assets/nicolascage.webp", scale: 2.2 }
};

let obfuscationType = "standard"; // synced from popup storage
let stickerScale = 1.6; // how much bigger than the raw detection box to draw the sticker - set per-mode below

function buildStickerElement(mode) {

    const config = STICKER_ASSETS[mode] || STICKER_ASSETS.standard;
    let el;

    if (config.type === "video") {

        el = document.createElement("video");
        el.src = chrome.runtime.getURL(config.src);
        el.loop = true;
        el.muted = true; // required for autoplay to be allowed
        el.playsInline = true;
        el.autoplay = true;

        el.addEventListener("loadedmetadata", () => {
            stickerAspect = el.videoWidth / el.videoHeight;
        });

        el.play().catch(() => {}); // ignore autoplay-policy rejections (should be fine since it's muted)

    } else {

        el = document.createElement("img");
        el.src = chrome.runtime.getURL(config.src);

        el.onload = () => {
            stickerAspect = el.naturalWidth / el.naturalHeight;
        };

    }

    el.style.position = "fixed";
    el.style.pointerEvents = "none";
    el.style.zIndex = "999999";
    el.style.display = "none"; // hidden until a detection clears the threshold

    return el;

}

function setObfuscationMode(mode) {

    obfuscationType = STICKER_ASSETS[mode] ? mode : "standard";
    stickerScale = STICKER_ASSETS[obfuscationType].scale ?? 1.6;

    // Carry over the outgoing sticker's position/visibility so switching
    // modes mid-call doesn't cause a visible flash or jump to (0,0).
    const wasVisible = sticker && sticker.style.display !== "none";
    const previousStyle = sticker
        ? {
            width: sticker.style.width,
            height: sticker.style.height,
            left: sticker.style.left,
            top: sticker.style.top
        }
        : null;

    if (sticker) sticker.remove();

    sticker = buildStickerElement(obfuscationType);
    document.body.appendChild(sticker);

    if (previousStyle) {
        sticker.style.width = previousStyle.width;
        sticker.style.height = previousStyle.height;
        sticker.style.left = previousStyle.left;
        sticker.style.top = previousStyle.top;
    }
    if (wasVisible) sticker.style.display = "block";

}

function createSticker() {

    if (sticker) return;

    setObfuscationMode(obfuscationType);
    createDebugBoxes();

}

const DEBUG_CLASS_INFO = [
    { name: "CAT_00", color: "#3b82f6" },   // blue
    { name: "CAT_FACE", color: "#22c55e" },  // green
    { name: "CAT_BUTT", color: "#ef4444" }   // red
];

function createDebugBoxes() {

    if (debugBoxes) return;

    debugBoxes = DEBUG_CLASS_INFO.map(({ name, color }) => {

        const box = document.createElement("div");

        box.style.position = "fixed";
        box.style.pointerEvents = "none";
        box.style.zIndex = "999999";
        box.style.border = `2px solid ${color}`;
        box.style.boxSizing = "border-box";
        box.style.display = "none";

        const label = document.createElement("span");
        label.style.position = "absolute";
        label.style.top = "-20px";
        label.style.left = "-2px";
        label.style.background = color;
        label.style.color = "#fff";
        label.style.font = "12px monospace";
        label.style.padding = "1px 5px";
        label.style.whiteSpace = "nowrap";
        box.appendChild(label);

        document.body.appendChild(box);

        return { name, el: box, label };

    });

}

// ---------------------------------------------------------------------------
// Model loading + inference loop
// ---------------------------------------------------------------------------

async function startDetectionLoop() {

    try {
        // The offscreen document is created/managed by background.js - a
        // content script can't create it directly. This just confirms it's
        // actually ready before we start sending it frames.
        await chrome.runtime.sendMessage({ type: "ensureOffscreenReady" });
    } catch (err) {
        console.error("❌ RearAware failed to reach background script:", err);
        return;
    }

    detectionActive = true;
    scheduleNextDetection();

}

function scheduleNextDetection() {

    detectTimer = setTimeout(async () => {

        if (!detectionActive) return;

        try {
            await runDetection();
        } catch (err) {
            // Whatever went wrong, don't let it permanently kill the loop -
            // worst case this is one skipped detection, not a dead extension.
            console.error("❌ RearAware: unexpected error in detection loop:", err);
        }

        if (detectionActive) scheduleNextDetection();

    }, DETECT_INTERVAL_MS);

}

async function runDetection() {

    if (!enabled || !video) return;
    if (video.readyState < 2 || video.videoWidth === 0) return; // not ready yet

    // Draw the current frame, stretched to the model's input size
    ctx.drawImage(video, 0, 0, MODEL_SIZE, MODEL_SIZE);

    const { data } = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE); // RGBA, uint8

    const inferenceStart = performance.now();
    let response;

    try {
        response = await chrome.runtime.sendMessage({
            type: "runInference",
            imageData: data,
            threshold: scoreThreshold
        });
    } catch (err) {

        // The connection to the offscreen document can occasionally drop
        // mid-call (seen on Teams, likely from its own page doing something
        // disruptive to the frame). Try to re-establish it once before
        // giving up, so this becomes one skipped frame instead of a full
        // break that needs a manual reload.
        console.warn("⚠️ RearAware lost connection to offscreen document, reconnecting:", err.message);

        try {
            await chrome.runtime.sendMessage({ type: "ensureOffscreenReady" });
            response = await chrome.runtime.sendMessage({
                type: "runInference",
                imageData: data,
                threshold: scoreThreshold
            });
        } catch (retryErr) {
            console.error("❌ RearAware failed to reach offscreen document after retry:", retryErr);
            return;
        }

    }

    if (response?.error) {
        console.error("❌ RearAware inference failed:", response.error);
        return;
    }

    console.log(`⏱️ inference took ${(performance.now() - inferenceStart).toFixed(0)}ms`);

    const bestPerClass = response.detections; // [cat, face, butt], already filtered by threshold

    // Throttled so it doesn't flood the console at ~30fps - logs roughly
    // twice a second. Watch this while the sticker fails to show: if the
    // "butt" number is just under scoreThreshold, lower the threshold. If
    // it's near zero while "cat" is high, the model is misclassifying that
    // angle/pose as "cat" instead of "butt" - a harder, training-data problem.
    debugFrameCount++;
    if (debugFrameCount % 15 === 0) {
        console.log(
            `🔍 best scores - cat: ${(bestPerClass[0]?.score ?? 0).toFixed(2)}, ` +
            `face: ${(bestPerClass[1]?.score ?? 0).toFixed(2)}, ` +
            `butt: ${(bestPerClass[2]?.score ?? 0).toFixed(2)} ` +
            `(threshold: ${scoreThreshold}, backend: ${response.backend})`
        );
    }

    // Model space (stretched to MODEL_SIZE) -> raw video pixel space
    const scaleX = video.videoWidth / MODEL_SIZE;
    const scaleY = video.videoHeight / MODEL_SIZE;

    latestDetections = bestPerClass.map((box) => {
        if (!box) return null;
        return {
            x1: box.x1 * scaleX,
            y1: box.y1 * scaleY,
            x2: box.x2 * scaleX,
            y2: box.y2 * scaleY,
            score: box.score
        };
    });

    const best = bestPerClass[2]; // butt class, for the sticker

    if (best) {

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

        if (debug) {
            if (sticker) sticker.style.display = "none";
            positionDebugBoxes();
        } else {
            hideDebugBoxes();
            positionSticker();
        }

        rafId = requestAnimationFrame(tick);

    }

    rafId = requestAnimationFrame(tick);

}

const SMOOTHING = 0.1;        // higher = snappier but jumpier, lower = smoother but more "laggy"

function isVideoMirrored(el) {

    const transform = getComputedStyle(el).transform;
    if (!transform || transform === "none") return false;

    // CSS transform matrices look like matrix(a, b, c, d, tx, ty) - a
    // negative 'a' component means the element is flipped horizontally.
    const match = transform.match(/matrix\(([-\d.]+),/);
    if (!match) return false;

    return parseFloat(match[1]) < 0;

}

// Maps a raw-video-pixel-space box to on-screen coordinates (including
// object-fit: cover handling and mirror correction). Returns null if the
// video isn't ready to measure yet. Shared by both the sticker and the
// debug box view so they always agree on positioning.
function mapBoxToScreen(box, video) {

    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (!vw || !vh || !rect.width || !rect.height) return null;

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

    let x1 = box.x1 * renderScale - offsetX;
    const y1 = box.y1 * renderScale - offsetY;
    let x2 = box.x2 * renderScale - offsetX;
    const y2 = box.y2 * renderScale - offsetY;

    // Meet mirrors your own camera preview horizontally (like a mirror) so
    // it feels natural to look at, but the raw video data we detect against
    // is NOT mirrored. Flip our x-coordinates to match what's actually shown.
    if (isVideoMirrored(video)) {
        const mirroredX1 = rect.width - x2;
        const mirroredX2 = rect.width - x1;
        x1 = mirroredX1;
        x2 = mirroredX2;
    }

    return {
        x1: rect.left + x1,
        y1: rect.top + y1,
        x2: rect.left + x2,
        y2: rect.top + y2
    };

}

const GRACE_MS = 1000; // how long to keep showing the sticker after the last successful detection

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

    const screen = mapBoxToScreen(latestDetection, video);
    if (!screen) return;

    const target = {
        cx: (screen.x1 + screen.x2) / 2,
        cy: (screen.y1 + screen.y2) / 2,
        height: screen.y2 - screen.y1
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
    const height = smoothedBox.height * stickerScale;
    const width = height * stickerAspect;

    sticker.style.width = `${width}px`;
    sticker.style.height = `${height}px`;
    sticker.style.left = `${smoothedBox.cx - width / 2}px`;
    sticker.style.top = `${smoothedBox.cy - height / 2}px`;
    sticker.style.display = "block";

}

function positionDebugBoxes() {

    if (!video || !debugBoxes) return;

    debugBoxes.forEach(({ el, label }, i) => {

        const detection = latestDetections[i];

        if (!detection) {
            el.style.display = "none";
            return;
        }

        const screen = mapBoxToScreen(detection, video);
        if (!screen) {
            el.style.display = "none";
            return;
        }

        el.style.left = `${screen.x1}px`;
        el.style.top = `${screen.y1}px`;
        el.style.width = `${screen.x2 - screen.x1}px`;
        el.style.height = `${screen.y2 - screen.y1}px`;
        el.style.display = "block";

        label.textContent = `${DEBUG_CLASS_INFO[i].name} ${detection.score.toFixed(2)}`;

    });

}

function hideDebugBoxes() {
    if (!debugBoxes) return;
    debugBoxes.forEach(({ el }) => { el.style.display = "none"; });
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

    if (debugBoxes) {
        debugBoxes.forEach(({ el }) => el.remove());
        debugBoxes = null;
    }

    video = null;
    latestDetection = null;
    latestDetections = [null, null, null];
    wasDetected = false;
    lastSoundTime = 0;
    lastDetectionTime = 0;
    smoothedBox = null;
    initialized = false;

}