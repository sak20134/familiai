// Run by the installer: puts the bot's brain in place before the first start, so the bot can
// think as soon as it opens. Safe to run again: it does nothing when the brain is already there,
// and continues an interrupted setup where it stopped.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { BRAIN_MODEL, downloadVerified, isVerified } from './agent/brain';

async function main(): Promise<void> {
  const dir = join(process.env.FAMILYAI_HOME || join(homedir(), '.familyai'), 'models');
  if (isVerified(BRAIN_MODEL, dir)) {
    console.log('  The brain is ready.');
    return;
  }
  let shown = -1;
  await downloadVerified(BRAIN_MODEL, dir, {
    onProgress: (done, total) => {
      const pct = Math.floor((done / total) * 100);
      if (pct >= shown + 5) {
        shown = pct;
        process.stdout.write(`\r  Setting up the brain: ${pct}%   `);
      }
    },
  });
  console.log('\r  The brain is ready.            ');
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}`);
  console.error('  The bot will finish setting up its brain the next time it starts.');
  process.exitCode = 1;
});
