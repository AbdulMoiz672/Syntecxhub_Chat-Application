# Relay — real-time chat

React, Express, Node.js, Socket.io, and PostgreSQL. Includes registration, login, rooms, persistent message history, typing indicators, and online members.

## Run locally

Requires Node.js 22.12+ (Node.js 24 recommended).

```powershell
npm install
# Copy .env.example to .env only if .env does not already exist.
npm run dev
```

Open http://localhost:5173. Leave `DATABASE_URL` empty in `.env` to use local embedded PostgreSQL (PGlite). Data persists in `.data/postgres`; no separate database installation is required. Run only one local server against this directory. The API runs on port 3001.

For a regular PostgreSQL server, set `DATABASE_URL` to its connection string. The optional `docker compose up -d` service uses `postgresql://relay:relay_local_only@127.0.0.1:5432/relay`. Those example Docker credentials are for local development only. With a supplied URL, the app uses the standard `pg` driver. SSL can be configured through the connection string (for example `sslmode=require` when required by the provider).

## Deploy from GitHub

### GitHub Pages interface preview

The React interface is published at https://abdulmoiz672.github.io/Syntecxhub_Chat-Application/ by `.github/workflows/pages.yml` on each push to `main`. The workflow builds the correct repository asset path and uploads only `client/dist`. Pages shows the login and registration forms with a preview notice; submitting accounts and live chat are unavailable there because GitHub Pages does not run the Node.js server or PostgreSQL. Local and Render builds continue to use the full backend. Use the Render deployment below for a working public chat app.

### Full application on Render

[Deploy to Render](https://render.com/deploy?repo=https://github.com/AbdulMoiz672/Syntecxhub_Chat-Application)

1. Sign in to Render with GitHub and select this repository as a new Blueprint.
2. Review the included `render.yaml`. It creates one Node.js web service and one PostgreSQL database in the same region. Render supplies the private `DATABASE_URL` automatically; no Atlas account or manually copied database password is needed.
3. Deploy, then open the HTTPS `.onrender.com` URL shown by Render. This serves the full frontend and Socket.io backend together. GitHub Pages cannot host the full application.
4. Check `/api/health` returns `{"ok":true}` and test registration, login, and messaging using two browser sessions.

The Blueprint selects Free plans. **Render's Free PostgreSQL database expires after 30 days** and has no backups. Upgrade it or export/move the data before expiry if you need ongoing hosting. The Free web service sleeps after inactivity and can take about a minute to wake. See [Render limits](https://render.com/docs/free).

Pushes to `main` automatically redeploy a connected Blueprint. Keep one application instance; multiple instances require a shared Socket.io adapter and rate limiter. Production startup requires `DATABASE_URL` and never falls back to an ephemeral local database. `NODE_ENV=production` enables Secure session cookies, so use HTTPS. Database tables and indexes are initialized automatically.

## Production build

```powershell
npm run build
npm start
```

Express serves the React build on http://localhost:3001. Hosting platforms supply `PORT`; local development defaults to 3001. Keep `.env` private.

## Tests

```powershell
npm test
```

Integration tests use actual PostgreSQL via PGlite and real Socket.io clients. They cover account registration, login/logout, authenticated messaging, validation, room isolation, presence, reconnection, and saved history. No external database or binary download is required.

## Database change

This project now uses PostgreSQL instead of MongoDB. Existing MongoDB files and Docker volumes are not deleted, but old MongoDB accounts and messages are not imported automatically. Register a new account in the PostgreSQL-backed app. The MongoDB connection variable is no longer used.

## Scope and API

Passwords use salted scrypt hashes. Seven-day sessions use HttpOnly, SameSite cookies, and logout revokes the session and its sockets. Rooms and histories are shared with signed-in users. The interface loads the latest 100 messages per room; older messages remain stored. Password reset and email verification are not included.

- `POST /api/auth/register` (`name`, `email`, `password`)
- `POST /api/auth/login` (`email`, `password`), `POST /api/auth/logout` (JSON `{}`)
- `GET /api/auth/me`, `GET /api/health`
- `GET /api/rooms`, `POST /api/rooms` (`name`, `description`)
- `GET /api/rooms/:roomId/messages`
- Socket client events: `join-room`, `message:send`, `typing`
- Socket server events: `message:new`, `room:members`, `typing:update`

References: [Render Node.js hosting](https://render.com/docs/deploy-node-express-app), [Socket.io](https://socket.io/docs/v4/rooms/), [PGlite](https://pglite.dev/docs/).
