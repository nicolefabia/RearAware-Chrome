const enabled = document.getElementById("enabled");
const mute = document.getElementById("mute");

const version = document.getElementById("version");

const github = document.getElementById("github");
const issues = document.getElementById("issues");

// Version
const manifest = chrome.runtime.getManifest();
version.textContent = manifest.version_name || manifest.version;

// Links
github.href = "https://github.com/nicolefabia/RearAware-Chrome";
github.target = "_blank";

issues.href = "https://github.com/nicolefabia/RearAware-Chrome/issues/new";
issues.target = "_blank";

// Load saved settings
chrome.storage.sync.get(
    {
        enabled: true,
        mute: false
    },
    (settings) => {

        enabled.checked = settings.enabled;
        mute.checked = settings.mute;

        updateControls();

    }
);

// Extension enabled
enabled.addEventListener("change", () => {

    chrome.storage.sync.set({
        enabled: enabled.checked,
        mute: mute.checked
    });

    updateControls();

});

// Mute
mute.addEventListener("change", () => {

    chrome.storage.sync.set({
        enabled: enabled.checked,
        mute: mute.checked
    });

});

// Update controls
function updateControls() {

    mute.disabled = !enabled.checked;

    mute.parentElement.classList.toggle(
        "disabled",
        !enabled.checked
    );

}