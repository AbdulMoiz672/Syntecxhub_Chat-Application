import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export async function openDatabase({ url = process.env.DATABASE_URL, memory = false, dataDir } = {}) {
  let db, close;
  if (url && !memory) {
    db = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10000 });
    db.on('error', error => console.error('PostgreSQL connection error:', error.code || 'connection lost'));
    close = () => db.end();
  } else {
    if (process.env.NODE_ENV === 'production' && !memory) throw new Error('DATABASE_URL is required in production.');
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = memory ? undefined : dataDir || fileURLToPath(new URL('../.data/postgres', import.meta.url));
    if (dir) await mkdir(path.resolve(dir), { recursive: true });
    db = new PGlite(dir);
    await db.waitReady;
    close = () => db.close();
  }
  const query = (sql, params = []) => db.query(sql, params);
  try {
    // Idempotent schema initialization also works against a fresh managed database.
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)`,
      `CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '')`,
      `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), username TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS messages_history ON messages(room_id, created_at DESC, id DESC)`
    ]) await query(sql);
  } catch (error) { await close(); throw error; }
  const one = async (sql, params) => (await query(sql, params)).rows[0];
  return {
    query, close,
    health: async () => { await query('SELECT 1'); return true; },
    seedRoom: (name, description) => query('INSERT INTO rooms(id,name,description) VALUES($1,$2,$3) ON CONFLICT(name) DO NOTHING', [randomUUID(), name, description]),
    rooms: async () => (await query('SELECT id AS "_id",name,description FROM rooms ORDER BY name')).rows,
    hasRoom: async id => !!await one('SELECT id FROM rooms WHERE id=$1', [id]),
    createRoom: (name, description) => one('INSERT INTO rooms(id,name,description) VALUES($1,$2,$3) RETURNING id AS "_id",name,description', [randomUUID(), name, description]),
    messages: async roomId => (await query('SELECT id AS "_id", room_id AS "roomId", username, client_id AS "clientId", text, created_at AS "createdAt" FROM messages WHERE room_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [roomId])).rows.reverse(),
    createMessage: ({ roomId, username, clientId, text }) => one('INSERT INTO messages(id,room_id,username,client_id,text) VALUES($1,$2,$3,$4,$5) RETURNING id AS "_id",room_id AS "roomId",username,client_id AS "clientId",text,created_at AS "createdAt"', [randomUUID(), roomId, username, clientId, text]),
    createUser: ({ name, email, passwordHash }) => one('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id AS "_id",name,email', [randomUUID(), name, email, passwordHash]),
    userByEmail: email => one('SELECT id AS "_id",name,email,password_hash AS "passwordHash" FROM users WHERE email=$1', [email]),
    createSession: async ({ tokenHash, userId, expiresAt }) => {
      await query('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP');
      return one('INSERT INTO sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,$4) RETURNING id', [randomUUID(), tokenHash, userId, expiresAt]);
    },
    findSession: async tokenHash => {
      const row = await one('SELECT s.id AS "_id", s.expires_at AS "expiresAt", u.id AS "userId", u.name, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>CURRENT_TIMESTAMP', [tokenHash]);
      return row ? { _id: row._id, expiresAt: new Date(row.expiresAt), userId: { _id: row.userId, name: row.name, email: row.email } } : null;
    },
    deleteSession: id => query('DELETE FROM sessions WHERE id=$1', [id])
  };
}
