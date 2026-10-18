#!/usr/bin/env node
// familyai: start, stop and talk to the desktop bot from a terminal, like `ollama`.
//
//   familyai start            start the bot (it floats on your desktop)
//   familyai stop             close the bot
//   familyai status           is it running, what is connected, what is waiting
//   familyai talk [words]     say something (no words: chat until you type "exit")
//   familyai pending          what is waiting for an OK
//   familyai approve <id>     OK a waiting request      familyai reject <id>
//   familyai halt             pull the stop switch (everything stops until "resume")
//   familyai doctor           check that everything needed is installed
//   familyai update           get the newest version
//
// It talks to the running bot on 127.0.0.1 only, using a key the bot writes into your own
// data folder (~/.familyai/cli.json), so other people and websites cannot use it.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const APP_DIR = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const DATA_DIR = process.env.FAMILYAI_HOME || join(homedir(), '.familyai');
const CLI_FILE = join(DATA_DIR, 'cli.json');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => paint(32, s);
const red = (s) => paint(31, s);
const amber = (s) => paint(33, s);
const dim = (s) => paint(2, s);

function readCli() {
  try {
    const c = JSON.parse(readFileSync(CLI_FILE, 'utf8'));
    return Number.isInteger(c.port) && typeof c.token === 'string' ? c : null;
  } catch {
    return null;
  }
}

async function call(path, body) {
  const c = readCli();
  if (!c) throw new Error('not running');
  const res = await fetch(`http://127.0.0.1:${c.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${c.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(body ? 180_000 : 5_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `error ${res.status}`);
  return data;
}

async function running() {
  try {
    return await call('/api/state');
  } catch {
    return null;
  }
}

function outcomeLine(o) {
  if (o.kind === 'done') return o.verified ? green(`  ✓ ${o.text}`) : `  • ${o.text} ${dim('(not double-checked)')}`;
  if (o.kind === 'needs_approval') return amber(`  … waiting for an OK: ${o.summary}  →  familyai approve ${o.id}`);
  return red(`  ✗ ${o.text}`);
}

function printReply(r) {
  console.log(r.text);
  for (const o of r.outcomes ?? []) if (o.kind !== 'done' || !r.text.includes(o.text)) console.log(outcomeLine(o));
}

async function start() {
  const s = await running();
  if (s) return console.log(`${s.botName} is already running.`);
  if (!existsSync(join(APP_DIR, 'dist', 'main', 'main.js'))) {
    console.log('Building the bot (first time only)...');
    const b = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: APP_DIR, stdio: 'inherit' });
    if (b.status !== 0) throw new Error('The build failed. Run "familyai doctor".');
  }
  let electron;
  try {
    const { createRequire } = await import('node:module');
    electron = createRequire(join(APP_DIR, 'package.json'))('electron');
  } catch {
    throw new Error('Electron is not installed. Run "familyai update" or "npm install" in the app folder.');
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // when set, Electron runs as plain Node and no window opens
  const child = spawn(electron, [APP_DIR], { detached: true, stdio: 'ignore', env, windowsHide: false });
  child.unref();
  process.stdout.write('Starting');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    process.stdout.write('.');
    const now = await running();
    if (now) {
      console.log(green(` ${now.botName} is running.`));
      if (!now.modelReady) console.log(dim('  No AI brain yet: open the bot\'s ☰ › Settings, or use fixed commands like "close notepad".'));
      return;
    }
  }
  console.log();
  throw new Error('The bot did not answer within 20 seconds. Run "familyai doctor".');
}

async function status() {
  const s = await running();
  if (!s) return console.log(`Not running. Start it with ${amber('familyai start')}.`);
  console.log(`${green('●')} ${s.botName} is running ${dim(`(you: ${s.you.name}, ${s.you.role})`)}`);
  console.log(`  AI brain:   ${s.modelReady ? 'ready' : 'not set up (fixed commands only)'}${s.aiMode ? amber('  · AI Mode ON') : ''}`);
  console.log(`  Safety:     ${s.stopped ? red('STOPPED (say "resume")') : 'normal'}${s.takeover.active ? red(`  · TAKE-OVER on until ${new Date(s.takeover.until).toLocaleTimeString()}`) : ''}`);
  console.log(`  Stream:     OBS ${s.stream.obs.state}, Twitch ${s.stream.twitch.state}`);
  console.log(`  Phones:     ${s.phone.running ? `on  ${s.phone.urls.join('  ')}` : 'off'}`);
  for (const l of s.limits) console.log(`  Limit:      ${l.label} ${l.leftMinutes} of ${l.dailyMinutes} min left today`);
  console.log(`  Waiting:    ${s.pending.length ? '' : 'nothing'}`);
  for (const p of s.pending) console.log(amber(`    ${p.id}  ${p.summary}  (${p.risk}, asked by ${p.requestedBy})`));
}

async function talk(words) {
  if (!(await running())) throw new Error('The bot is not running. Start it with "familyai start".');
  if (words.length) return printReply(await call('/api/command', { text: words.join(' ') }));
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: amber('> ') });
  console.log(dim('Talk to the bot. Type "exit" to leave.'));
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (/^(exit|quit|bye)$/i.test(text)) break;
    if (text) {
      try {
        printReply(await call('/api/command', { text }));
      } catch (err) {
        console.log(red(err.message));
      }
    }
    rl.prompt();
  }
  rl.close();
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = createConnection({ port, host, timeout: 800 }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function doctor() {
  const ok = (good, label, hint) => console.log(`${good ? green('✓') : red('✗')} ${label}${!good && hint ? dim(`  → ${hint}`) : ''}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 20, `Node.js ${process.versions.node}`, 'install Node.js 20 or newer from nodejs.org');
  ok(existsSync(join(APP_DIR, 'node_modules', 'electron')), 'Electron installed', `run "npm install" in ${APP_DIR}`);
  ok(existsSync(join(APP_DIR, 'dist', 'main', 'main.js')), 'Bot built', 'run "familyai update"');
  const s = await running();
  ok(Boolean(s), 'Bot running', 'run "familyai start"');
  if (s) ok(s.modelReady, 'AI brain set up', 'open ☰ › Settings in the bot and pick Claude or Ollama');
  const ollama = await portOpen(11434);
  console.log(`${ollama ? green('✓') : dim('-')} Ollama ${ollama ? 'is running (free local AI)' : 'not running (optional: ollama.com)'}`);
  const obs = await portOpen(4455);
  console.log(`${obs ? green('✓') : dim('-')} OBS WebSocket ${obs ? 'reachable on port 4455' : 'not reachable (optional: OBS › Tools › WebSocket Server Settings)'}`);
  if (process.platform === 'linux') {
    const xdo = spawnSync('which', ['xdotool']).status === 0;
    console.log(`${xdo ? green('✓') : dim('-')} xdotool ${xdo ? 'installed' : 'missing (needed only for take-over typing: sudo apt install xdotool)'}`);
  }
  console.log(dim(`App folder: ${APP_DIR}\nData folder: ${DATA_DIR}`));
}

function update() {
  const root = dirname(dirname(APP_DIR));
  const installer = process.platform === 'win32' ? join(APP_DIR, 'scripts', 'install.ps1') : join(APP_DIR, 'scripts', 'install.sh');
  if (existsSync(join(root, '.git'))) {
    const steps = [['git', ['-C', root, 'pull', '--ff-only']], ['npm', ['ci', '--no-audit', '--no-fund']], [process.execPath, ['scripts/build.mjs']]];
    for (const [cmd, args] of steps) {
      const r = spawnSync(cmd, args, { cwd: APP_DIR, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' });
      if (r.status !== 0) throw new Error(`"${cmd} ${args.join(' ')}" failed.`);
    }
    return console.log(green('Up to date. Restart the bot: familyai stop, then familyai start.'));
  }
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer], { stdio: 'inherit' })
    : spawnSync('sh', [installer], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('The update failed. Read the message above.');
}

const HELP = `familyai: your desktop bot from the terminal

  familyai start             start the bot
  familyai stop              close the bot
  familyai status            what is running, connected and waiting
  familyai talk [words]      talk to the bot (no words: chat mode)
  familyai pending           what is waiting for an OK
  familyai approve <id>      OK a waiting request
  familyai reject <id>       say no to a waiting request
  familyai halt              STOP everything until someone says "resume"
  familyai doctor            check the setup
  familyai update            get the newest version`;

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'start': return start();
    case 'stop': {
      if (!(await running())) return console.log('Not running.');
      await call('/api/quit', {});
      return console.log('Stopped the bot.');
    }
    case 'status': case 'ps': return status();
    case 'talk': case 'run': case 'ask': return talk(rest);
    case 'pending': {
      const s = await running();
      if (!s) throw new Error('The bot is not running.');
      if (!s.pending.length) return console.log('Nothing is waiting.');
      for (const p of s.pending) console.log(`${p.id}  ${p.summary}  ${dim(`(${p.risk}, asked by ${p.requestedBy})`)}`);
      return;
    }
    case 'approve': case 'reject': {
      if (!rest[0]) throw new Error(`Which one? Try "familyai pending", then "familyai ${cmd} a1".`);
      const o = await call(`/api/${cmd}`, { id: rest[0] });
      return console.log(outcomeLine(o).trim());
    }
    case 'halt': case 'panic': {
      await call('/api/stop', {});
      return console.log(red('Stopped. Nothing will run until someone says "resume".'));
    }
    case 'doctor': return doctor();
    case 'update': return update();
    case 'help': case '--help': case '-h': return console.log(HELP);
    case '--version': case '-v': return console.log(JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version);
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(red(err.message === 'not running' ? 'The bot is not running. Start it with "familyai start".' : err.message));
  process.exitCode = 1;
});
