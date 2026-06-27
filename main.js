'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');

app.commandLine.appendSwitch('no-sandbox');
const path   = require('path');
const fs     = require('fs');
const bridge = require('./bridge');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

let tray        = null;
let settingsWin = null;
let isRunning   = false;
let updateReady = false;

// ── Config ──────────────────────────────────────────────────────────────────
function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── Tray ────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
    return Menu.buildFromTemplate([
        { label: isRunning ? '🟢 Bridge running' : '🔴 Bridge stopped', enabled: false },
        { type: 'separator' },
        { label: 'Settings…', click: openSettings },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
    ]);
}

function updateTray() {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(
        updateReady ? 'Menus Print Bridge — update ready, will install on quit'
      : isRunning   ? 'Menus Print Bridge — running'
      :               'Menus Print Bridge — stopped');
}

// ── Settings window ──────────────────────────────────────────────────────────
function openSettings() {
    if (settingsWin) { settingsWin.focus(); return; }

    settingsWin = new BrowserWindow({
        width: 480, height: 660,
        resizable: true,
        title: 'Menus Print Bridge — Setup',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });

    settingsWin.loadFile(path.join(__dirname, 'ui', 'settings.html'));
    settingsWin.on('closed', () => { settingsWin = null; });
    settingsWin.setMenuBarVisibility(false);
    lastStatusSent = null; // resend current status to the fresh window
}

// ── IPC from settings window ─────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('get-printers', async () => bridge.listPrinters());

ipcMain.handle('scan-network', async (_, port) => {
    try {
        return { ok: true, printers: await bridge.scanNetwork(port || 9100) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

function saveAndRestart(cfg) {
    if (JSON.stringify(cfg) === JSON.stringify(loadConfig())) return; // unchanged — don't restart the poll loop
    saveConfig(cfg);
    restartBridge(cfg);
}

ipcMain.handle('save-config', async (_, cfg) => {
    saveAndRestart(cfg);
    return { ok: true };
});

ipcMain.on('save-config-sync', (event, cfg) => {
    saveAndRestart(cfg);
    event.returnValue = true;
});

ipcMain.handle('verify-token', async (_, cfg) => {
    try {
        const apiUrl = process.env.MENUS_API || 'https://menus.kitchen/api';
        const fetch = require('node-fetch');
        const res = await fetch(`${apiUrl}/token-verification`, {
            headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
            timeout: 8000,
        });
        if (!res.ok) return { ok: false, error: `Server returned ${res.status}` };
        const data = await res.json();
        return { ok: true, restaurants: data.restaurants || [] };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('test-print', async (_, cfg) => {
    try {
        if (cfg.printerType === 'thermal') {
            if (!cfg.thermalIp) return { ok: false, error: 'No thermal printer IP configured' };
            const cols = cfg.cols || 32;
            await bridge.printThermal(bridge.escpos(bridge.buildTestReceipt(cols), cols, cfg.lang || 'en'), cfg.thermalIp, cfg.thermalPort || 9100);
        } else {
            const cols = cfg.cols || 48;
            const text = bridge.buildTestReceipt(cols);
            if (bridge.wantsPS(cfg)) {
                await bridge.printText(bridge.buildReceiptPS(text, cols, cfg.lang || 'en'), cfg.printer || null);
            } else {
                await bridge.printText(text, cfg.printer || null);
            }
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ── Bridge ───────────────────────────────────────────────────────────────────
const POLL_MS = 4000;
let pollTimer = null;
let pollGeneration = 0; // invalidates in-flight loops when the bridge restarts

function restartBridge(cfg) {
    pollGeneration++;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (!cfg.token) { isRunning = false; updateTray(); sendBridgeStatus({ type: 'idle' }); return; }
    // env var override for local/staging dev; production otherwise
    cfg = { ...cfg, apiUrl: process.env.MENUS_API || 'https://menus.kitchen/api' };

    isRunning = true;
    updateTray();
    pushLog('Bridge started — polling every 4s');

    // Self-rescheduling loop: the next poll is only scheduled after the
    // previous one fully finishes, so slow prints can't overlap and
    // double-print orders that haven't been acked yet.
    const gen = pollGeneration;
    const run = async () => {
        try {
            await bridge.poll(cfg, onOrderPrinted, onError, onPollOk);
        } catch (e) {
            onError('poll crashed: ' + e.message);
        }
        if (gen === pollGeneration) pollTimer = setTimeout(run, POLL_MS);
    };
    run();
}

let notifTimer = null;
let pendingNotifs = [];

function pushLog(msg) {
    if (settingsWin) settingsWin.webContents.send('log', msg);
}

function onOrderPrinted(order) {
    pushLog(`✓ Printed order #${order.order_number}${order.table_name ? ' · ' + order.table_name : ''}`);
    pendingNotifs.push(order);
    if (notifTimer) return;
    notifTimer = setTimeout(() => {
        if (Notification.isSupported() && pendingNotifs.length > 0) {
            const count = pendingNotifs.length;
            const first = pendingNotifs[0];
            new Notification({
                title: 'Menus — ' + (count === 1 ? 'Order printed' : count + ' orders printed'),
                body: count === 1
                    ? `Order #${first.order_number}${first.table_name ? ' · ' + first.table_name : ''} sent to printer`
                    : `Orders ${pendingNotifs.map(o => '#' + o.order_number).join(', ')} sent to printer`,
            }).show();
        }
        pendingNotifs = [];
        notifTimer = null;
    }, 1500);
}

function onError(msg) {
    console.error('[bridge]', msg);
    pushLog(`✗ ${msg}`);
    sendBridgeStatus({ type: 'err', text: msg });
}

function onPollOk() {
    sendBridgeStatus({ type: 'ok' });
}

let lastStatusSent = null;

function sendBridgeStatus(status) {
    const key = JSON.stringify(status);
    if (key === lastStatusSent) return;
    lastStatusSent = key;
    if (settingsWin) settingsWin.webContents.send('bridge-status', status);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
// app.setLoginItemSettings is a no-op on Linux — write an XDG autostart entry instead
function installAutostart() {
    if (process.platform !== 'linux') {
        app.setLoginItemSettings({ openAtLogin: true });
        return;
    }
    if (!app.isPackaged) return;
    const execPath = process.env.APPIMAGE || process.execPath;
    const dir = path.join(app.getPath('home'), '.config', 'autostart');
    const entry = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Menus Print Bridge',
        `Exec="${execPath}" --no-sandbox`,
        'X-GNOME-Autostart-enabled=true',
        '',
    ].join('\n');
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'menus-print-bridge.desktop'), entry);
    } catch (e) {
        console.error('[autostart]', e.message);
    }
}

app.whenReady().then(() => {
    installAutostart();

    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('Menus Print Bridge');
    updateTray();

    const cfg = loadConfig();
    if (cfg.token) restartBridge(cfg);
    openSettings();

    // Check for updates (silently — only notifies when one is downloaded)
    if (app.isPackaged) autoUpdater.checkForUpdates();
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in tray

// ── Auto-update ───────────────────────────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    if (tray) updateTray();
    if (Notification.isSupported()) {
        new Notification({
            title: 'Menus Print Bridge — update ready',
            body: 'A new version has been downloaded and will install when you quit.',
        }).show();
    }
});

autoUpdater.on('error', (err) => {
    console.error('[updater]', err.message);
});
