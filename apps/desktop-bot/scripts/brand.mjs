// The bot's name lives in ONE file: brand.json. To rename the bot or change the author, edit that
// file and run `npm run brand` (the build runs it too). It copies the name into package.json,
// where the packager needs it: app name, author/publisher, copyright, installer and icon.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const file = (name) => new URL(`../${name}`, import.meta.url);

export function readBrand() {
  return JSON.parse(readFileSync(file('brand.json'), 'utf8'));
}

/** package.json as it should be for the current brand.json. */
export function brandedPackage(pkg, b = readBrand()) {
  const out = structuredClone(pkg);
  out.productName = b.name;
  out.author = { name: b.author, email: b.email };
  out.bin = { [b.command]: 'bin/cli.mjs', [b.oldCommand]: 'bin/familyai.mjs' };
  out.build = {
    ...out.build,
    appId: b.appId,
    productName: b.name,
    copyright: b.copyright,
    // A ready-made .ico: the packager then skips its own picture conversion, which can run out
    // of memory on some computers ("WebAssembly.Memory(): could not allocate memory").
    win: { ...out.build.win, icon: 'build/icon.ico' },
    nsis: { ...out.build.nsis, shortcutName: b.name, artifactName: `${b.name}-Setup-\${version}.\${ext}` },
    linux: { ...out.build.linux, executableName: b.command },
  };
  return out;
}

/** Rewrites package.json when it does not match brand.json. Returns true when it changed. */
export function syncPackage() {
  const current = readFileSync(file('package.json'), 'utf8');
  const next = `${JSON.stringify(brandedPackage(JSON.parse(current)), null, 2)}\n`;
  if (next !== current) writeFileSync(file('package.json'), next);
  return next !== current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(syncPackage() ? 'package.json updated from brand.json' : 'package.json already matches brand.json');
}
