// Coverage for the bridge's lower-level building blocks: the column-width math
// behind every receipt layout, the language fallback for printers that can't
// render Arabic/CJK, the spawn wrapper under all system printing, and the
// system-printer enumeration. These underpin the higher-level builders already
// covered in printing.test.mjs.
//
// Run with:  npm test   (node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import bridge from '../bridge.js';
const {
    charWidth, strWidth, truncToWidth, center, row,
    printableLang, runCommand, listPrinters, buildReceipt,
} = bridge;

// ── column-width math (fullwidth/CJK aware) ──────────────────────────────────
test('charWidth: ASCII is 1 column, CJK/Hangul/fullwidth are 2', () => {
    assert.equal(charWidth('A'), 1);
    assert.equal(charWidth('9'), 1);
    assert.equal(charWidth('é'), 1);
    assert.equal(charWidth('寿'), 2);   // CJK ideograph
    assert.equal(charWidth('한'), 2);   // Hangul
    assert.equal(charWidth('Ａ'), 2);   // fullwidth Latin
});

test('strWidth: sums display columns, not code units', () => {
    assert.equal(strWidth('abc'), 3);
    assert.equal(strWidth('寿司'), 4);
    assert.equal(strWidth('A寿B'), 4);
});

test('truncToWidth: clips on display width without splitting a wide glyph', () => {
    assert.equal(truncToWidth('abcdef', 3), 'abc');
    assert.equal(truncToWidth('abcdef', 10), 'abcdef');
    // each CJK char is 2 cols: width budget 3 fits only the first
    assert.equal(truncToWidth('寿司喜', 3), '寿');
    assert.equal(truncToWidth('寿司喜', 4), '寿司');
});

test('center: left-pads to roughly centre, never over-pads', () => {
    const c = center('ab', 6);
    assert.ok(c.startsWith('  '));    // left-padded
    assert.equal(c.trim(), 'ab');     // content preserved
    assert.ok(strWidth(c) <= 6);      // never wider than the column count
});

test('row: left/right justify within the column count', () => {
    assert.equal(row('A', 'B', 10), 'A' + ' '.repeat(8) + 'B');
    // overflow: left is truncated so the whole row still fits exactly
    const r = row('longleft', 'B', 6);
    assert.equal(strWidth(r), 6);
    assert.match(r, /B$/);
});

test('buildReceipt: CJK item names keep every line within the paper width', () => {
    const txt = buildReceipt({
        restaurant_name: 'Sushi',
        order_number: 3,
        items: [
            { quantity: 2, item_name: '寿司の盛り合わせ特上', unit_price_cents: 1800 },
            { quantity: 1, item_name: '味噌汁',               unit_price_cents:  300 },
        ],
    }, 32, 'en');
    for (const line of txt.split('\n')) {
        assert.ok(strWidth(line) <= 32, `line exceeds 32 display cols: "${line}"`);
    }
    assert.match(txt, /TOTAL/);
    assert.match(txt, /39\.00/); // 2*18.00 + 1*3.00
});

// ── language fallback for non-Latin output ───────────────────────────────────
test('printableLang: Arabic and Chinese fall back to English, others pass through', () => {
    assert.equal(printableLang('ar'), 'en');
    assert.equal(printableLang('zh'), 'en');
    assert.equal(printableLang('es'), 'es');
    assert.equal(printableLang('en'), 'en');
    assert.equal(printableLang('de'), 'de');
});

// ── runCommand (spawn wrapper) ───────────────────────────────────────────────
test('runCommand: resolves on exit code 0', async () => {
    await runCommand(process.execPath, ['-e', '']);
});

test('runCommand: rejects with the exit code on failure', async () => {
    await assert.rejects(
        runCommand(process.execPath, ['-e', 'process.exit(3)']),
        /exit 3/,
    );
});

test('runCommand: rejects when the binary does not exist', async () => {
    await assert.rejects(
        runCommand('definitely-not-a-real-binary-xyz', []),
        /./,
    );
});

// ── system printer enumeration ───────────────────────────────────────────────
test('listPrinters: resolves to an array (never throws on this platform)', async () => {
    const printers = await listPrinters();
    assert.ok(Array.isArray(printers));
    for (const p of printers) assert.equal(typeof p, 'string');
});
