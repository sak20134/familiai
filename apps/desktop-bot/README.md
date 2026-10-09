# Family AI Desktop Bot

A small bot that floats on your desktop (Windows, Mac, Linux).

## Run it

1. Install Node.js (version 20 or newer) from nodejs.org.
2. Open a terminal in this folder (`apps/desktop-bot`).
3. Run:

```
npm install
npm start
```

The bot appears in the bottom-right corner of your screen.

## What you can do

- **Click the bot** to make it react. **Drag the dots above it** to move it.
- **Chat** opens a message box.
- **Search** finds free-license images (Openverse). Tap one to make it your bot.
- **Add image** picks a PNG, GIF, JPEG or WebP from your computer (max 5 MB).
- **Remove bg** clears a plain background from the current image. It only works when the corners are one color.
- **Cat** goes back to the built-in cat. **Quiet** dims the bot and hides its speech bubbles. **Quit** closes it.

## Real answers in chat

Without a key the bot answers in demo mode. To get real answers:

1. Copy `.env.example` to `.env`.
2. Put your key after `ANTHROPIC_API_KEY=`.
3. Restart the bot. Never share the `.env` file.

## Known limits (first version)

- Search images are still pictures (animated GIFs from search are not supported yet).
- The bot cannot control your computer, take commands from your phone, or talk out loud yet.
- On some Linux desktops transparent windows need a compositor.

## Check the code

```
npm run typecheck
npm test
```
