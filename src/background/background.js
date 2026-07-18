// Manages the offscreen document that will eventually host our AI model.
// Only a background service worker is allowed to create/close offscreen
// documents - content scripts can't do this directly, which is why this
// file needs to exist at all.

const OFFSCREEN_URL = "src/offscreen/offscreen.html";

let creatingOffscreenDocument; // a Promise, used as a lock so overlapping
                                // calls don't both try to create one at once

async function hasOffscreenDocument() {

    const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });

    return contexts.length > 0;

}

async function ensureOffscreenDocument() {

    if (await hasOffscreenDocument()) {
        return;
    }

    // If a creation is already in flight, wait for that one instead of
    // starting a second one - this is exactly what caused "Only a single
    // offscreen document may be created" before.
    if (creatingOffscreenDocument) {
        await creatingOffscreenDocument;
        return;
    }

    creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"], // closest official fit for "runs heavy background compute"
        justification: "Runs on-device AI model inference (WebGPU/WASM), which some " +
                        "sites' Content Security Policy blocks from running directly " +
                        "inside a content script."
    });

    await creatingOffscreenDocument;
    creatingOffscreenDocument = null;

    console.log("🐈 RearAware offscreen document created.");

}

// Create it lazily, on demand, rather than trying to pre-create it from
// multiple lifecycle events - service workers can be terminated and
// restarted at any time, so relying on onStartup/onInstalled alone isn't
// fully reliable anyway. This single call is our test trigger for now;
// later this becomes "whenever content.js actually needs an inference."
(async () => {

    await ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({ type: "ping" });
    console.log("🐈 Offscreen document replied:", response);

})();

// content.js calls this before it starts sending real inference requests,
// to make sure the offscreen document actually exists first rather than
// racing this file's own startup timing.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.type === "ensureOffscreenReady") {
        ensureOffscreenDocument().then(() => sendResponse({ ready: true }));
        return true;
    }

});