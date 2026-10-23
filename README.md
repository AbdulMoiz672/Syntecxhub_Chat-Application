# Relay — MERN real-time chat

React + Vite interface, Express/Node API, Socket.io room messaging, and MongoDB persistence through Mongoose.

## Run locally

Requires Node.js 20.19+ (or 22.12+) and a running MongoDB instance.

```powershell
npm install
Copy-Item .env.example .env
# Set MONGODB_URI in .env for your local MongoDB or Atlas cluster.
npm run dev
```

Open http://localhost:5173, create an account, join a room, and chat. Use a private browser window for a second account. The API runs on port 3001; Vite proxies API and Socket.io traffic. Messages are saved before broadcasting, and the latest 100 messages load when joining a room.

This project uses a dedicated MongoDB instance on port **27018**, with database `relay`. In MongoDB Compass or the VS Code MongoDB extension, connect using `mongodb://127.0.0.1:27018/relay` and replace the old Chat-Application connection. Databases from your other MongoDB instance on port 27017, such as `contact_manager`, remain there. Existing chat history on port 27017 is not migrated automatically.

With Docker installed, you can start the included MongoDB service using `docker compose up -d` instead of installing MongoDB locally. Its data persists in a dedicated named Docker volume. Choose either Docker or the local command below, since both use port 27018.

If MongoDB is installed but not running, start it separately with a persistent data directory:

```powershell
New-Item -ItemType Directory -Force .data/relay-mongo
mongod --dbpath .data/relay-mongo --bind_ip 127.0.0.1 --port 27018
```

## Production build

```powershell
npm run build
npm start
```

Open http://localhost:3001. Express serves the built React application and Socket.io from the same origin. Configure `PORT` and `MONGODB_URI` in the environment or root `.env`. Use a reverse proxy with WebSocket support and HTTPS when hosting.

## Verification

```powershell
npm test
```

Integration tests use a temporary MongoDB instance and real Socket.io clients to verify delivery, room isolation, validation, presence, reconnect, and history. The first run downloads a MongoDB binary. To use an installed binary without a download, set `MONGOD_BINARY` to the absolute path of `mongod.exe` before running tests. Test data is isolated from your configured application database.

## Scope

Registration and login use an email address and password. Passwords are hashed with salted Node.js scrypt. Sessions last seven days, are stored in MongoDB, and use HttpOnly, SameSite cookies; logout revokes the session and disconnects its sockets. Set `NODE_ENV=production` when hosting over HTTPS to enable Secure cookies. Authentication is required for room APIs and Socket.io; message identity comes from the account. Existing guest chat history remains visible to signed-in users. Email verification and password reset are not included.

Rooms and histories are shared with all signed-in users. Presence reflects connected browser tabs. This implementation runs one Node server; multiple instances need a shared Socket.io adapter, shared presence, and shared login rate limiting. History is capped at the latest 100 messages per room in the interface; older records remain in MongoDB.

## API and events

- `GET /api/rooms`, `POST /api/rooms` (`name`, `description`)
- `POST /api/auth/register` (`name`, `email`, `password`), `POST /api/auth/login` (`email`, `password`)
- `GET /api/auth/me`, `POST /api/auth/logout` (JSON `{}`)
- `GET /api/rooms/:roomId/messages`, `GET /api/health`
- Client events: `join-room`, `message:send`, `typing`
- Server events: `message:new`, `room:members`, `typing:update`

Implementation references: [Socket.io rooms](https://socket.io/docs/v4/rooms/) and [Mongoose connections](https://mongoosejs.com/docs/connections.html).
