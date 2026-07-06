let session = null;
let activeBackend = null; // "webgpu" or "wasm" - useful for debugging/telling the user what's actually running
let ortRef = null;        // the actual ort module we ended up using - content.js reuses this for ort.Tensor

export async function loadModel() {

    if (session) {
        return session;
    }

    // Try WebGPU first - genuinely GPU-accelerated, should be dramatically
    // faster than CPU/WASM. Falls back to the CPU path if anything goes
    // wrong: browser doesn't support it, or the model has an operator the
    // WebGPU backend (still experimental) doesn't implement yet.
    if (navigator.gpu) {

        try {

            console.log("🐈 Loading RearAware model (WebGPU)...");

            const ort = await import("onnxruntime-web/wasm");

            session = await ort.InferenceSession.create(
                chrome.runtime.getURL("models/30-cfb.onnx"), // FP32 model - quantized INT8 ops may not have WebGPU kernels yet
                { executionProviders: ["webgpu"] }
            );

            activeBackend = "webgpu";
            ortRef = ort;
            console.log("✅ RearAware model loaded (WebGPU - GPU accelerated).");

            return session;

        } catch (err) {
            console.warn("⚠️ WebGPU load failed, falling back to CPU:", err);
        }

    } else {
        console.warn("⚠️ navigator.gpu not available in this browser, falling back to CPU.");
    }

    // ---- CPU/WASM fallback (the path that was already working) ----

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

export function isModelLoaded() {
    return session !== null;
}

export function getActiveBackend() {
    return activeBackend;
}

export function getOrt() {
    return ortRef;
}