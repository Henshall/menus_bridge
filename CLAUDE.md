# Menus Print Bridge — Developer Notes

## Architecture

Electron app with a main process (`main.js`) and a single settings window renderer (`ui/settings.html`). The bridge logic lives in `bridge.js` and is required by the main process only. The renderer communicates with the main process exclusively via IPC (`ipcRenderer.invoke` / `ipcMain.handle`).

- `main.js` — Electron main process: tray, settings window, IPC handlers, polling loop
- `bridge.js` — Printer discovery, receipt formatting (text/PS/ESC-POS), polling the print queue API
- `ui/settings.html` — Single-file renderer: all HTML, CSS, and JS inline

## Build & Deploy

Full release workflow:

```bash
# 1. Bump version
npm version patch --no-git-tag-version

# 2. Build
./build.sh linux        # x64 + arm64 + armv7l AppImages
./build.sh mac          # DMG (requires macOS)
./build.sh win          # NSIS installer

# 3. Test locally (unpacked build is faster to launch than AppImage)
./dist/linux-unpacked/menus-print-bridge --no-sandbox

# 4. Deploy to prod + staging
./deploy.sh linux
```

The version is read dynamically from `package.json` in both scripts — never hardcode it in `deploy.sh` or `build.sh`.

In dev, always pass `--no-sandbox` (built AppImages have this set via `executableArgs` in `package.json`):

```bash
npx electron . --no-sandbox
```

Config is stored at `~/.config/menus-print-bridge/config.json`.

## Known Gotchas

### `applyLang` must stay in sync with the HTML

`applyLang()` in `settings.html` sets `textContent` on DOM elements by ID. If any referenced ID doesn't exist in the HTML, it throws a null-reference error that **silently crashes `init()`** — leaving the token field blank and the printer dropdown empty. This is the hardest bug to diagnose because the app appears to open fine.

When adding or removing UI elements, always check that every `document.getElementById(...)` call in `applyLang` has a matching element in the HTML, and vice versa.

The specific instance of this bug: `btn-save` was removed from the HTML when auto-save was introduced, but `applyLang` still referenced it, breaking all initialisation.

### Debugging a blank settings window

If the settings window opens but shows no token, no printers, and "Not configured" status despite a valid config file, suspect `init()` crashing in `applyLang`. Run the unpacked build with remote debugging to confirm:

```bash
./dist/linux-unpacked/menus-print-bridge --no-sandbox --remote-debugging-port=9222
```

Then use the Chrome DevTools protocol (or open `http://localhost:9222` in a browser) to evaluate JS in the renderer and check for errors.

### Printer discovery uses full `lpstat` path

`listPrinters()` calls `/usr/bin/lpstat` with an explicit `PATH` env override. The AppImage environment may not have the standard PATH, so relying on `lpstat` without a full path silently returns an empty list.

### Token saving requires `beforeunload`

`autoSave()` is async (`ipcRenderer.invoke`). If the user closes the settings window immediately after typing, the in-flight IPC call may be dropped. A synchronous `ipcRenderer.sendSync('save-config-sync', cfg)` on `beforeunload` guarantees the token is written before the renderer is destroyed.
