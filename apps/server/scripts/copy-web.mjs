// Copies the page and styles next to the compiled scripts (works on Windows, Mac and Linux).
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('web/dist', { recursive: true });
for (const f of ['index.html', 'style.css']) cpSync(`web/${f}`, `web/dist/${f}`);
