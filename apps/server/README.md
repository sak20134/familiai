# Family AI server and web app

Runs on your own computer, with no cloud and no cost.

## Start it

1. Install Node.js 22 or newer from nodejs.org.
2. In the `familiai` folder (the top of the project), run:

```
npm install
npm start
```

3. Open http://localhost:8787 in your browser, create an account, answer the setup questions, and create your family.

Your data is saved in `apps/server/data` on your computer.

## Turn on the real AI

Without a key, the app uses a free **demo brain**. It understands requests like "spent 600 on groceries", "remember that ...", "remind me to ...", "how much did we spend this month" and "call Dad".

For full conversations:

1. Copy `apps/server/.env.example` to `apps/server/.env`.
2. Put your Anthropic key after `ANTHROPIC_API_KEY=`.
3. Restart. Never share the `.env` file.

## Optional: phone calls and Google Calendar

Add these to `apps/server/.env` (see `.env.example`), then restart:

- **Phone calls and check-in calls:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (a Twilio number). Each person adds their phone in Settings.
- **Google Calendar:** create an OAuth client (type: Web) in Google Cloud Console, set its redirect URL to `http://localhost:8787/api/oauth/google/callback`, then add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Each person connects their own Google account in Settings.

Without these, calls and calendar say "not connected" instead of pretending.

## What is protected

- Risky actions wait for approval. Money always needs an adult or admin, every time.
- Kids, teens and guests cannot approve their own requests.
- Private memories are only visible to their owner, admins included, and stay private after deletion.
- Families cannot see each other's data.
- The AI is never allowed to say something is done unless it really ran and was checked.

## Check the code

```
npm test
npm run typecheck
```
