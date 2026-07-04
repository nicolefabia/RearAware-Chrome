# Privacy Policy for RearAware

**Last updated:** July 2026

RearAware ("the extension") is a browser extension that detects and censors cat rear ends in a user's webcam feed during video calls on Google Meet and Microsoft Teams.

## What we collect

**Nothing.** RearAware does not collect, store, transmit, or sell any personal data, video, images, or other information.

## How detection works

All detection happens entirely on your own device, inside your browser. Webcam frames are read directly from the video call in progress, processed locally by an on-device AI model (using WebGPU or your CPU, depending on your browser and hardware), and immediately discarded. At no point is any video frame, image, or derived data sent to any server, stored on disk, or shared with any third party — including the developer of this extension.

## Permissions

RearAware requests the following permissions, used only as described:

- **storage** — saves your on/off and mute preferences locally on your own device, so your settings persist between sessions. This data never leaves your device.
- **activeTab / tabs** — used only to determine whether the currently open tab is a supported video call platform (Google Meet or Microsoft Teams), so the extension knows when to activate.
- **Host permissions** (meet.google.com, teams.microsoft.com) — required so the extension's detection overlay can run on these two platforms. RearAware does not run on, monitor, or request access to any other website.

## Third parties

RearAware does not use any third-party analytics, advertising, or tracking services. No data is shared with any third party, for any purpose.

## Children's privacy

RearAware does not knowingly collect any information from anyone, including children, since it does not collect information at all.

## Changes to this policy

If this policy ever changes (for example, if a future version of the extension adds a new feature that does collect data), this page will be updated and the "Last updated" date above will reflect that change.

## Contact

Questions about this policy or the extension can be raised via the GitHub repository's Issues page.
