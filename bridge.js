'use strict';

const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
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

function listPrinters() {
    try {
        if (process.platform === 'win32') {
            const out = execSync(
                'powershell -Command "Get-Printer | Select-Object -ExpandProperty Name"',
                { encoding: 'utf8' }
            );
            return out.split('\n').map(s => s.trim()).filter(Boolean);
        } else {
            const out = execSync('/usr/bin/lpstat -a 2>/dev/null || /usr/bin/lpstat -p 2>/dev/null', { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
            return out.split('\n')
                .map(l => l.match(/^(?:printer\s+|)(\S+)/)?.[1])
                .filter(Boolean);
        }
    } catch {
        return [];
    }
}

function buildReceipt(order, cols = 48, lang = 'en') {
    const t       = STRINGS[lang] || STRINGS.en;
    const center  = s => ' '.repeat(Math.max(0, Math.floor((cols - s.length) / 2))) + s;
    const divider = '-'.repeat(cols);
    const fmt     = cents => (cents / 100).toFixed(2);
    const total   = (order.items || []).reduce((s, i) => s + i.quantity * (i.unit_price_cents || 0), 0);

    const lines = [
        center(order.restaurant_name || t.order),
        center(t.order + ' #' + order.order_number),
        order.table_name    ? center(order.table_name)    : null,
        order.customer_name ? center(order.customer_name) : null,
        order.source === 'uber_eats' ? center('Uber Eats') :
        order.source === 'hubrise'   ? center(t.delivery) : null,
        center(order.created_at || new Date().toLocaleString()),
        divider,
    ].filter(l => l !== null);

    (order.items || []).forEach(item => {
        const left  = item.quantity + 'x ' + item.item_name;
        const right = fmt(item.quantity * (item.unit_price_cents || 0));
        const gap   = cols - left.length - right.length;
        lines.push(gap > 0 ? left + ' '.repeat(gap) + right : left.slice(0, cols - right.length - 1) + ' ' + right);
    });

    lines.push(divider);
    const tl = t.total, tv = fmt(total);
    lines.push(tl + ' '.repeat(Math.max(1, cols - tl.length - tv.length)) + tv);
    lines.push(divider);
    if (order.notes) { lines.push(t.note + ': ' + order.notes); lines.push(''); }
    lines.push(center(t.thanks));
    lines.push(''); lines.push('');
    return lines.join('\n');
}

function buildReceiptPS(orderOrText, cols = 48, lang = 'en') {
    const text = typeof orderOrText === 'string' ? orderOrText : buildReceipt(orderOrText, cols, lang);
    const escape = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const psLines = text.split('\n').map(l => `(${escape(l)}) show\nnewline`);

    return `%!PS-Adobe-3.0
/Courier findfont 10 scalefont setfont
/leftmargin 40 def
/topmargin 780 def
/lineheight 13 def
/y topmargin def
/newline { /y y lineheight sub def leftmargin y moveto } def
leftmargin y moveto
${psLines.join('\n')}
showpage
`;
}

// ESC/POS helpers
const ESC = 0x1b, GS = 0x1d;
function escpos(orderOrText, cols = 32, lang = 'en') {
    // if passed plain text (e.g. test receipt), wrap it simply
    if (typeof orderOrText === 'string') {
        const init = Buffer.from([ESC, 0x40]);
        const feed = Buffer.from([ESC, 0x64, 0x04]);
        const cut  = Buffer.from([GS,  0x56, 0x41, 0x00]);
        return Buffer.concat([init, Buffer.from(orderOrText, 'utf8'), feed, cut]);
    }
    const order = orderOrText;
    const t   = STRINGS[lang] || STRINGS.en;
    const fmt = cents => (cents / 100).toFixed(2);
    const total = (order.items || []).reduce((s, i) => s + i.quantity * (i.unit_price_cents || 0), 0);

    const center = s => {
        const pad = Math.max(0, Math.floor((cols - s.length) / 2));
        return ' '.repeat(pad) + s;
    };
    const divider = '-'.repeat(cols);
    const row = (left, right) => {
        const gap = cols - left.length - right.length;
        return gap > 0 ? left + ' '.repeat(gap) + right : left.slice(0, cols - right.length - 1) + ' ' + right;
    };

    const lines = [];
    const push = s => lines.push(Buffer.from(s + '\n', 'utf8'));

    // Init
    const init    = Buffer.from([ESC, 0x40]);
    const bold    = Buffer.from([ESC, 0x45, 0x01]);
    const boldOff = Buffer.from([ESC, 0x45, 0x00]);
    const alignC  = Buffer.from([ESC, 0x61, 0x01]);
    const alignL  = Buffer.from([ESC, 0x61, 0x00]);
    const feed    = Buffer.from([ESC, 0x64, 0x04]);
    const cut     = Buffer.from([GS,  0x56, 0x41, 0x00]);

    const parts = [init, alignC, bold];
    if (order.restaurant_name) { parts.push(Buffer.from(order.restaurant_name + '\n', 'utf8')); }
    parts.push(Buffer.from(`${t.order} #${order.order_number}\n`, 'utf8'));
    parts.push(boldOff);
    if (order.table_name)    parts.push(Buffer.from(order.table_name + '\n', 'utf8'));
    if (order.customer_name) parts.push(Buffer.from(order.customer_name + '\n', 'utf8'));
    if (order.source === 'uber_eats') parts.push(Buffer.from('Uber Eats\n', 'utf8'));
    if (order.source === 'hubrise')   parts.push(Buffer.from(t.delivery + '\n', 'utf8'));
    parts.push(Buffer.from((order.created_at || new Date().toLocaleString()) + '\n', 'utf8'));
    parts.push(alignL);
    parts.push(Buffer.from(divider + '\n', 'utf8'));

    (order.items || []).forEach(item => {
        const left  = item.quantity + 'x ' + item.item_name;
        const right = fmt(item.quantity * (item.unit_price_cents || 0));
        parts.push(Buffer.from(row(left, right) + '\n', 'utf8'));
    });

    parts.push(Buffer.from(divider + '\n', 'utf8'));
    parts.push(bold);
    parts.push(Buffer.from(row(t.total, fmt(total)) + '\n', 'utf8'));
    parts.push(boldOff);
    parts.push(Buffer.from(divider + '\n', 'utf8'));
    if (order.notes) parts.push(Buffer.from(t.note + ': ' + order.notes + '\n', 'utf8'));
    parts.push(alignC);
    parts.push(Buffer.from(t.thanks + '\n', 'utf8'));
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

function printText(text, printerName) {
    const tmp = path.join(os.tmpdir(), `menus-${Date.now()}.ps`);
    fs.writeFileSync(tmp, text, 'utf8');
    try {
        if (process.platform === 'win32') {
            const cmd = printerName
                ? `Out-Printer -Name '${printerName.replace(/'/g, "''")}' -InputObject (Get-Content -Raw '${tmp.replace(/'/g, "''")}')`
                : `Out-Printer -InputObject (Get-Content -Raw '${tmp.replace(/'/g, "''")}')`;
            spawnSync('powershell', ['-Command', cmd], { stdio: 'ignore' });
        } else {
            const args = printerName ? ['-P', printerName, tmp] : [tmp];
            const result = spawnSync('lpr', args, { encoding: 'utf8' });
            if (result.stderr) console.error('[lpr stderr]', result.stderr);
            if (result.status !== 0) console.error('[lpr exit]', result.status);
        }
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

async function poll(cfg, onPrinted, onError) {
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

    const { orders } = await res.json();
    for (const order of orders) {
        try {
            if (cfg.printerType === 'thermal') {
                const cols = cfg.cols || 32;
                await printThermal(escpos(order, cols, cfg.lang || 'en'), cfg.thermalIp, cfg.thermalPort || 9100);
            } else {
                printText(buildReceiptPS(order, cfg.cols || 48, cfg.lang || 'en'), cfg.printer || null);
            }
            await fetch(`${apiBase}/print-queue/${order.id}/printed`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
                timeout: 20000,
            });
            onPrinted?.(order);
        } catch (e) {
            onError?.(`order #${order.order_number} failed: ` + e.message);
        }
    }
}

module.exports = { listPrinters, buildReceipt, buildReceiptPS, buildTestReceipt, printText, printThermal, escpos, poll };
