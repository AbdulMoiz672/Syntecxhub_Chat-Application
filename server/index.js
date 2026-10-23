import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { createApp } from './app.js';
dotenv.config({ path: new URL('../.env', import.meta.url) });
dotenv.config();
try {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018/relay', { serverSelectionTimeoutMS: 5000 });
  const { httpServer, io } = await createApp();
  const port = Number(process.env.PORT) || 3001;
  httpServer.listen(port, () => console.log(`Relay server listening on http://localhost:${port}`));
  const shutdown = () => io.close(() => mongoose.disconnect().then(() => process.exit(0)));
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
} catch (error) {
  console.error('Unable to start Relay. Check MONGODB_URI and ensure MongoDB is running.', error.message);
  process.exit(1);
}
