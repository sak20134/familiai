# Montex

Montex is the Family AI desktop bot. By Sakthi Yokesh.

An agentic AI friend that floats on your desktop (Windows, Mac, Linux). It answers precisely,
does things on your computer, runs your live stream like a copilot, and follows your family's
rules. Family members can command it from their phones.

## Install (one line)

**Windows** (PowerShell):

```
irm https://raw.githubusercontent.com/sak20134/familiai/feat/desktop-bot/apps/desktop-bot/scripts/install.ps1 | iex
```

**Mac or Linux** (Terminal):

```
curl -fsSL https://raw.githubusercontent.com/sak20134/familiai/feat/desktop-bot/apps/desktop-bot/scripts/install.sh | sh
```

The Windows installer gets Node.js for you if needed (checked against nodejs.org's checksum). On
Mac and Linux, install Node.js 22 or newer first. After installing, open a new terminal.

## The `montex` command

The old `familyai` command still works and does the same thing.

```
montex start               start the bot
montex stop                close the bot
montex status              what is running, connected and waiting
montex talk [words]        talk to the bot (no words: chat mode)
montex pending             what is waiting for an OK
montex approve a1          OK a waiting request (montex reject a1 says no)
montex halt                STOP everything until someone says "resume"
montex doctor              check the setup
montex update              get the newest version
```

Already have the code? In this folder: `npm install`, then `npm start` (or `npm run pack` to build
the real "Montex" app with its own name and icon, which `montex start` then uses).

## The app and its icon

The installers build the bot as its own program, **Montex**, with an original pixel-cat
icon (drawn by `scripts/make-icon.mjs` from `src/renderer/pixelcat.json`; the same cat floats on
your desktop). Task Manager and the firewall show "Montex". `npm run dist` makes a full
installer (`.exe`, `.dmg` or `.AppImage`) in `release/`.

The app's author, company and copyright say **Sakthi Yokesh** (see `brand.json`). It is not
code-signed yet, so Windows may still show "Unknown publisher" and SmartScreen may ask once.
Windows shows a verified publisher name only for a paid code-signing certificate.

### Changing the name

The name lives in one file, `brand.json`. Edit it and run `npm run brand` (the build does this
too): it updates the app name, command, author and copyright in `package.json`.

## Its brain

Pick the brain in **Settings → Brain**:

| Choice | What it is |
|---|---|
| **Default** | Runs on your computer. No account, no internet to think, nothing you say leaves it. |
| **Light** | Smaller and faster, for slow computers. A bit less clever. |
| **My own API** | Optional. Your own chat service (address, model name and key). What you say is sent to that service. Works with any OpenAI-style API, for example DeepSeek, OpenAI, Gemini, Groq, OpenRouter, or Ollama / LM Studio on your own computer. The key is stored encrypted. |
| **Off** | No AI. Only the fixed commands below. |

- A local brain downloads once (Default about 1 GB, Light about 0.5 GB, checked before use).
- It does not load at start-up: it wakes for the first question and goes to sleep after
  5 quiet minutes, so the bot stays light. It uses the processor, leaves one core free, and
  never more than four. To try the graphics card, set `MONTEX_GPU=1`.
- A brain only proposes actions; the safety gate still decides what really runs.
- Fixed commands (below) work instantly, with any choice.

## Search, email and conversations

- **Web search:** "search for pasta recipes". No account or key. If a search engine blocks it, it falls back to Wikipedia and says so plainly. Then "read the first one" opens the page for it to read.
- **Email (Gmail, read-only):** "check my email", "read that email", or "daily brief" for a spoken summary of what is unread and what needs a reply. It can only read: it never asks Google for permission to send or delete. Set it up in Settings → Email: you make a free Google "desktop app" client (Google Cloud Console → turn on the Gmail API → Credentials → OAuth client ID → Desktop app), paste its ID and secret, save, then press Connect Gmail. Only adults can use the email tools.
- **Conversations:** it remembers the recent conversation per person. Say "new chat" to start fresh.
- **Open apps:** "open spotify", "close chrome" (see below).

## What you can say

| Area | Examples |
|---|---|
| Computer | "open spotify", "close chrome", "force close minecraft", "what apps are running?", "open youtube.com" |
| Take-over | "take over for 10 minutes", then "type: hello", "press ctrl+s" |
| Family | "limit gaming to 1 hour a day", "remove the gaming limit", "screen time", "close games" |
| Memory | "remember the wifi password is on the router", "remember for family: dinner is at 8", "what do you remember about wifi" |
| Stream | "switch to BRB", "mute mic", "go live", "end stream", "timeout name 5 minutes", "ban name", "start a poll: best snack? chips or popcorn", "end poll", "start a giveaway for a game key", "draw winner", "add command !discord saying join us", "summary" |
| Safety | "stop", "resume", "pending", "approve a1", "AI mode on" |

Ask anything else in your own words ("read this page and tell me the price",
"close everything except OBS and switch to the gameplay scene").

## Safety rules (built into the code, not the prompt)

- **Low risk** (look, open an app, read a page) runs straight away.
- **Medium risk** (close an app, time out a chatter) asks first, unless **AI Mode** is on.
- **High risk** (ban, end the stream, force close, start take-over) **always** asks.
- **Money** always asks, every time, even in AI Mode.
- Children and guests can ask, but anything above low risk waits for a parent.
- The bot says "done" only when the result is confirmed; otherwise it says what really happened.
- **Stop switch**: the red ■ button, `Ctrl+Alt+S` anywhere, saying "stop", the phone's STOP button
  or `montex halt`. Only a parent can resume. Parents' screen-time limits keep working while stopped.
- **Take-over** ends by itself after the time you gave (60 minutes at most). While it is on, the
  bot glows red with a banner.
- The **Activity** tab lists everything asked and done. It is never edited, so deleted things still show.

## Phones

1. **☰ › Settings**: tick **Phone control**, then **Save**.
2. **☰ › Family**: add the person, then tap **Pair a phone** next to their name.
3. On the phone (same Wi-Fi), open the address shown and type the 6-digit code.

Each phone acts as its family member, with that person's role. Phone control only works on
your home Wi-Fi, not over the internet.

## Live streaming

**☰ › Settings › Stream**: OBS address and password (OBS › Tools › WebSocket Server Settings), and
your Twitch client ID, token and channel. Then **☰ › Stream › Connect**. Chat moderation runs by
itself: spam and links are removed, repeat offenders are timed out, and bans wait for your OK.

## Where things are kept

Everything lives in `~/.familyai` (Windows: `C:\Users\you\.familyai`): settings, family, memory,
screen time and the activity log. Keys are in `secrets.bin`, encrypted by your operating system.

## Known limits

- Take-over types and presses keys, but cannot see the screen yet.
- A local brain needs about 2 GB of free memory while it is awake (Light needs less).
- Small local brains make mistakes with tools; the gate and the approval step catch them.
- Voice: the bot can speak replies (Settings), but cannot listen yet.
- macOS: take-over needs Accessibility permission. Linux: take-over needs `xdotool`; transparent
  windows need a compositor.
- Game detection uses a list of common games; add others by name ("limit fortnite to 30 minutes").

## Check the code

```
npm run typecheck
npm test
```

## Credits

Built with Electron, llama.cpp (MIT) and the Qwen2.5 open models (Apache-2.0): Default is
Qwen2.5 1.5B Instruct, Light is Qwen2.5 0.5B Instruct.
