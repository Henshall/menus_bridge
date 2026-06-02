'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, Notification } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
const path   = require('path');
const fs     = require('fs');
const bridge = require('./bridge');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

let tray        = null;
let settingsWin = null;
let isRunning   = false;

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
    tray.setToolTip(isRunning ? 'Menus Print Bridge — running' : 'Menus Print Bridge — stopped');
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
}

// ── IPC from settings window ─────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('get-printers', async () => bridge.listPrinters());

ipcMain.handle('save-config', async (_, cfg) => {
    saveConfig(cfg);
    restartBridge(cfg);
    return { ok: true };
});

ipcMain.on('save-config-sync', (event, cfg) => {
    saveConfig(cfg);
    restartBridge(cfg);
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
            if (cfg.printFormat === 'txt') {
                bridge.printText(text, cfg.printer || null);
            } else {
                bridge.printText(bridge.buildReceiptPS(text, cols, cfg.lang || 'en'), cfg.printer || null);
            }
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ── Bridge ───────────────────────────────────────────────────────────────────
let pollTimer = null;

function restartBridge(cfg) {
    if (pollTimer) clearInterval(pollTimer);
    if (!cfg.token) { isRunning = false; updateTray(); return; }
    // env var override for local/staging dev; production otherwise
    cfg = { ...cfg, apiUrl: process.env.MENUS_API || 'https://menus.kitchen/api' };

    isRunning = true;
    updateTray();

    const run = () => bridge.poll(cfg, onOrderPrinted, onError);
    run();
    pollTimer = setInterval(run, 4000);
}

let notifTimer = null;
let pendingNotifs = [];

function onOrderPrinted(order) {
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
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    app.setLoginItemSettings({ openAtLogin: true });

    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('Menus Print Bridge');
    updateTray();

    const cfg = loadConfig();
    if (cfg.token) restartBridge(cfg);
    openSettings();
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in tray
