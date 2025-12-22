import Redis from 'ioredis';
const r = new (await import('ioredis')).default('redis://localhost:6379');
await r.flushall();
console.log('OK');
process.exit(0);
