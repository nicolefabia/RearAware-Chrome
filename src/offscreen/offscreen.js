// This is the extension's own page, governed by our own CSP - not the
// host page's (Meet/Teams). This is exactly what lets us sidestep Teams'
// restrictive CSP once the real model-loading logic lives here.

console.log("🐈 RearAware offscreen document loaded.");

const MODEL_SIZE = 320;

let session = null;
let activeBackend = null; // "webgpu" or "wasm"
let ortRef = null;        // whichever ort module we ended up loading

async function loadModel() {

    if (session) return session;

    // Try WebGPU first - same fallback behavior as the old detector.js.
    if (navigator.gpu) {
        try {
            console.log("🐈 Loading RearAware model (WebGPU)...");

            const ort = await import("onnxruntime-web/webgpu");

            session = await ort.InferenceSession.create(
                chrome.runtime.getURL("models/30-cfb.onnx"),
                { executionProviders: ["webgpu"] }
            );

            activeBackend = "webgpu";
            ortRef = ort;
            console.log("✅ RearAware model loaded (WebGPU - GPU accelerated).");
            return session;

        } catch (err) {
            console.warn("⚠️ WebGPU load failed, falling back to CPU:", err);
        }
    }

    console.log("🐈 Loading RearAware model (CPU fallback)...");

    const ort = await import("onnxruntime-web/wasm");

    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("assets/");

    session = await ort.InferenceSession.create(
        chrome.runtime.getURL("models/30-cfb-int8.onnx")
    );

    activeBackend = "wasm";
    ortRef = ort;
    console.log("✅ RearAware model loaded (CPU fallback).");

    return session;

}

// imageData: RGBA pixel data (Uint8ClampedArray) at MODEL_SIZE x MODEL_SIZE,
// same as what content.js already extracts via canvas getImageData().
async function runInferenceInternal(imageData, threshold) {

    await loadModel();

    const pixelCount = MODEL_SIZE * MODEL_SIZE;
    const chw = new Float32Array(3 * pixelCount);

    for (let i = 0; i < pixelCount; i++) {
        chw[i] = imageData[i * 4] / 255;
        chw[pixelCount + i] = imageData[i * 4 + 1] / 255;
        chw[2 * pixelCount + i] = imageData[i * 4 + 2] / 255;
    }

    const tensor = new ortRef.Tensor("float32", chw, [1, 3, MODEL_SIZE, MODEL_SIZE]);
    const results = await session.run({ images: tensor });
    const boxes = results.output0.data; // flattened [300, 6]

    const bestPerClass = [null, null, null]; // [cat, face, butt]

    for (let i = 0; i < 300; i++) {

        const o = i * 6;
        const score = boxes[o + 4];
        const cls = boxes[o + 5];

        if (cls >= 0 && cls <= 2 && score >= threshold) {
            if (!bestPerClass[cls] || score > bestPerClass[cls].score) {
                bestPerClass[cls] = {
                    x1: boxes[o], y1: boxes[o + 1],
                    x2: boxes[o + 2], y2: boxes[o + 3],
                    score
                };
            }
        }

    }

    return { detections: bestPerClass, backend: activeBackend };

}

// Simple queue/mutex: chains every call after whatever's currently running,
// so the shared model session only ever processes one request at a time -
// even if multiple tabs (e.g. Meet and Teams open together) send inference
// requests at the same moment. Without this, concurrent calls to the same
// session were likely what destabilized things when testing multiple tabs.
let inferenceQueue = Promise.resolve();

function runInference(imageData, threshold) {

    const result = inferenceQueue.then(() => runInferenceInternal(imageData, threshold));

    // Swallow errors here so one failed request doesn't permanently jam
    // the queue for everyone waiting behind it - the real error still
    // propagates to whoever's awaiting `result` below.
    inferenceQueue = result.catch(() => {});

    return result;

}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.type === "ping") {
        sendResponse({ type: "pong", from: "offscreen document" });
        return true;
    }

    if (message.type === "runInference") {
        runInference(message.imageData, message.threshold)
            .then(sendResponse)
            .catch((err) => sendResponse({ error: err.message }));
        return true; // keep the message channel open for the async response
    }

});