/**
 * Patches pglite-prisma-adapter to fix Bytes column handling.
 *
 * The adapter's parsePgBytes returns Uint8Array, which serializes as a JSON
 * object {"0":104,"1":101,...} across the JS-WASM boundary to the Prisma
 * query engine. The engine expects either a plain number[] or a base64 string.
 *
 * Fix: replace Uint8Array.from with Array.from so the result is a plain number[].
 *
 * Upstream issue: https://github.com/nicksrandall/pglite-prisma-adapter
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// This file also ships in the self-host package's dist/. Resolve from the
// consumer so npm-hoisted and pnpm-linked dependencies use the same fix.
const root = path.resolve(__dirname, '..');
const files = new Set();
for (const consumer of [root, path.join(root, 'packages/happy-server')]) {
    let entry;
    try {
        entry = createRequire(path.join(consumer, 'package.json')).resolve('pglite-prisma-adapter');
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') continue;
        throw error;
    }
    for (const name of ['index.mjs', 'index.cjs']) {
        files.add(path.join(path.dirname(entry), name));
    }
}

let patched = 0;

for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, 'utf8');
    const original = content;

    // Replace Uint8Array.from with Array.from in parsePgBytes and normalizeByteaArray
    content = content.replace(
        /Uint8Array\.from\(\s*\{\s*length:\s*hexString\.length\s*\/\s*2\s*\}/g,
        'Array.from({ length: hexString.length / 2 }'
    );

    if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        patched++;
    }
}

if (patched > 0) {
    console.log(`[patch] Fixed pglite-prisma-adapter Bytes column handling (${patched} file(s))`);
}
