'use strict';

// Run against an installed tarball, outside the monorepo: workspace postinstall
// patches dependencies and can otherwise hide a broken standalone installation.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const installed = createRequire(path.join(root, 'package.json'));
  const { PrismaClient } = installed('@prisma/client');
  const { PGlite } = installed('@electric-sql/pglite');
  const cjs = installed.resolve('pglite-prisma-adapter');
  const esm = path.join(path.dirname(cjs), 'index.mjs');
  for (const [format, { PrismaPGlite }] of [
    ['cjs', installed('pglite-prisma-adapter')],
    ['esm', await import(pathToFileURL(esm).href)],
  ]) {
    const database = new PGlite();
    const client = new PrismaClient({ adapter: new PrismaPGlite(database) });
    try {
      await database.exec('CREATE TABLE "Machine" (id TEXT PRIMARY KEY, metadata TEXT, "dataEncryptionKey" BYTEA)');
      const values = [null, Buffer.alloc(0), Buffer.from([0, 128, 255]), Buffer.from(Array.from({ length: 64 }, (_, i) => i))];
      for (let i = 0; i < values.length; i++) {
        await database.query('INSERT INTO "Machine" VALUES ($1, $2, $3)', [String(i), 'encrypted-metadata-fixture', values[i]]);
      }
      const select = { id: true, metadata: true, dataEncryptionKey: true };
      const rows = await client.machine.findMany({ orderBy: { id: 'asc' }, select });
      assert.equal(rows.length, values.length);
      for (let i = 0; i < values.length; i++) {
        const row = await client.machine.findUnique({ where: { id: String(i) }, select });
        for (const actual of [row.dataEncryptionKey, rows[i].dataEncryptionKey]) {
          if (values[i] === null) assert.equal(actual, null);
          else assert.deepEqual(Buffer.from(actual), values[i]);
        }
      }
      console.log(`${format}: Prisma machine list/detail preserve null, empty and two nonempty Bytes values`);
    } finally {
      await client.$disconnect();
      await database.close();
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
