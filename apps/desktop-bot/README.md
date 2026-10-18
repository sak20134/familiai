# Family AI Desktop Bot

An agentic AI friend that floats on your desktop (Windows, Mac, Linux). It answers precisely,
does things on your computer, runs your live stream like a copilot, and follows your family's
rules. Family members can command it from their phones.

## Install (one line, like Ollama)

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

## The `familyai` command

```
familyai start             start the bot
familyai stop              close the bot
familyai status            what is running, connected and waiting
familyai talk [words]      talk to the bot (no words: chat mode)
familyai pending           what is waiting for an OK
familyai approve a1        OK a waiting request (familyai reject a1 says no)
familyai halt              STOP everything until someone says "resume"
familyai doctor            check the setup
familyai update            get the newest version
```

Already have the code? In this folder: `npm install`, then `npm start`.

## Give it a brain

Open **☰ › Settings › AI brain**:

- **Ollama**: free, runs on your own computer. Install it from ollama.com, run `ollama pull llama3.2`, pick Ollama.
- **Claude**: pick Claude and paste your key. Keys are encrypted by your operating system.

Without a brain the bot still does fixed commands (below), fast and free.

## What you can say

| Area | Examples |
|---|---|
| Computer | "open spotify", "close chrome", "force close minecraft", "what apps are running?", "open youtube.com" |
| Take-over | "take over for 10 minutes", then "type: hello", "press ctrl+s" |
| Family | "limit gaming to 1 hour a day", "remove the gaming limit", "screen time", "close games" |
| Memory | "remember the wifi password is on the router", "remember for family: dinner is at 8", "what do you remember about wifi" |
| Stream | "switch to BRB", "mute mic", "go live", "end stream", "timeout name 5 minutes", "ban name", "start a poll: best snack? chips or popcorn", "end poll", "start a giveaway for a game key", "draw winner", "add command !discord saying join us", "summary" |
| Safety | "stop", "resume", "pending", "approve a1", "AI mode on" |

With a brain, ask anything else in your own words ("read this page and tell me the price",
"close everything except OBS and switch to the gameplay scene").

## Safety rules (built into the code, not the prompt)

- **Low risk** (look, open an app, read a page) runs straight away.
- **Medium risk** (close an app, time out a chatter) asks first, unless **AI Mode** is on.
- **High risk** (ban, end the stream, force close, start take-over) **always** asks.
- **Money** always asks, every time, even in AI Mode.
- Children and guests can ask, but anything above low risk waits for a parent.
- The bot says "done" only when the result is confirmed; otherwise it says what really happened.
- **Stop switch**: the red ■ button, `Ctrl+Alt+S` anywhere, saying "stop", the phone's STOP button
  or `familyai halt`. Only a parent can resume. Parents' screen-time limits keep working while stopped.
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
- Voice: the bot can speak replies (Settings), but cannot listen yet.
- macOS: take-over needs Accessibility permission. Linux: take-over needs `xdotool`; transparent
  windows need a compositor.
- Game detection uses a list of common games; add others by name ("limit fortnite to 30 minutes").

## Check the code

```
npm run typecheck
npm test
```
