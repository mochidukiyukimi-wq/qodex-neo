# QodeX

Single-user traQ posting gate. AI review/rewrite is delegated to QodeX AI.

## Setup

1. Create an OAuth client at https://bot-console.trap.jp/clients
2. Set redirect URL to `https://your-app.example.com/oauth/callback`
3. Copy `.env.example` to `.env`
4. Fill `TRAQ_CLIENT_ID`, `TRAQ_CLIENT_SECRET`, `SESSION_SECRET`, `QODEX_AI_API_URL`, and `QODEX_AI_API_TOKEN`
5. Optional but recommended: set `ALLOWED_TRAQ_USER` to your traQ ID

## Run

```sh
npm install
npm start
```

## NeoShowcase

Use Dockerfile or runtime command:

```sh
npm ci --omit=dev && npm start
```

Run `../qodex-ai` separately on FastAPI Cloud. It uses `7shi/codex-oauth` style auth against WHAM.
