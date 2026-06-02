# Menus Print Bridge

A lightweight desktop app that connects your local receipt printer to [Menus](https://menus.kitchen) — no cloud print service required.

When a new order comes in, the bridge polls your Menus dashboard and sends it straight to your printer over your local network.

---

## How it works

1. The bridge runs silently in the background on any PC, Mac, or Raspberry Pi on your Wi-Fi
2. It polls `menus.kitchen` every few seconds for new orders
3. New orders are printed instantly to your connected receipt printer

---

## Supported printers

- **Thermal (ESC/POS)** — any network/Wi-Fi thermal printer (MUNBYN, Epson TM, Star, Xprinter, etc.)
- **System printers** — any printer installed on Windows (via PowerShell) or Linux/macOS (via CUPS/lpr)

---

## Installation

### Download

Grab the latest release for your platform from the [Releases](https://github.com/Henshall/menus_bridge/releases) page:

| Platform | File |
|----------|------|
| Windows  | `menus-bridge-setup.exe` |
| macOS    | `menus-bridge.dmg` |
| Linux    | `menus-bridge.AppImage` |

### Run from source

Requires Node.js 18+.

```bash
git clone https://github.com/Henshall/menus_bridge.git
cd menus_bridge
npm install
npm start
```

---

## Setup

On first launch, a settings window will open. You'll need:

- **Print token** — found in your Menus dashboard under **Printer → Network**
- **Printer type** — thermal (ESC/POS over network) or a system printer
- **Paper width** — 58mm (32 chars) or 80mm (48 chars)

Config is saved to `~/.menus-bridge.json`.

---

## Auto-start

To start the bridge automatically when your computer boots:

```bash
node install-autostart.js
```

This installs a systemd service (Linux), LaunchAgent (macOS), or Task Scheduler entry (Windows).

---

## Development

```bash
npm run dev        # Electron with DevTools
npm run build      # Package for current platform
```

---

## License

MIT — © [Baseup Operations](https://menus.kitchen)
