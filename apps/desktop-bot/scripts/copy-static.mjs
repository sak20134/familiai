// Copies the HTML and CSS next to the compiled renderer script (works on Windows, Mac and Linux).
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/renderer', { recursive: true });
for (const f of ['index.html', 'style.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
console.log('copied static files');
