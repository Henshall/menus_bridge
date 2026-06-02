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

# 2. Test locally (unpacked build is faster to launch than AppImage)
./build.sh linux
./dist/linux-unpacked/menus-print-bridge --no-sandbox

# 3. Build + deploy in one step (per platform)
./deploy_linux.sh   # builds Linux AppImages and uploads to prod & staging
./deploy_mac.sh     # builds Mac DMG and uploads (run on macOS)
./deploy_win.sh     # builds Windows EXE and uploads
```

The deploy scripts are gitignored (contain server IP and SSH key path). The version is read dynamically from `package.json` — never hardcode it.

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
