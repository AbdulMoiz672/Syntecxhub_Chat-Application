import dotenv from 'dotenv';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
dotenv.config({ path: new URL('../.env', import.meta.url) });
dotenv.config();
try {
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL to your hosted PostgreSQL connection string.');
  }
  const store = await openDatabase();
  const { httpServer, io } = await createApp({ store });
  const port = Number(process.env.PORT) || 3001;
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '0.0.0.0', resolve);
  });
  console.log(`Relay server listening on port ${port}`);
  const shutdown = () => io.close(() => store.close().then(() => process.exit(0)));
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${process.env.PORT || 3001} is already in use. Stop the previous server before restarting.`
    : 'Unable to start Relay. Check DATABASE_URL and database availability.');
  process.exit(1);
}
