// Receipt-formatting, transport, and full poll-lifecycle tests for bridge.js.
//
// These cover the bridge's actual job: turning an order into the right bytes
// for each printer family, pushing them over the wire, and acking the server -
// plus every failure branch in the poll loop (print fails, ack fails, bad
// payloads, network errors). Real loopback TCP/HTTP servers stand in for the
// printer and the Menus API, so nothing here touches a physical device.
//
// Run with:  npm test   (node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import bridge from '../bridge.js';
const { buildReceipt, buildReceiptPS, escpos, printThermal, wantsPS, poll } = bridge;

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── plain-text receipt (column layout) ───────────────────────────────────────
test('buildReceipt: header, optional rows, items, total, notes, thanks', () => {
    const txt = buildReceipt({
        restaurant_name: 'Ocean View',
        order_number: 7,
        table_name: 'Table 3',
        customer_name: 'Sam',
        source: 'uber_eats',
        notes: 'No onions',
        items: [
            { quantity: 2, item_name: 'Burger', unit_price_cents: 950 },
            { quantity: 1, item_name: 'Fries',  unit_price_cents: 400 },
        ],
    }, 48, 'en');

    assert.match(txt, /Ocean View/);
    assert.match(txt, /Order #7/);
    assert.match(txt, /Table 3/);
    assert.match(txt, /Sam/);
    assert.match(txt, /Uber Eats/);
    assert.match(txt, /Burger/);
    assert.match(txt, /TOTAL/);
    assert.match(txt, /23\.00/);          // 2*9.50 + 1*4.00
    assert.match(txt, /Note: No onions/);
    assert.match(txt, /Thank you!/);
});

test('buildReceipt: hubrise source prints the localised delivery label', () => {
    const txt = buildReceipt(
        { order_number: 1, source: 'hubrise', items: [] }, 48, 'es');
    assert.match(txt, /Delivery/);        // STRINGS.es.delivery
    assert.match(txt, /¡Gracias!/);
});

test('buildReceipt: every line fits the paper width (58mm / 32 cols)', () => {
    const txt = buildReceipt({
        restaurant_name: 'Cafe',
        order_number: 99,
        items: [{ quantity: 1, item_name: 'A ridiculously long menu item name that overflows', unit_price_cents: 1234 }],
    }, 32, 'en');
    for (const line of txt.split('\n')) {
        assert.ok(line.length <= 32, `line exceeds 32 cols: "${line}" (${line.length})`);
    }
});

test('buildReceipt: localised strings switch with lang', () => {
    const de = buildReceipt({ order_number: 5, items: [] }, 48, 'de');
    assert.match(de, /Bestellung #5/);
    assert.match(de, /GESAMT/);
    assert.match(de, /Danke!/);
});

// ── PostScript receipt (escaping + structure) ────────────────────────────────
test('buildReceiptPS: valid PS document wrapping the text', () => {
    const ps = buildReceiptPS('Hello World', 48, 'en');
    assert.match(ps, /^%!PS-Adobe-3\.0/);
    assert.match(ps, /\(Hello World\) show/);
    assert.match(ps, /showpage/);
});

test('buildReceiptPS: escapes parens and backslashes, octal-encodes Latin-1', () => {
    const ps = buildReceiptPS('a(b)c\\d é', 48, 'en');
    assert.match(ps, /\\\(/);   // escaped (
    assert.match(ps, /\\\)/);   // escaped )
    assert.match(ps, /\\\\/);   // escaped backslash
    assert.match(ps, /\\351/);  // é (0xE9 = 0o351)
});

test('buildReceiptPS: drops characters outside Latin-1', () => {
    const ps = buildReceiptPS('price 5€ 寿司', 48, 'en');
    assert.ok(!ps.includes('€'), '€ should not survive Latin-1');
    assert.ok(!ps.includes('寿'), 'CJK should not survive Latin-1');
    assert.match(ps, /\?/);     // replaced with ?
});

// ── ESC/POS thermal bytes (CP858 encoding) ───────────────────────────────────
test('escpos: string path emits init, codepage, body, feed and cut', () => {
    const buf = escpos('hi', 32, 'en');
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual([buf[0], buf[1]], [0x1b, 0x40]);      // ESC @
    assert.deepEqual([buf[2], buf[3], buf[4]], [0x1b, 0x74, 19]); // select CP858
    assert.ok(buf.includes(0x1d));                          // GS (cut)
});

test('escpos: accented + euro chars map to their CP858 bytes', () => {
    const buf = escpos('café 5€', 32, 'en');
    assert.ok(buf.includes(0x82), 'é -> 0x82');
    assert.ok(buf.includes(0xD5), '€ -> 0xD5');
    assert.ok(!buf.includes(0x3f), 'no ? fallback for representable chars');
});

test('escpos: unrepresentable glyphs fall back to ?', () => {
    const buf = escpos('寿司', 32, 'en');
    assert.ok(buf.includes(0x3f), 'CJK -> ? (0x3f)');
});

test('escpos: order path renders item names and the order number', () => {
    const buf = escpos({
        restaurant_name: 'Bistro',
        order_number: 12,
        items: [{ quantity: 1, item_name: 'Soup', unit_price_cents: 500 }],
    }, 32, 'en');
    assert.match(buf.toString('latin1'), /Bistro/);
    assert.match(buf.toString('latin1'), /Order #12/);
    assert.match(buf.toString('latin1'), /Soup/);
});

// ── wantsPS (format/platform gate) ───────────────────────────────────────────
test('wantsPS: txt format never uses PostScript', () => {
    assert.equal(wantsPS({ printFormat: 'txt' }), false);
});

test('wantsPS: ps format uses PostScript on POSIX but not on Windows', () => {
    const orig = process.platform;
    try {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        assert.equal(wantsPS({ printFormat: 'ps' }), true);
        Object.defineProperty(process, 'platform', { value: 'win32' });
        assert.equal(wantsPS({ printFormat: 'ps' }), false);
    } finally {
        Object.defineProperty(process, 'platform', { value: orig });
    }
});

// ── printThermal over real loopback TCP ──────────────────────────────────────
function startTcpSink() {
    const chunks = [];
    return new Promise(resolve => {
        const server = net.createServer(sock => sock.on('data', d => chunks.push(d)));
        server.listen(0, '127.0.0.1', () =>
            resolve({ server, port: server.address().port, bytes: () => Buffer.concat(chunks) }));
    });
}

test('printThermal: sends the exact bytes to the listening printer', async () => {
    const sink = await startTcpSink();
    try {
        const payload = Buffer.from([0x1b, 0x40, 0x41, 0x42, 0x43]);
        await printThermal(payload, '127.0.0.1', sink.port);
        await delay(50);
        assert.deepEqual(sink.bytes(), payload);
    } finally {
        sink.server.close();
    }
});

test('printThermal: rejects when nothing is listening on the port', async () => {
    // port 1 is privileged/unused on loopback -> connection refused fast
    await assert.rejects(
        printThermal(Buffer.from([0x00]), '127.0.0.1', 1),
        /./,
    );
});

// ── full poll lifecycle (queue -> print -> ack) ──────────────────────────────
function startHttp(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

// A fake Menus API: serves `orders` once (then empties), records ack POSTs, and
// lets a test force the ack status code.
function queueApi(orders, ackStatus = 200) {
    const acks = [];
    let served = false;
    const handler = (req, res) => {
        if (req.method === 'GET' && req.url.startsWith('/print-queue')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ orders: served ? [] : orders }));
            served = true;
        } else if (req.method === 'POST' && /\/print-queue\/\d+\/printed$/.test(req.url)) {
            acks.push(req.url);
            res.writeHead(ackStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: ackStatus === 200 }));
        } else {
            res.writeHead(404);
            res.end();
        }
    };
    return { handler, acks: () => acks };
}

const thermalOrder = (id) => ({
    id, order_number: id, restaurant_name: 'Cafe',
    items: [{ quantity: 1, item_name: 'Tea', unit_price_cents: 200 }],
});

test('poll: prints a thermal order and acks it (happy path)', async () => {
    const sink = await startTcpSink();
    const api = queueApi([thermalOrder(9100)]);
    const { server, port } = await startHttp(api.handler);
    try {
        let printed = null, err = null;
        await poll(
            { token: 't', apiUrl: `http://127.0.0.1:${port}`, printerType: 'thermal',
              thermalIp: '127.0.0.1', thermalPort: sink.port, cols: 32 },
            o => { printed = o; }, m => { err = m; }, () => {},
        );
        await delay(50);
        assert.equal(err, null, 'no error on happy path');
        assert.ok(printed && printed.id === 9100, 'onPrinted fired with the order');
        assert.equal(api.acks().length, 1, 'order was acked exactly once');
        assert.match(api.acks()[0], /\/print-queue\/9100\/printed/);
        const bytes = sink.bytes();
        assert.ok(bytes.length > 0, 'bytes reached the printer');
        assert.equal(bytes[0], 0x1b, 'ESC/POS init byte');
    } finally {
        server.close();
        sink.server.close();
    }
});

test('poll: a printed order whose ack fails is reported, not confirmed', async () => {
    const sink = await startTcpSink();
    const api = queueApi([thermalOrder(9101)], 500); // ack returns 500
    const { server, port } = await startHttp(api.handler);
    try {
        let printed = null, err = null;
        await poll(
            { token: 't', apiUrl: `http://127.0.0.1:${port}`, printerType: 'thermal',
              thermalIp: '127.0.0.1', thermalPort: sink.port, cols: 32 },
            o => { printed = o; }, m => { err = m; }, () => {},
        );
        await delay(50);
        assert.equal(printed, null, 'onPrinted does NOT fire when the ack fails');
        assert.match(err || '', /ack returned 500/);
    } finally {
        server.close();
        sink.server.close();
    }
});

test('poll: a print failure is reported with backoff, no ack attempted', async () => {
    const api = queueApi([thermalOrder(9102)]);
    const { server, port } = await startHttp(api.handler);
    try {
        let printed = null, err = null;
        await poll(
            // thermalPort 1 -> connection refused -> print throws
            { token: 't', apiUrl: `http://127.0.0.1:${port}`, printerType: 'thermal',
              thermalIp: '127.0.0.1', thermalPort: 1, cols: 32 },
            o => { printed = o; }, m => { err = m; }, () => {},
        );
        await delay(50);
        assert.equal(printed, null);
        assert.equal(api.acks().length, 0, 'never ack an order that did not print');
        assert.match(err || '', /#9102 failed \(attempt 1/);
    } finally {
        server.close();
    }
});

test('poll: an order inside its backoff window is skipped on the next poll', async () => {
    const order = thermalOrder(9200);
    // server always re-offers the same un-printable order
    const { server, port } = await startHttp((req, res) => {
        if (req.method === 'GET' && req.url.startsWith('/print-queue')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ orders: [order] }));
        } else { res.writeHead(404); res.end(); }
    });
    try {
        let errCount = 0;
        const cfg = { token: 't', apiUrl: `http://127.0.0.1:${port}`, printerType: 'thermal',
                      thermalIp: '127.0.0.1', thermalPort: 1, cols: 32 }; // port 1 -> refused
        await poll(cfg, () => {}, () => { errCount++; }, () => {});
        assert.equal(errCount, 1, 'first poll attempts the print and reports the failure');
        await poll(cfg, () => {}, () => { errCount++; }, () => {});
        assert.equal(errCount, 1, 'second poll skips the order while it backs off');
    } finally {
        server.close();
    }
});

test('poll: invalid JSON from the feed is surfaced via onError', async () => {
    const { server, port } = await startHttp((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('not json');
    });
    try {
        let err = null, okCalled = false;
        await poll(
            { token: 't', apiUrl: `http://127.0.0.1:${port}`, printerType: 'system' },
            () => {}, m => { err = m; }, () => { okCalled = true; },
        );
        assert.match(err || '', /invalid JSON/);
        assert.equal(okCalled, false);
    } finally {
        server.close();
    }
});

test('poll: an unexpected response shape is rejected', async () => {
    const { server, port } = await startHttp((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orders: 'nope' }));
    });
    try {
        let err = null;
        await poll(
            { token: 't', apiUrl: `http://127.0.0.1:${port}`, printerType: 'system' },
            () => {}, m => { err = m; }, () => {},
        );
        assert.match(err || '', /unexpected response shape/);
    } finally {
        server.close();
    }
});

test('poll: a dead API endpoint is reported as a failed poll', async () => {
    // nothing listening on this port
    let err = null;
    await poll(
        { token: 't', apiUrl: 'http://127.0.0.1:1', printerType: 'system' },
        () => {}, m => { err = m; }, () => {},
    );
    assert.match(err || '', /poll failed/);
});
