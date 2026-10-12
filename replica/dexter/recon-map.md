# Recon: Dexter — AI copilot for streamers

Source: dexterai.org (public marketing site), @dexter.copilot on Instagram (136K followers).
Status: pre-launch, early-access waitlist. Read 12 Oct 2026.

Clean room: this records what Dexter DOES, from public pages. No code, assets, name,
logo or copy of theirs is used. Anything we build is written fresh and carries our own name.

## What it is

A desktop AI copilot that runs beside a live stream and handles the technical work:
setup before, control during, analysis after. Voice-driven, hands-free.

## Features, by stage

| Stage | What it does |
|---|---|
| Before going live | Installs and configures OBS, alerts, overlays; sets up bits, subs, hype trains, donations; builds scenes (starting soon, gameplay, BRB, ending); explains each step in plain words |
| While live | Controls OBS scenes, audio, cameras, transitions; moderates chat (ban, timeout, word filters, caps and spam rules); runs commands, giveaways, polls, timers; keeps chat active with games; answers research questions by voice and opens links |
| After the stream | Key stats and trends, highlight detection, full stream summary, chat and engagement analysis, what to change to grow |
| Always | Personality tuning: humour, reply length, talkativeness, suggestibility, custom notes |

## How much of this we already have

| Dexter capability | Family AI today | Gap |
|---|---|---|
| Desktop app that controls other software | `apps/desktop-bot` (Electron, always-on-top, click-through) | Take-over / app control not built |
| Voice answers, hands-free | Voice mode with the golden globe, wake word, speech in and out | Works in-browser; no always-listening desktop layer |
| Research on demand | `read_webpage` tool (being added) | — |
| Personality tuning | aiName, aliases, botRole, botLook, five modes | No humour/length/talkativeness dials |
| Automation: timers, scheduled actions | reminders, daily check-ins, approvals | No polls or giveaways (stream-specific) |
| After-the-fact summary and stats | Family Hub, Timeline, money summary | No highlight detection |
| Chat moderation | — | Entirely new; needs the Twitch API |
| Overlay and widget building | — | Entirely new |

Roughly two thirds of Dexter's machinery is the same machinery as Family AI: a desktop
companion, an agent with tools and approvals, voice, and a personality the user sets.
The streaming-specific parts (OBS control, Twitch chat, overlays) are the new third.

## Must / should / could, if we build a streamer version

- **Must:** OBS control (scenes, audio, sources) · Twitch chat read and moderate · voice command loop · stream summary
- **Should:** chat commands and timers · alerts and overlay setup · highlight detection · personality dials
- **Could:** giveaways and polls · Telegram notifications · growth recommendations

## Not copied

Their name, logo, site wording, pricing, founding-streamer programme, and any code.
If we ship something in this space it needs its own name and its own look.
