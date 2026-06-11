'use strict';

const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');
const { exec, spawn } = require('child_process');
const fetch = require('node-fetch');

const DEFAULT_API = 'https://menus.kitchen/api';

const STRINGS = {
    en: { order: 'Order', total: 'TOTAL', thanks: 'Thank you!', note: 'Note', delivery: 'Delivery' },
    es: { order: 'Pedido', total: 'TOTAL', thanks: '¡Gracias!', note: 'Nota', delivery: 'Delivery' },
    pt: { order: 'Pedido', total: 'TOTAL', thanks: 'Obrigado!', note: 'Nota', delivery: 'Entrega' },
    fr: { order: 'Commande', total: 'TOTAL', thanks: 'Merci!', note: 'Note', delivery: 'Livraison' },
    de: { order: 'Bestellung', total: 'GESAMT', thanks: 'Danke!', note: 'Hinweis', delivery: 'Lieferung' },
    ca: { order: 'Comanda', total: 'TOTAL', thanks: 'Gràcies!', note: 'Nota', delivery: 'Lliurament' },
    ar: { order: 'طلب', total: 'المجموع', thanks: 'شكراً!', note: 'ملاحظة', delivery: 'توصيل' },
    zh: { order: '订单', total: '合计', thanks: '谢谢!', note: '备注', delivery: '外卖' },
};

// Arabic/Chinese receipt strings can't survive CP858 (thermal) or Latin-1 (PS)
// encoding, so those languages fall back to English on printed output.
function printableLang(lang) {
    return lang === 'ar' || lang === 'zh' ? 'en' : lang;
}

// Out-Printer on Windows renders plain text through the print pipeline —
// raw PostScript would come out as pages of source code, so PS is POSIX-only.
function wantsPS(cfg) {
    return cfg.printFormat !== 'txt' && process.platform !== 'win32';
}

// ── Column math (CJK/fullwidth chars occupy two columns) ────────────────────
function charWidth(ch) {
    const c = ch.codePointAt(0);
    return (
        (c >= 0x1100 && c <= 0x115f) ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe4f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6)
    ) ? 2 : 1;
}

function strWidth(s) {
    let w = 0;
    for (const ch of s) w += charWidth(ch);
    return w;
}

function truncToWidth(s, max) {
    let w = 0, out = '';
    for (const ch of s) {
        const cw = charWidth(ch);
        if (w + cw > max) break;
        out += ch;
        w += cw;
    }
    return out;
}

function center(s, cols) {
    return ' '.repeat(Math.max(0, Math.floor((cols - strWidth(s)) / 2))) + s;
}

function row(left, right, cols) {
    const gap = cols - strWidth(left) - strWidth(right);
    return gap > 0
        ? left + ' '.repeat(gap) + right
        : truncToWidth(left, cols - strWidth(right) - 1) + ' ' + right;
}

function listPrinters() {
    return new Promise(resolve => {
        if (process.platform === 'win32') {
            exec('powershell -Command "Get-Printer | Select-Object -ExpandProperty Name"',
                { encoding: 'utf8' },
                (err, stdout) => resolve(err ? [] : stdout.split('\n').map(s => s.trim()).filter(Boolean)));
        } else {
            exec('/usr/bin/lpstat -a 2>/dev/null || /usr/bin/lpstat -p 2>/dev/null',
                { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
                (err, stdout) => resolve(err ? [] : stdout.split('\n')
                    .map(l => l.match(/^(?:printer\s+|)(\S+)/)?.[1])
                    .filter(Boolean)));
        }
    });
}

function buildReceipt(order, cols = 48, lang = 'en') {
    const t       = STRINGS[lang] || STRINGS.en;
    const divider = '-'.repeat(cols);
    const fmt     = cents => (cents / 100).toFixed(2);
    const total   = (order.items || []).reduce((s, i) => s + i.quantity * (i.unit_price_cents || 0), 0);

    const lines = [
        center(order.restaurant_name || t.order, cols),
        center(t.order + ' #' + order.order_number, cols),
        order.table_name    ? center(order.table_name, cols)    : null,
        order.customer_name ? center(order.customer_name, cols) : null,
        order.source === 'uber_eats' ? center('Uber Eats', cols) :
        order.source === 'hubrise'   ? center(t.delivery, cols) : null,
        center(order.created_at || new Date().toLocaleString(), cols),
        divider,
    ].filter(l => l !== null);

    (order.items || []).forEach(item => {
        const left  = item.quantity + 'x ' + item.item_name;
        const right = fmt(item.quantity * (item.unit_price_cents || 0));
        lines.push(row(left, right, cols));
    });

    lines.push(divider);
    lines.push(row(t.total, fmt(total), cols));
    lines.push(divider);
    if (order.notes) { lines.push(t.note + ': ' + order.notes); lines.push(''); }
    lines.push(center(t.thanks, cols));
    lines.push(''); lines.push('');
    return lines.join('\n');
}

function buildReceiptPS(orderOrText, cols = 48, lang = 'en') {
    const text = typeof orderOrText === 'string'
        ? orderOrText
        : buildReceipt(orderOrText, cols, printableLang(lang));
    // PostScript strings are Latin-1 bytes: escape ()\ plus high chars as octal,
    // and drop anything outside Latin-1 (the font can't render it anyway).
    const escape = s => Array.from(s).map(ch => {
        if (ch === '\\') return '\\\\';
        if (ch === '(')  return '\\(';
        if (ch === ')')  return '\\)';
        const c = ch.codePointAt(0);
        if (c >= 32 && c < 127) return ch;
        if (c >= 160 && c <= 255) return '\\' + c.toString(8).padStart(3, '0');
        return '?';
    }).join('');
    const psLines = text.split('\n').map(l => `(${escape(l)}) show\nnewline`);

    return `%!PS-Adobe-3.0
/Courier findfont dup length dict begin
  { def } forall
  /Encoding ISOLatin1Encoding def
  currentdict
end
/Courier-L1 exch definefont pop
/Courier-L1 findfont 10 scalefont setfont
/leftmargin 40 def
/topmargin 780 def
/bottommargin 40 def
/lineheight 13 def
/y topmargin def
/newline {
  /y y lineheight sub def
  y bottommargin lt { showpage /y topmargin def } if
  leftmargin y moveto
} def
leftmargin y moveto
${psLines.join('\n')}
showpage
`;
}

// ── CP858 encoding (CP850 + € at 0xD5) — the ESC/POS Western European page ──
const CP858 =
    'ÇüéâäàåçêëèïîìÄÅ' + // 0x80
    'ÉæÆôöòûùÿÖÜø£Ø×ƒ' + // 0x90
    'áíóúñÑªº¿®¬½¼¡«»' + // 0xA0
    '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' + // 0xB0
    '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' + // 0xC0
    'ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀' + // 0xD0
    'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' + // 0xE0
    '­±‗¾¶§÷¸°¨·¹³²■ '; // 0xF0

const CP858_MAP = new Map(Array.from(CP858, (ch, i) => [ch, 0x80 + i]));

function encodeCP858(s) {
    const bytes = [];
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c < 0x80) bytes.push(c);
        else bytes.push(CP858_MAP.get(ch) ?? 0x3f); // '?'
    }
    return Buffer.from(bytes);
}

// ESC/POS helpers
const ESC = 0x1b, GS = 0x1d;
function escpos(orderOrText, cols = 32, lang = 'en') {
    const init     = Buffer.from([ESC, 0x40]);
    const codepage = Buffer.from([ESC, 0x74, 19]); // select CP858
    const feed     = Buffer.from([ESC, 0x64, 0x04]);
    const cut      = Buffer.from([GS,  0x56, 0x41, 0x00]);

    // if passed plain text (e.g. test receipt), wrap it simply
    if (typeof orderOrText === 'string') {
        return Buffer.concat([init, codepage, encodeCP858(orderOrText), feed, cut]);
    }
    const order = orderOrText;
    const t   = STRINGS[printableLang(lang)] || STRINGS.en;
    const fmt = cents => (cents / 100).toFixed(2);
    const total = (order.items || []).reduce((s, i) => s + i.quantity * (i.unit_price_cents || 0), 0);
    const divider = '-'.repeat(cols);

    const bold    = Buffer.from([ESC, 0x45, 0x01]);
    const boldOff = Buffer.from([ESC, 0x45, 0x00]);
    const alignC  = Buffer.from([ESC, 0x61, 0x01]);
    const alignL  = Buffer.from([ESC, 0x61, 0x00]);

    const parts = [init, codepage, alignC, bold];
    if (order.restaurant_name) { parts.push(encodeCP858(order.restaurant_name + '\n')); }
    parts.push(encodeCP858(`${t.order} #${order.order_number}\n`));
    parts.push(boldOff);
    if (order.table_name)    parts.push(encodeCP858(order.table_name + '\n'));
    if (order.customer_name) parts.push(encodeCP858(order.customer_name + '\n'));
    if (order.source === 'uber_eats') parts.push(encodeCP858('Uber Eats\n'));
    if (order.source === 'hubrise')   parts.push(encodeCP858(t.delivery + '\n'));
    parts.push(encodeCP858((order.created_at || new Date().toLocaleString()) + '\n'));
    parts.push(alignL);
    parts.push(encodeCP858(divider + '\n'));

    (order.items || []).forEach(item => {
        const left  = item.quantity + 'x ' + item.item_name;
        const right = fmt(item.quantity * (item.unit_price_cents || 0));
        parts.push(encodeCP858(row(left, right, cols) + '\n'));
    });

    parts.push(encodeCP858(divider + '\n'));
    parts.push(bold);
    parts.push(encodeCP858(row(t.total, fmt(total), cols) + '\n'));
    parts.push(boldOff);
    parts.push(encodeCP858(divider + '\n'));
    if (order.notes) parts.push(encodeCP858(t.note + ': ' + order.notes + '\n'));
    parts.push(alignC);
    parts.push(encodeCP858(t.thanks + '\n'));
    parts.push(feed);
    parts.push(cut);

    return Buffer.concat(parts);
}

function printThermal(data, ip, port = 9100) {
    return new Promise((resolve, reject) => {
        const sock = new net.Socket();
        const timeout = 8000;
        sock.setTimeout(timeout);
        sock.connect(port, ip, () => {
            sock.write(data, () => {
                sock.end();
                resolve();
            });
        });
        sock.on('timeout', () => { sock.destroy(); reject(new Error('thermal printer timeout')); });
        sock.on('error', reject);
    });
}

function buildTestReceipt(cols = 48) {
    return buildReceipt({
        order_number: 'TEST',
        table_name: 'Table 1',
        created_at: new Date().toLocaleString(),
        items: [
            { quantity: 2, item_name: 'Margherita Pizza', unit_price_cents: 1200 },
            { quantity: 1, item_name: 'Caesar Salad',     unit_price_cents:  900 },
        ],
    }, cols);
}

function runCommand(cmd, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args);
        let stderr = '';
        p.stderr.on('data', d => { stderr += d; });
        p.on('error', reject);
        p.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`${path.basename(cmd)} failed (exit ${code})${stderr ? ': ' + stderr.trim() : ''}`));
        });
    });
}

async function printText(text, printerName) {
    const ext = text.startsWith('%!PS') ? '.ps' : '.txt';
    const tmp = path.join(os.tmpdir(), `menus-${Date.now()}${ext}`);
    fs.writeFileSync(tmp, text, 'utf8');
    try {
        if (process.platform === 'win32') {
            const cmd = printerName
                ? `Out-Printer -Name '${printerName.replace(/'/g, "''")}' -InputObject (Get-Content -Raw '${tmp.replace(/'/g, "''")}')`
                : `Out-Printer -InputObject (Get-Content -Raw '${tmp.replace(/'/g, "''")}')`;
            await runCommand('powershell', ['-Command', cmd]);
        } else {
            const args = printerName ? ['-P', printerName, tmp] : [tmp];
            await runCommand('/usr/bin/lpr', args);
        }
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

// Orders that fail to print are retried with exponential backoff (capped at
// 60s) instead of on every 4s poll, so a broken printer doesn't spam retries.
const retryState = new Map(); // order.id -> { failures, nextAttempt }

async function poll(cfg, onPrinted, onError, onOk) {
    const apiBase = cfg.apiUrl || DEFAULT_API;
    let res;
    try {
        res = await fetch(`${apiBase}/print-queue`, {
            headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
            timeout: 20000,
        });
    } catch (e) {
        onError?.('poll failed: ' + e.message);
        return;
    }

    if (!res.ok) { onError?.('poll returned ' + res.status); return; }

    let orders;
    try {
        ({ orders } = await res.json());
    } catch (e) {
        onError?.('poll returned invalid JSON: ' + e.message);
        return;
    }
    if (!Array.isArray(orders)) { onError?.('poll returned unexpected response shape'); return; }

    onOk?.();

    const queuedIds = new Set(orders.map(o => o.id));
    for (const id of retryState.keys()) {
        if (!queuedIds.has(id)) retryState.delete(id);
    }

    for (const order of orders) {
        const state = retryState.get(order.id);
        if (state && Date.now() < state.nextAttempt) continue;
        try {
            if (cfg.printerType === 'thermal') {
                const cols = cfg.cols || 32;
                await printThermal(escpos(order, cols, cfg.lang || 'en'), cfg.thermalIp, cfg.thermalPort || 9100);
            } else {
                const cols = cfg.cols || 48;
                const lang = cfg.lang || 'en';
                const text = wantsPS(cfg)
                    ? buildReceiptPS(order, cols, lang)
                    : buildReceipt(order, cols, lang);
                await printText(text, cfg.printer || null);
            }
            const ack = await fetch(`${apiBase}/print-queue/${order.id}/printed`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
                timeout: 20000,
            });
            if (!ack.ok) throw new Error(`printed but ack returned ${ack.status} — server will re-send it`);
            retryState.delete(order.id);
            onPrinted?.(order);
        } catch (e) {
            const failures = (state?.failures || 0) + 1;
            const delay = Math.min(60000, 4000 * 2 ** failures);
            retryState.set(order.id, { failures, nextAttempt: Date.now() + delay });
            onError?.(`order #${order.order_number} failed (attempt ${failures}, retry in ${Math.round(delay / 1000)}s): ` + e.message);
        }
    }
}

module.exports = { listPrinters, buildReceipt, buildReceiptPS, buildTestReceipt, printText, printThermal, escpos, poll, wantsPS };
