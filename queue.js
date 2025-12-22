// server/queue.js  (ESM)
import crypto from 'crypto';
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const isTLS = REDIS_URL.startsWith('rediss://');
export const redis = new Redis(REDIS_URL, { tls: isTLS ? {} : undefined });

/* مفاتيح الطابور */
export const Q_MAIN = 'q:imdad';            // قائمة الانتظار الرئيسية
export const Q_PROC = 'q:imdad:processing'; // قيد المعالجة
const DEDUP = 'q:imdad:dedup';              // مجموعة منع التكرار

/* مساعدات */
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** مفتاح تكرار ثابت من عناصر الهوية */
export function hashJobKey(obj) {
  const stable = Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
  return sha256(JSON.stringify(stable));
}

/** إدراج مهمة مع منع التكرار عبر job_key */
export async function enqueueJob(payload) {
  const p = {
    id: payload.id || `job_${crypto.randomBytes(6).toString('hex')}`,
    attempts: payload.attempts ?? 0,
    status: payload.status || 'queued',
    ...payload,
  };

  if (p.job_key) {
    const added = await redis.sadd(DEDUP, p.job_key);
    if (added === 0) {
      return { ok: true, duplicated: true, id: p.id };
    }
    await redis.set(`dedup:ttl:${p.job_key}`, '1', 'EX', 60 * 60 * 6); // 6 ساعات
  }

  await redis.rpush(Q_MAIN, JSON.stringify(p));
  return { ok: true, id: p.id };
}

/** سحب مهمة مع نقلها لقائمة المعالجة */
export async function dequeueJob(blockSeconds = 5) {
  const raw = await redis.brpoplpush(Q_MAIN, Q_PROC, blockSeconds);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    await redis.lrem(Q_PROC, 1, raw);
    return null;
  }
}

/** تأكيد إنجاز المهمة */
export async function ackJob(job) {
  const raw = JSON.stringify(job);
  await redis.lrem(Q_PROC, 1, raw);
  if (job.job_key) {
    await redis.srem(DEDUP, job.job_key);
    await redis.del(`dedup:ttl:${job.job_key}`);
  }
}

/** إعادة جدولة المهمة بعد فشل */
export async function requeueJob(job, { delayMs = 0 } = {}) {
  const raw = JSON.stringify(job);
  await redis.lrem(Q_PROC, 1, raw);
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  await redis.rpush(Q_MAIN, JSON.stringify(job));
}
