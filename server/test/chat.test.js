import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../db.js';
import { io as connect } from 'socket.io-client';
import { createApp } from '../app.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('room isolation, persisted history, validation, presence and reconnection', { timeout: 120000 }, async t => {
  const store = await openDatabase({ memory: true });
  const { httpServer, io } = await createApp({ store });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const clients = [];
  t.after(async () => { clients.forEach(s => s.disconnect()); await new Promise(resolve => io.close(resolve)); await store.close(); });
  const post = (route, body, cookie) => fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${url}/api/rooms`)).status, 401);
  const anonymous = connect(url, { transports: ['websocket'], reconnection: false }); clients.push(anonymous);
  assert.equal((await once(anonymous, 'connect_error'))[0].message, 'Authentication required.');
  const cookies = [];
  for (const name of ['Alice', 'Bob', 'Charlie']) {
    const registered = await post('/api/auth/register', { name, email: `${name}@example.com`, password: 'correct-password' });
    assert.equal(registered.status, 201);
    const body = await registered.json();
    assert.equal(body.user.name, name);
    assert.equal(body.user.passwordHash, undefined);
    assert.match(registered.headers.get('set-cookie'), /HttpOnly/);
    cookies.push(registered.headers.get('set-cookie').split(';')[0]);
  }
  assert.equal((await post('/api/auth/register', { name: 'Duplicate', email: 'ALICE@example.com', password: 'correct-password' })).status, 409);
  assert.equal((await post('/api/auth/register', { name: 'Short', email: 'short@example.com', password: 'short' })).status, 400);
  assert.equal((await post('/api/auth/login', { email: 'alice@example.com', password: 'wrong' })).status, 401);
  const storedUser = await store.userByEmail('alice@example.com');
  assert.notEqual(storedUser.passwordHash, 'correct-password');
  assert.equal((await (await fetch(`${url}/api/auth/me`, { headers: { Cookie: cookies[0] } })).json()).user.name, 'Alice');
  const authFetch = (route, options = {}) => fetch(`${url}${route}`, { ...options, headers: { ...options.headers, Cookie: cookies[0] } });
  const rooms = await (await authFetch('/api/rooms')).json();
  assert.equal(rooms.length, 4);
  const makeClient = async cookie => { const s = connect(url, { transports: ['websocket'], forceNew: true, extraHeaders: { Cookie: cookie } }); clients.push(s); await once(s, 'connect'); return s; };
  const [a, b, outsider] = await Promise.all(cookies.map(makeClient));
  const join = (s, room, username) => s.timeout(3000).emitWithAck('join-room', { roomId: room._id, username, clientId: username });
  assert.equal((await join(a, rooms[0], 'Alice')).ok, true);
  assert.equal((await join(b, rooms[0], 'Bob')).ok, true);
  await join(outsider, rooms[1], 'Charlie');
  let leaked = false;
  outsider.on('message:new', () => { leaked = true; });
  const received = once(b, 'message:new');
  const result = await a.timeout(3000).emitWithAck('message:send', { roomId: rooms[0]._id, text: 'Hello from Alice' });
  assert.equal(result.ok, true);
  assert.equal((await received)[0].text, 'Hello from Alice');
  assert.equal(Number((await store.query('SELECT COUNT(*) AS count FROM messages')).rows[0].count), 1);
  const history = await (await authFetch(`/api/rooms/${rooms[0]._id}/messages`)).json();
  assert.equal(history[0].username, 'Alice');
  assert.equal(history[0].text, 'Hello from Alice');
  assert.equal((await a.timeout(3000).emitWithAck('message:send', { roomId: rooms[1]._id, text: 'Forbidden room' })).ok, false);
  assert.equal((await a.timeout(3000).emitWithAck('message:send', { roomId: rooms[0]._id, text: ' ' })).ok, false);
  const typing = once(b, 'typing:update');
  a.emit('typing', { roomId: rooms[0]._id, isTyping: true });
  assert.deepEqual((await typing)[0].usernames, ['Alice']);
  const presence = once(b, 'room:members');
  a.disconnect();
  assert.equal((await presence)[0].members.some(x => x.username === 'Alice'), false);
  a.connect(); await once(a, 'connect');
  assert.equal((await join(a, rooms[0], 'Alice')).ok, true);
  assert.equal((await (await authFetch(`/api/rooms/${rooms[0]._id}/messages`)).json()).length, 1);
  assert.equal(leaked, false);
  const created = await authFetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'new-room', description: 'A new room' }) });
  assert.equal(created.status, 201);
  assert.equal((await authFetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'new-room' }) })).status, 409);
  assert.equal((await authFetch('/api/rooms/bad/messages')).status, 404);
  // The server ignores a supplied name and uses the signed-in account.
  await join(a, rooms[0], 'Impersonated user');
  await new Promise(resolve => setTimeout(resolve, 310));
  const verified = await a.timeout(3000).emitWithAck('message:send', { roomId: rooms[0]._id, text: 'Verified identity' });
  assert.equal(verified.message.username, 'Alice');
  assert.equal(verified.message.clientId, String(storedUser._id));
  const disconnected = once(a, 'disconnect');
  assert.equal((await post('/api/auth/logout', {}, cookies[0])).status, 200);
  await disconnected;
  assert.equal((await authFetch('/api/rooms')).status, 401);
  const login = await post('/api/auth/login', { email: 'ALICE@example.com', password: 'correct-password' });
  assert.equal(login.status, 200);
  const newCookie = login.headers.get('set-cookie').split(';')[0];
  assert.notEqual(newCookie, cookies[0]);
  assert.equal((await fetch(`${url}/api/auth/me`, { headers: { Cookie: newCookie } })).status, 200);
});

test('PostgreSQL persists across reopen, enforces expiry, and returns the latest 100 messages', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'relay-postgres-'));
  let store;
  try {
    store = await openDatabase({ dataDir: dir, url: '' });
    const user = await store.createUser({ name: 'Persistent user', email: 'persistent@example.com', passwordHash: 'test-hash' });
    const room = await store.createRoom('persisted-room', 'A saved room');
    const tokenHash = createHash('sha256').update('test-token').digest('hex');
    await store.createSession({ tokenHash, userId: user._id, expiresAt: new Date(Date.now() + 60_000) });
    await store.createMessage({ roomId: room._id, username: user.name, clientId: user._id, text: "Hello '); DROP TABLE users; --" });
    await store.close();
    store = await openDatabase({ dataDir: dir, url: '' });
    assert.equal((await store.userByEmail(user.email)).name, user.name);
    assert.equal((await store.messages(room._id))[0].text, "Hello '); DROP TABLE users; --");
    assert.equal((await store.findSession(tokenHash)).userId._id, user._id);
    await store.query('UPDATE sessions SET expires_at=$1', [new Date(Date.now() - 1000)]);
    assert.equal(await store.findSession(tokenHash), null);
    await store.query(`INSERT INTO messages(id,room_id,username,client_id,text,created_at)
      SELECT 'bulk-' || n, $1, $2, $3, 'message-' || n, CURRENT_TIMESTAMP + n * INTERVAL '1 second'
      FROM generate_series(1,105) AS n`, [room._id, user.name, user._id]);
    const latest = await store.messages(room._id);
    assert.equal(latest.length, 100);
    assert.equal(latest[0].text, 'message-6');
    assert.equal(latest.at(-1).text, 'message-105');
  } finally {
    if (store) await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
