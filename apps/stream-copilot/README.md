# Stream Copilot (working name)

An AI helper for live streamers. It watches your Twitch chat, keeps it clean and lively,
and runs OBS for you when you ask — "switch to BRB", "mute mic", "start a poll".

It is a clean-room rebuild of the *features* of AI streaming copilots like Dexter: written
from scratch, using only official OBS and Twitch connections. It needs its own name before
it ships — "Stream Copilot" is just a placeholder.

## What works now

| | |
|---|---|
| **OBS control** | Switch scenes, mute and unmute, set volume, go live, end the stream. Say scenes loosely: "brb" finds "BRB". |
| **Chat moderation** | Blocked words (catches tricks like `b4dw0rd`), links, shouting, copy-paste spam. Your mods and you are never touched. |
| **Commands** | `!discord`-style commands with cooldowns. Add one by saying "add command !discord that says join us". |
| **Timed messages** | Repeat a message every few minutes, but only while chat is active — never into an empty room. |
| **Polls** | "start a poll: best snack? chips or popcorn". Chat votes with `!vote 1`, one vote each. |
| **Giveaways** | "start a giveaway for a game key", chat types `!join`, "draw winner". Fair, unpredictable draw; you can't enter your own. |
| **Stream summary** | Chat stats, your most active chatters, and the **minutes chat exploded** — the moments worth clipping. |

## Safety rules

The same rules as Family AI:

- **Never bans on its own.** Repeat offenders get deleted, then a 1-minute timeout, then 10 minutes. After that it keeps them quiet and **asks you** whether to ban.
- **Bans and ending the stream always ask you first**, every time — even in Autopilot.
- **Autopilot** (`autopilot on`) lets timeouts and going live happen without asking. Nothing else changes.
- **Honest replies.** It says "done" only when OBS or Twitch confirms. Otherwise it tells you what went wrong.

## Set it up

1. **OBS:** open OBS → Tools → WebSocket Server Settings → turn it on and copy the password.
2. **Twitch:** create an app at dev.twitch.tv/console, then make a user token with these scopes:
   `chat:read chat:edit moderator:manage:banned_users moderator:manage:chat_messages`
3. Copy `.env.example` to `.env` in this folder and fill it in. **Never share `.env`.**
4. From the top `familiai` folder:

```
npm install
npm run stream
```

Then type what you want. It works with only OBS, only Twitch, or both.

## Not built yet

- Talking to it by voice (the golden-globe Voice mode in Family AI is the next hookup)
- Building overlays and alerts for you
- The setup wizard that installs and configures OBS
- An AI model for free-form requests (today it understands a fixed set of phrases, with no API key needed)

## Check the code

```
npm test -w @familiai/stream-copilot
npm run typecheck -w @familiai/stream-copilot
```
