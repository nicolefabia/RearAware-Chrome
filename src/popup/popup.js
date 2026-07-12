// ============================================================
// RearAware popup behaviors
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  const popup = document.getElementById('popup');

  // ---------- Version badge, pulled from manifest.json (version_name if set, else version) ----------
  // Falls back to the static HTML text when previewing outside the extension.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
    const manifest = chrome.runtime.getManifest();
    const versionText = manifest.version_name || manifest.version;
    document.getElementById('versionBadge').textContent = `Version ${versionText}`;
  }

  // ---------- Default settings (used on first install, or when previewing standalone) ----------
  const DEFAULTS = {
    detectionEnabled: true,
    confidence: 22,
    obfuscation: 'standard',
    soundEnabled: true,
    debugEnabled: false
  };

  // chrome.storage isn't available when popup.html is opened directly as a file —
  // this fallback lets the popup still work for previewing outside the extension.
  const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  function loadSettings(callback) {
    if (hasChromeStorage) {
      chrome.storage.local.get(DEFAULTS, callback); // returns DEFAULTS for any unset keys
    } else {
      callback(DEFAULTS);
    }
  }

  function saveSetting(key, value) {
    if (hasChromeStorage) {
      chrome.storage.local.set({ [key]: value });
    }
  }

  // ---------- Element refs ----------
  const masterToggle = document.getElementById('masterToggle');
  const statusLabel = document.getElementById('statusLabel');
  const soundToggle = document.getElementById('soundToggle');
  const debugToggle = document.getElementById('debugToggle');
  const slider = document.getElementById('thresholdSlider');
  const thresholdValue = document.getElementById('thresholdValue');
  const chips = document.querySelectorAll('.chip');

  // ---------- Generic toggle wiring (buttons using aria-checked) ----------
  function wireToggle(el, { onChange } = {}) {
    el.addEventListener('click', () => {
      if (el.disabled) return;
      const checked = el.getAttribute('aria-checked') === 'true';
      el.setAttribute('aria-checked', String(!checked));
      if (onChange) onChange(!checked);
    });
  }

  function setToggleState(el, isChecked) {
    el.setAttribute('aria-checked', String(isChecked));
  }

  // Elements that go inert when Detection is off — everything that only makes
  // sense while the detector is actually running.
  function setDependentControlsDisabled(isDisabled) {
    soundToggle.disabled = isDisabled;
    debugToggle.disabled = isDisabled;
    slider.disabled = isDisabled;
    chips.forEach((chip) => { chip.disabled = isDisabled; });
  }

  function setMasterState(isOn) {
    setToggleState(masterToggle, isOn);
    popup.classList.toggle('is-off', !isOn);
    statusLabel.textContent = isOn ? 'Detection: On' : 'Detection: Off';
    setDependentControlsDisabled(!isOn);
  }

  wireToggle(masterToggle, {
    onChange: (isOn) => {
      setMasterState(isOn);
      saveSetting('detectionEnabled', isOn);
    }
  });

  wireToggle(soundToggle, {
    onChange: (isOn) => saveSetting('soundEnabled', isOn)
  });

  wireToggle(debugToggle, {
    onChange: (isOn) => saveSetting('debugEnabled', isOn)
  });

  // ---------- Confidence threshold slider ----------
  function updateSlider() {
    const val = Number(slider.value);
    thresholdValue.textContent = `[${val}%]`;
    slider.style.setProperty('--fill', `${val}%`);
  }
  slider.addEventListener('input', updateSlider);
  slider.addEventListener('change', () => saveSetting('confidence', Number(slider.value)));

  // ---------- Obfuscation type chips ----------
  function selectChip(value) {
    chips.forEach((c) => {
      const isMatch = c.dataset.value === value;
      c.classList.toggle('is-selected', isMatch);
      c.setAttribute('aria-checked', String(isMatch));
    });
  }

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      if (chip.disabled) return;
      selectChip(chip.dataset.value);
      saveSetting('obfuscation', chip.dataset.value);
      // chip.dataset.value holds "standard" | "all-seeing" | "nicolas-cage"
      // wire this up to your actual censor-overlay logic
    });
  });

  // ---------- Apply loaded (or default) settings on open ----------
  loadSettings((settings) => {
    setMasterState(settings.detectionEnabled);
    setToggleState(soundToggle, settings.soundEnabled);
    setToggleState(debugToggle, settings.debugEnabled);
    slider.value = settings.confidence;
    updateSlider();
    selectChip(settings.obfuscation);
  });

  // ---------- Footer buttons ----------
  document.getElementById('reportBtn').addEventListener('click', () => {
    window.open('https://github.com/nicolefabia/rearaware-chrome/issues/new', '_blank');
  });
  document.getElementById('learnBtn').addEventListener('click', () => {
    window.open('https://github.com/nicolefabia/rearaware-chrome', '_blank');
  });

  // ---------- Scrolling ticker ----------
  // Icons are referenced as real files (icons/*.svg) rather than inlined,
  // so duplicating this markup for the seamless loop can't cause SVG id collisions.
  const tickerItems = [
    { text: 'Detecting feline posterior threats in real time', icon: '/icons/cat-blue.svg', name: 'cat' },
    { text: 'Because nobody asked to see that', icon: '/icons/eye.svg', name: 'eye' },
    { text: 'Your video calls, now compliant', icon: '/icons/surveillence.svg', name: 'surveillance' }
  ];

  const track = document.getElementById('tickerTrack');
  const html = tickerItems.concat(tickerItems).map(
    (item) => `<span class="ticker-item"><img src="${item.icon}" alt="" data-icon="${item.name}" width="12" height="12" /><span class="ticker-text">${item.text}</span></span>`
  ).join('');
  track.innerHTML = html;

});