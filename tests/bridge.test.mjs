// Unit + integration tests for the print bridge core (bridge.js).
//
// Focus areas:
//   - LAN discovery IP math (ipToLong/longToIp/maskToPrefix/subnetHosts) - the
//     off-by-one-prone part of the new "Scan for printers" feature.
//   - triggerQuery - the arrival/accept switch that selects what the poll feed
//     returns (mirrors the staff KDS "Print when" setting).
//   - poll() over a real local HTTP server - proves the request URL carries the
//     right trigger query and Authorization header, and that the error/ok
//     callbacks fire as expected. No printer is ever touched (orders are empty).
//   - receipt builders - smoke tests so a formatting regression is caught.
//
// Run with:  npm test   (node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import bridge from '../bridge.js';
const {
    ipToLong, longToIp, maskToPrefix, subnetHosts, triggerQuery,
    localIPv4Interfaces, discoveryHosts,
    scanNetwork, buildReceipt, buildTestReceipt, escpos, poll,
} = bridge;

// ── IP helpers ───────────────────────────────────────────────────────────────
test('ipToLong / longToIp round-trip', () => {
    for (const ip of ['0.0.0.0', '192.168.1.100', '10.0.5.7', '255.255.255.255']) {
        assert.equal(longToIp(ipToLong(ip)), ip);
    }
    assert.equal(ipToLong('0.0.0.0'), 0);
    assert.equal(ipToLong('255.255.255.255'), 4294967295);
    // unsigned: top bit set must not come back negative
    assert.ok(ipToLong('192.168.1.1') > 0);
});

test('maskToPrefix counts mask bits', () => {
    assert.equal(maskToPrefix('255.255.255.0'),   24);
    assert.equal(maskToPrefix('255.255.0.0'),     16);
    assert.equal(maskToPrefix('255.255.255.128'), 25);
    assert.equal(maskToPrefix('255.255.255.255'), 32);
    assert.equal(maskToPrefix('0.0.0.0'),          0);
});

// ── subnet enumeration (the discovery sweep target list) ─────────────────────
test('subnetHosts: /24 yields .1 through .254, excluding network + broadcast', () => {
    const hosts = subnetHosts('192.168.1.50', '255.255.255.0');
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], '192.168.1.1');
    assert.equal(hosts[253], '192.168.1.254');
    assert.ok(!hosts.includes('192.168.1.0'),   'network address excluded');
    assert.ok(!hosts.includes('192.168.1.255'), 'broadcast address excluded');
    assert.ok(hosts.includes('192.168.1.50'),   'own IP is still probed');
});

test('subnetHosts: a wide /16 is clamped to the local /24 (no 65k sweep)', () => {
    const hosts = subnetHosts('10.0.5.7', '255.255.0.0');
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], '10.0.5.1');
    assert.equal(hosts[253], '10.0.5.254');
});

test('subnetHosts: missing netmask defaults to /24', () => {
    const hosts = subnetHosts('192.168.8.20', null);
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], '192.168.8.1');
    assert.equal(hosts[253], '192.168.8.254');
});

test('subnetHosts: /32 has no usable hosts', () => {
    assert.deepEqual(subnetHosts('192.168.1.5', '255.255.255.255'), []);
});

// ── multi-interface discovery (Win/Mac with VMs, VPNs, Wi-Fi+Ethernet) ───────
test('discoveryHosts: unions every interface subnet so the real LAN is covered', () => {
    const hosts = discoveryHosts([
        { address: '192.168.1.10', netmask: '255.255.255.0' },  // e.g. Wi-Fi
        { address: '10.0.0.5',     netmask: '255.255.255.0' },  // e.g. Ethernet
    ]);
    assert.equal(hosts.length, 254 + 254);
    assert.ok(hosts.includes('192.168.1.1'));
    assert.ok(hosts.includes('10.0.0.254'));
});

test('discoveryHosts: overlapping interfaces are de-duplicated', () => {
    const hosts = discoveryHosts([
        { address: '192.168.1.10', netmask: '255.255.255.0' },
        { address: '192.168.1.20', netmask: '255.255.255.0' }, // same /24
    ]);
    assert.equal(hosts.length, 254, 'same subnet is only swept once');
    assert.equal(new Set(hosts).size, hosts.length, 'no duplicate IPs');
});

test('discoveryHosts: no interfaces yields no hosts', () => {
    assert.deepEqual(discoveryHosts([]), []);
});

test('localIPv4Interfaces: returns an array of IPv4 interface records', () => {
    const ifaces = localIPv4Interfaces();
    assert.ok(Array.isArray(ifaces));
    for (const ni of ifaces) {
        assert.equal(typeof ni.address, 'string');
        assert.ok(!ni.internal, 'loopback excluded');
    }
});

// ── trigger switch (arrival vs accept) ───────────────────────────────────────
test('triggerQuery only sets ?trigger=accept for the accept setting', () => {
    assert.equal(triggerQuery({ trigger: 'accept' }),  '?trigger=accept');
    assert.equal(triggerQuery({ trigger: 'arrival' }), '');
    assert.equal(triggerQuery({ trigger: 'whatever' }), '');
    assert.equal(triggerQuery({}), '');
    assert.equal(triggerQuery(null), '');
    assert.equal(triggerQuery(undefined), '');
});

// ── scanNetwork smoke (real, bounded) ────────────────────────────────────────
test('scanNetwork resolves to an array of IP strings without hanging', async () => {
    const res = await scanNetwork(9100);
    assert.ok(Array.isArray(res));
    for (const ip of res) assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
});

// ── poll() against a real local server ───────────────────────────────────────
function startServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
    });
}

test('poll requests ?trigger=accept and sends the bearer token', async () => {
    let seenUrl = null, seenAuth = null;
    const { server, port } = await startServer((req, res) => {
        seenUrl  = req.url;
        seenAuth = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orders: [] }));
    });
    try {
        let okCalled = false, errCalled = false;
        await poll(
            { token: 'tok123', apiUrl: `http://127.0.0.1:${port}`, printerType: 'system', trigger: 'accept' },
            () => {}, () => { errCalled = true; }, () => { okCalled = true; },
        );
        assert.equal(seenUrl, '/print-queue?trigger=accept');
        assert.equal(seenAuth, 'Bearer tok123');
        assert.equal(okCalled, true, 'onOk fires on a clean empty poll');
        assert.equal(errCalled, false, 'no error on a clean empty poll');
    } finally {
        server.close();
    }
});

test('poll omits the query when trigger is arrival (default)', async () => {
    let seenUrl = null;
    const { server, port } = await startServer((req, res) => {
        seenUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orders: [] }));
    });
    try {
        await poll(
            { token: 't', apiUrl: `http://127.0.0.1:${port}`, printerType: 'system', trigger: 'arrival' },
            () => {}, () => {}, () => {},
        );
        assert.equal(seenUrl, '/print-queue');
    } finally {
        server.close();
    }
});

test('poll reports a non-200 feed response via onError without printing', async () => {
    const { server, port } = await startServer((req, res) => {
        res.writeHead(401);
        res.end('nope');
    });
    try {
        let errMsg = null, okCalled = false;
        await poll(
            { token: 'bad', apiUrl: `http://127.0.0.1:${port}`, printerType: 'system' },
            () => {}, m => { errMsg = m; }, () => { okCalled = true; },
        );
        assert.match(errMsg || '', /401/);
        assert.equal(okCalled, false);
    } finally {
        server.close();
    }
});

// ── receipt builders (regression smoke) ──────────────────────────────────────
test('buildReceipt renders header, items and total', () => {
    const txt = buildReceipt({
        restaurant_name: 'Cafe Test',
        order_number: 42,
        items: [{ quantity: 2, item_name: 'Flat White', unit_price_cents: 350 }],
    }, 48, 'en');
    assert.match(txt, /Cafe Test/);
    assert.match(txt, /Flat White/);
    assert.match(txt, /TOTAL/);
    assert.match(txt, /7\.00/); // 2 x 3.50
});

test('buildTestReceipt includes the sample item', () => {
    assert.match(buildTestReceipt(48), /Margherita Pizza/);
});

test('escpos returns an ESC/POS buffer starting with the init sequence', () => {
    const buf = escpos(buildTestReceipt(32), 32, 'en');
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf[0], 0x1b); // ESC
    assert.equal(buf[1], 0x40); // @  (initialise)
});
