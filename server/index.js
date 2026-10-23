import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { createApp } from './app.js';
dotenv.config({ path: new URL('../.env', import.meta.url) });
dotenv.config();
try {
  if (process.env.NODE_ENV === 'production' && !process.env.MONGODB_URI) {
    throw new Error('Set MONGODB_URI to your hosted MongoDB connection string.');
  }
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018/relay', { serverSelectionTimeoutMS: 5000 });
  const { httpServer, io } = await createApp();
  const port = Number(process.env.PORT) || 3001;
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '0.0.0.0', resolve);
  });
  console.log(`Relay server listening on port ${port}`);
  const shutdown = () => io.close(() => mongoose.disconnect().then(() => process.exit(0)));
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${process.env.PORT || 3001} is already in use. Stop the previous server before restarting.`
    : 'Unable to start Relay. Check MONGODB_URI and ensure MongoDB is running.');
  process.exit(1);
}
