#!/usr/bin/env node
'use strict';

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { execSync, spawnSync } = require('child_process');
const fetch   = require('node-fetch');

// ── Config ─────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(os.homedir(), '.menus-bridge.json');
const API_BASE    = process.env.MENUS_API ?? 'https://menus.kitchen/api';
const POLL_MS     = 4000;

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    return {};
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── Printer discovery ───────────────────────────────────────────────────────
function listPrinters() {
    try {
        if (process.platform === 'win32') {
            const out = execSync(
                'powershell -Command "Get-Printer | Select-Object -ExpandProperty Name"',
                { encoding: 'utf8' }
            );
            return out.split('\n').map(s => s.trim()).filter(Boolean);
        } else {
            const out = execSync('lpstat -a 2>/dev/null || lpstat -p 2>/dev/null', { encoding: 'utf8' });
            return out.split('\n')
                .map(l => l.match(/^(?:printer\s+|)(\S+)/)?.[1])
                .filter(Boolean);
        }
    } catch {
        return [];
    }
}

// ── Receipt builder ─────────────────────────────────────────────────────────
function buildReceipt(order, cols = 48) {
    const center  = s => ' '.repeat(Math.max(0, Math.floor((cols - s.length) / 2))) + s;
    const divider = '-'.repeat(cols);
    const fmt     = cents => (cents / 100).toFixed(2);
    const total   = (order.items || []).reduce((s, i) => s + i.quantity * (i.unit_price_cents || 0), 0);

    const lines = [
        center(order.restaurant_name || 'Order'),
        center('Order #' + order.order_number),
        order.table_name   ? center(order.table_name)    : '',
        order.customer_name ? center(order.customer_name) : '',
        center(order.created_at || new Date().toLocaleString()),
        divider,
    ];

    (order.items || []).forEach(item => {
        const left  = item.quantity + 'x ' + item.item_name;
        const right = fmt(item.quantity * (item.unit_price_cents || 0));
        const gap   = cols - left.length - right.length;
        lines.push(gap > 0 ? left + ' '.repeat(gap) + right : left.slice(0, cols - right.length - 1) + ' ' + right);
    });

    lines.push(divider);
    const tl = 'TOTAL', tv = fmt(total);
    lines.push(tl + ' '.repeat(Math.max(1, cols - tl.length - tv.length)) + tv);
    lines.push(divider);
    if (order.notes) { lines.push('Note: ' + order.notes); lines.push(''); }
    lines.push(center('Thank you!'));
    lines.push(''); lines.push('');
    return lines.join('\n');
}

// ── Print ───────────────────────────────────────────────────────────────────
function printText(text, printerName) {
    const tmp = path.join(os.tmpdir(), `menus-order-${Date.now()}.txt`);
    fs.writeFileSync(tmp, text, 'utf8');

    try {
        if (process.platform === 'win32') {
            const cmd = printerName
                ? `Out-Printer -Name '${printerName.replace(/'/g, "''")}' -InputObject (Get-Content -Raw '${tmp.replace(/'/g, "''")}')`
                : `Out-Printer -InputObject (Get-Content -Raw '${tmp.replace(/'/g, "''")}')`;
            spawnSync('powershell', ['-Command', cmd], { stdio: 'ignore' });
        } else {
            const args = printerName ? ['-P', printerName, tmp] : [tmp];
            spawnSync('lpr', args, { stdio: 'ignore' });
        }
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

// ── Poll loop ───────────────────────────────────────────────────────────────
async function poll(cfg) {
    let res;
    try {
        res = await fetch(`${API_BASE}/print-queue`, {
            headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
            timeout: 8000,
        });
    } catch (e) {
        console.error('[bridge] poll error:', e.message);
        return;
    }

    if (!res.ok) {
        console.error('[bridge] poll returned', res.status);
        return;
    }

    const { orders } = await res.json();
    for (const order of orders) {
        console.log(`[bridge] printing order #${order.order_number}…`);
        try {
            const text = buildReceipt(order, cfg.cols || 48);
            printText(text, cfg.printer || null);

            await fetch(`${API_BASE}/print-queue/${order.id}/printed`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
                timeout: 8000,
            });
            console.log(`[bridge] order #${order.order_number} printed ✓`);
        } catch (e) {
            console.error(`[bridge] failed to print order #${order.order_number}:`, e.message);
        }
    }
}

// ── Setup wizard ────────────────────────────────────────────────────────────
async function setup() {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(resolve => rl.question(q, resolve));

    console.log('\n🖨️  Menus Print Bridge Setup\n');

    const token = (await ask('Paste your print token from the Menus dashboard: ')).trim();
    if (!token) { console.error('Token required.'); process.exit(1); }

    const printers = listPrinters();
    let printer = '';
    if (printers.length) {
        console.log('\nAvailable printers:');
        printers.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
        const choice = (await ask(`\nChoose printer number (or press Enter for default): `)).trim();
        printer = printers[parseInt(choice) - 1] || '';
    }

    const colsInput = (await ask('Paper width — 32 (58mm) or 48 (80mm) chars [48]: ')).trim();
    const cols = parseInt(colsInput) || 48;

    rl.close();

    const cfg = { token, printer, cols };
    saveConfig(cfg);
    console.log('\n✅ Config saved. Starting bridge…\n');
    return cfg;
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
    let cfg = loadConfig();

    if (!cfg.token || process.argv.includes('--setup')) {
        cfg = await setup();
    }

    console.log(`[bridge] polling ${API_BASE} every ${POLL_MS / 1000}s`);
    console.log(`[bridge] printer: ${cfg.printer || 'system default'}`);

    poll(cfg);
    setInterval(() => poll(cfg), POLL_MS);
})();
