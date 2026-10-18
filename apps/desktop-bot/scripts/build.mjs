// Bundles the app with esbuild so the bot can use the shared Family AI core and the stream
// copilot directly from this repo. Works the same on Windows, Mac and Linux.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const alias = {
  '@familiai/core': '../../packages/core/src/index.ts',
  '@stream': '../stream-copilot/src',
};
const node = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', // node-llama-cpp has native parts, so it is loaded at runtime instead of bundled.
  external: ['electron', 'node-llama-cpp'], alias, sourcemap: 'linked', logLevel: 'warning' };

await build({ ...node, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await build({ ...node, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js' });
await build({ bundle: true, platform: 'browser', target: 'chrome120', format: 'iife', entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', logLevel: 'warning' });

mkdirSync('dist/renderer', { recursive: true });
mkdirSync('dist/remote', { recursive: true });
for (const f of ['index.html', 'style.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
cpSync('src/remote/remote.html', 'dist/remote/remote.html');
console.log('build ok');
