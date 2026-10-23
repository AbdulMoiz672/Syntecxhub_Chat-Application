import { randomBytes, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(derive);
const digest = token => createHash('sha256').update(token).digest('hex');
const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' });
export const publicUser = user => ({ id: String(user._id), name: user.name, email: user.email });
export async function findSession(cookie = '', store) {
  const token = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('relay_session='))?.slice(14);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return store.findSession(digest(token));
}
export function installAuth(app, disconnectSession, store) {
  const attempts = new Map();
  const limiter = (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    const key = req.ip;
    const entry = attempts.get(key) || { count: 0, until: now + 15 * 60_000 };
    entry.count++; attempts.set(key, entry);
    if (entry.count > 30) return res.status(429).json({ error: 'Too many attempts. Please try again in 15 minutes.' });
    next();
  };
  app.use('/api/auth', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const jsonOnly = (req, res, next) => req.is('application/json') ? next() : res.status(415).json({ error: 'JSON request required.' });
  async function startSession(req, res, user) {
    const previous = await findSession(req.headers.cookie, store);
    if (previous) { await store.deleteSession(previous._id); disconnectSession(String(previous._id)); }
    const token = randomBytes(32).toString('hex');
    await store.createSession({ tokenHash: digest(token), userId: user._id, expiresAt: new Date(Date.now() + 7 * 86400_000) });
    res.cookie('relay_session', token, { ...cookieOptions(), maxAge: 7 * 86400_000 });
  }
  app.post('/api/auth/register', jsonOnly, limiter, async (req, res) => {
    const { name, email, password } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32 || typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Enter a name (1–32 characters), valid email, and password (8–128 characters).' });
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    try {
      const user = await store.createUser({ name: name.trim(), email: email.trim().toLowerCase(), passwordHash: `${salt}:${hash}` });
      await startSession(req, res, user);
      res.status(201).json({ user: publicUser(user) });
    } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'An account with this email already exists.' }); throw error; }
  });
  app.post('/api/auth/login', jsonOnly, limiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 128) return res.status(400).json({ error: 'Enter your email and password.' });
    const user = await store.userByEmail(email.trim().toLowerCase());
    const [salt, stored] = user?.passwordHash.split(':') || ['00000000000000000000000000000000', '00'.repeat(64)];
    const candidate = await scrypt(password, salt, 64);
    if (!timingSafeEqual(candidate, Buffer.from(stored, 'hex')) || !user) return res.status(401).json({ error: 'Incorrect email or password.' });
    await startSession(req, res, user);
    res.json({ user: publicUser(user) });
  });
  app.get('/api/auth/me', async (req, res) => {
    const session = await findSession(req.headers.cookie, store);
    if (!session) return res.status(401).json({ error: 'Please log in to continue.' });
    res.json({ user: publicUser(session.userId) });
  });
  app.post('/api/auth/logout', jsonOnly, async (req, res) => {
    const session = await findSession(req.headers.cookie, store);
    if (session) { await store.deleteSession(session._id); disconnectSession(String(session._id)); }
    res.clearCookie('relay_session', cookieOptions()).json({ ok: true });
  });
  app.use('/api/rooms', async (req, res, next) => {
    const session = await findSession(req.headers.cookie, store);
    if (!session) return res.status(401).json({ error: 'Please log in to continue.' });
    next();
  });
}
