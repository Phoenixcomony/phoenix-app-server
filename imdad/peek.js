import 'dotenv/config';
import Redis from 'ioredis';
import { slotsKey, defaultClinicId, defaultMonth } from './config.js';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const key = slotsKey(defaultClinicId, defaultMonth);

const raw = await redis.get(key);
console.log('KEY:', key);
if (!raw) {
  console.log('No data yet.');
} else {
  const arr = JSON.parse(raw);
  console.log('Count:', Array.isArray(arr) ? arr.length : 0);
  console.log('Sample:', Array.isArray(arr) && arr[0] ? arr[0] : null);
}
process.exit(0);
