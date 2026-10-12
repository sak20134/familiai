// Starts the copilot: connects to OBS and Twitch (whichever are set up in .env), then listens
// for commands typed here. Run with: npm start (inside apps/stream-copilot).

import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Copilot } from './copilot';
import { ObsClient } from './obs/client';
import { TwitchClient } from './twitch/client';

function loadEnv(): void {
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

async function main(): Promise<void> {
  loadEnv();
  const env = process.env;
  const say = (text: string) => console.log(`\n  ${text}`);

  let obs: ObsClient | undefined;
  if (env.OBS_URL || env.OBS_PASSWORD) {
    const client = new ObsClient();
    try {
      await client.connect(env.OBS_URL || 'ws://127.0.0.1:4455', env.OBS_PASSWORD || undefined);
      obs = client;
      const { current } = await client.scenes();
      say(`OBS connected. Live scene: ${current || '(none)'}.`);
    } catch (err) {
      say(`OBS: ${(err as Error).message}`);
    }
  } else {
    say('OBS is not set up yet (see .env.example). Chat features still work.');
  }

  let twitch: TwitchClient | undefined;
  const copilot = new Copilot({ ...(obs ? { obs } : {}), notify: say });
  if (env.TWITCH_CLIENT_ID && env.TWITCH_TOKEN && env.TWITCH_CHANNEL) {
    const client = new TwitchClient({ clientId: env.TWITCH_CLIENT_ID, token: env.TWITCH_TOKEN.replace(/^oauth:/, ''), channel: env.TWITCH_CHANNEL });
    copilot.attach({ chat: client });
    try {
      await client.connect((m) => {
        void copilot.onChat(m).then((action) => {
          if (action.kind !== 'allow') say(`[mod] ${m.displayName}: ${action.kind} (${action.reason})`);
        });
      });
      twitch = client;
      say(`Twitch chat connected: #${env.TWITCH_CHANNEL}.`);
    } catch (err) {
      say(`Twitch: ${(err as Error).message}`);
    }
  } else {
    say('Twitch is not set up yet (see .env.example).');
  }

  setInterval(() => void copilot.tick(), 60_000).unref();

  say('Type what you want: "switch to BRB", "mute mic", "timeout name 5 minutes", "start a poll: best snack? chips or popcorn",');
  say('"start a giveaway for a game key", "draw winner", "summary". Also: "pending", "approve req1", "reject req1", "autopilot on", "quit".');

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\n> ' });
  rl.prompt();
  // One command at a time, in order: a quick burst must never run "end poll" before "start poll".
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    queue = queue.then(async () => {
      const text = line.trim();
      let m: RegExpMatchArray | null;
      if (!text) {
        // nothing
      } else if (/^(quit|exit)$/i.test(text)) {
        obs?.close();
        twitch?.close();
        rl.close();
        return;
      } else if (/^pending$/i.test(text)) {
        const list = copilot.pendingApprovals();
        say(list.length ? list.map((p) => `${p.id}: ${p.summary}`).join('\n  ') : 'Nothing is waiting for you.');
      } else if ((m = text.match(/^(approve|reject)\s+(\S+)$/i))) {
        const out = m[1]!.toLowerCase() === 'approve' ? await copilot.approve(m[2]!) : copilot.reject(m[2]!);
        say(out.kind === 'failed' ? `Failed: ${out.text}` : out.kind === 'done' ? out.text : '');
      } else if ((m = text.match(/^autopilot\s+(on|off)$/i))) {
        copilot.autopilot = m[1]!.toLowerCase() === 'on';
        say(copilot.autopilot ? 'Autopilot on: timeouts and going live no longer ask. Bans and ending the stream still always ask.' : 'Autopilot off.');
      } else {
        const out = await copilot.run(text);
        if (out.kind === 'needs_approval') say(`Waiting for your OK: ${out.summary}. Type "approve ${out.id}" or "reject ${out.id}".`);
        else say(out.kind === 'failed' ? `Couldn't: ${out.text}` : out.text);
      }
      rl.prompt();
    });
  });
}

void main();
