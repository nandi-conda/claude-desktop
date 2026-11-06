'use strict';
// Usage: node repack-asar.cjs <app.asar> <updater.cjs> <version> <zsync URL>
// Needs @electron/asar 3.x on NODE_PATH.
//
// Unpacks app.asar, adds updater.cjs as the new "main" (remembering the
// original one in package.json "appimageUpdater"), and packs it again, keeping
// the same files in app.asar.unpacked as before.

const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');

async function main() {
  const [archive, updater, version, zsyncUrl] = process.argv.slice(2);
  if (!archive || !updater || !version || !zsyncUrl) {
    console.error('usage: repack-asar.cjs <app.asar> <updater.cjs> <version> <zsync URL>');
    process.exit(2);
  }
  const unpackedDir = archive + '.unpacked';
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-'));

  // Paths that live outside the archive now must stay outside after repacking
  // (native modules and helper binaries can't be loaded from inside an asar).
  const unpacked = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else unpacked.push(path.relative(unpackedDir, p));
    }
  };
  if (fs.existsSync(unpackedDir)) walk(unpackedDir);

  asar.extractAll(archive, src);

  const pkgPath = path.join(src, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.appimageUpdater) throw new Error('app.asar already contains the updater');
  const originalMain = pkg.main || 'index.js';
  console.log(`package ${pkg.name}@${pkg.version}, main=${originalMain}, type=${pkg.type || 'commonjs'}`);
  console.log(`${unpacked.length} unpacked file(s)`);
  pkg.appimageUpdater = { originalMain, version, zsyncUrl };
  pkg.main = 'appimage-updater.cjs';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  fs.copyFileSync(updater, path.join(src, 'appimage-updater.cjs'));

  // asar matches `unpack` with minimatch against absolute source paths.
  const esc = (s) => s.replace(/[\\*?[\]{}()!+@,]/g, '\\$&');
  const globs = unpacked.map((rel) => esc(path.join(src, rel)));
  const options = {};
  if (globs.length === 1) options.unpack = globs[0];
  else if (globs.length > 1) options.unpack = `{${globs.join(',')}}`;

  fs.rmSync(archive);
  fs.rmSync(unpackedDir, { recursive: true, force: true });
  await asar.createPackageWithOptions(src, archive, options);
  fs.rmSync(src, { recursive: true, force: true });

  // Sanity check: everything that was unpacked before still is.
  const missing = unpacked.filter((rel) => !fs.existsSync(path.join(unpackedDir, rel)));
  if (missing.length) {
    throw new Error(`files no longer unpacked after repack:\n  ${missing.slice(0, 20).join('\n  ')}`);
  }
  asar.uncacheAll(); // asar caches the header read by extractAll
  asar.statFile(archive, 'appimage-updater.cjs'); // throws if missing
  const meta = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  if (meta.main !== 'appimage-updater.cjs') throw new Error('package.json main was not updated');
  console.log(`repacked ${archive} (${asar.listPackage(archive).length} entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
