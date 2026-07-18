import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
    plugins: [
        crx({ manifest })
    ],
    build: {
        rollupOptions: {
            input: {
                // crxjs auto-discovers popup.html, content scripts, and the
                // background service worker straight from manifest.json -
                // but offscreen.html is only referenced dynamically inside
                // background.js's JS code, so it needs to be listed here
                // explicitly or Vite never builds it at all.
                offscreen: "src/offscreen/offscreen.html"
            }
        }
    }
});