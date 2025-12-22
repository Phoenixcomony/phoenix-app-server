// server/server.js
import fs from 'fs';
import path from 'path';
import admin from 'firebase-admin';

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});



import 'dotenv/config';
console.log('QUEUE_SECRET (server) =', JSON.stringify(process.env.QUEUE_SECRET));

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import axios from 'axios';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import { enqueueJob, hashJobKey } from './queue.js';
import adminDoctorPeriodsRoutes from './imdad/adminDoctorPeriodsRoutes.js';
import adminServicesRoutes from './imdad/adminServicesRoutes.js';
import multer from 'multer';
import { fileURLToPath } from 'url';

// ضروري مع ESM بدال __dirname/filename القديم
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// مجلد data (home_banners.json + campaigns.json)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// مجلد رفع الصور
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const HOME_BANNERS_PATH = path.join(DATA_DIR, 'home_banners.json');
const CAMPAIGNS_PATH    = path.join(DATA_DIR, 'campaigns.json');

// ===== إنشاء تطبيق إكسبريس =====
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ملفات لوحة الموظف
const WEB_DIR = path.join(__dirname, 'web');
app.use('/web', express.static(WEB_DIR));

// ملفات الصور
app.use('/uploads', express.static(UPLOADS_DIR));

// راوت فترات الأطباء والخدمات
app.use('/api/admin', (req, res, next) => {
  // ⬅️ اسمح للإحصائيات بالـ PIN
  if (
    req.path.startsWith('/auth/') ||
    req.path === '/stats/bookings'
  ) {
    return next();
  }

  return requireAdminAuth(req, res, next);
});

// ===============================
// 📊 Admin Booking Statistics
// ===============================
app.get('/api/admin/stats/bookings', async (req, res) => {
  try {
    const { pin } = req.query;

    // 🔐 تحقق من PIN
    if (!pin || pin !== process.env.ADMIN_PIN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const total =
      Number(await redis.get('stats:bookings:total')) || 0;

    const todayKey =
      'stats:bookings:day:' + new Date().toISOString().slice(0, 10);
    const today =
      Number(await redis.get(todayKey)) || 0;

    let week = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k =
        'stats:bookings:day:' + d.toISOString().slice(0, 10);
      week += Number(await redis.get(k)) || 0;
    }

    const clinicKeys =
      await redis.keys('stats:bookings:clinic:*');

    const byClinic = {};
    for (const k of clinicKeys) {
      const name = k.replace('stats:bookings:clinic:', '');
      byClinic[name] = Number(await redis.get(k)) || 0;
    }

    return res.json({ total, today, week, byClinic });
  } catch (e) {
    console.error('[admin/stats] error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ===============================
// 🔄 Reset Booking Statistics
// ===============================
app.post('/api/admin/stats/reset', async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin || pin !== process.env.ADMIN_PIN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const keys = await redis.keys('stats:bookings:*');
    if (keys.length) {
      await redis.del(keys);
    }

    return res.json({ ok: true, deleted: keys.length });
  } catch (e) {
    console.error('stats reset error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.use('/api', adminDoctorPeriodsRoutes);
app.use('/api', adminServicesRoutes);


/* ================== Env ================== */
const {
  PORT = 3000,
  OTP_COOLDOWN_SECONDS = '60',
  PEPPER = 'phoenix_secret_pepper',
  JWT_SECRET = 'phoenix_jwt_secret',
  QUEUE_SECRET = '',
  WHATS_INSTANCE_ID,
  WHATS_ACCESS_TOKEN,
  REDIS_URL = 'redis://localhost:6379',
  OTP_TTL_SECONDS = '180',
  INDEX_TTL_SECONDS = '172800',
  DEV_OTP_BYPASS = 'true',
  IMDAD_LOCK_TTL_SECONDS = '20',
  IMDAD_DEFAULT_CLINIC_ID = 'phoenix-main',
  IMDAD_DEFAULT_MONTH = '2025-10',
  BOOKING_DEPOSIT_SAR = '30',
  PAY_INTENT_TTL_SECONDS = '600',
  FCM_SERVER_KEY,
} = process.env;

const {
  ADMIN_PIN,
  ADMIN_PHONE_E164,
  ADMIN_JWT_SECRET = 'phoenix_admin_jwt',
} = process.env;


async function sendFcmBroadcastToAll({ title, body }) {
  if (!FCM_SERVER_KEY) {
    console.error('FCM_SERVER_KEY is missing');
    return { ok: false, error: 'fcm_key_missing' };
  }

  try {
    const res = await axios.post(
      'https://fcm.googleapis.com/fcm/send',
      {
        to: '/topics/all_users',
        notification: {
          title: title ?? 'إشعار من مجمع فينكس الطبي',
          body: body ?? '',
          sound: 'default',
        },
        data: {
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `key=${FCM_SERVER_KEY}`,
        },
      }
    );

    console.log('FCM response:', res.data);
    return { ok: true };
  } catch (err) {
    console.error('FCM error:', err.response?.data || err.message);
    return { ok: false, error: 'fcm_request_failed' };
  }
}

app.post('/api/admin/auth/start', async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin || pin !== ADMIN_PIN) {
      return res.status(401).json({ error: 'pin_invalid' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const tx = 'admin_otp_' + crypto.randomBytes(8).toString('hex');

    await sendOtpSms(
      ADMIN_PHONE_E164,
      `رمز دخول لوحة الموظف: ${code}\nصالح لمدة ${OTP_TTL} ثانية`
    );

    await redis.set(
      `admin:otp:${tx}`,
      JSON.stringify({
        code,
        expAt: Date.now() + OTP_TTL * 1000,
      }),
      'EX',
      OTP_TTL
    );

    return res.json({
      ok: true,
      tx,
      masked_phone: maskPhone(ADMIN_PHONE_E164),
    });
  } catch (e) {
    console.error('admin auth start error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/auth/verify', async (req, res) => {
  try {
    const { code, tx } = req.body || {};
    if (!code || !tx) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const raw = await redis.get(`admin:otp:${tx}`);
    if (!raw) {
      return res.status(400).json({ error: 'otp_expired' });
    }

    const rec = JSON.parse(raw);
    if (rec.code !== String(code)) {
      return res.status(400).json({ error: 'code_invalid' });
    }

    await redis.del(`admin:otp:${tx}`);

    const token = jwt.sign(
      { role: 'admin' },
      ADMIN_JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.json({ ok: true, token });
  } catch (e) {
    console.error('admin auth verify error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ========== بث إشعار FCM لكل مستخدمي التطبيق ==========
// يُستخدم من لوحة الموظف (admin.html)
app.post('/api/admin/broadcast-fcm', async (req, res) => {
  try {
    const { title, body } = req.body || {};

    const message = {
      topic: 'all_users',
      notification: {
        title: title || 'مجمع فينكس الطبي',
        body: body || '',
      },
    };

    const resp = await admin.messaging().send(message);

    return res.json({ ok: true, messageId: resp });
  } catch (err) {
    console.error('FCM send error:', err);
    return res.status(500).json({ ok: false, error: 'send_failed' });
  }
});




const OTP_TTL = parseInt(OTP_TTL_SECONDS, 10);
const INDEX_TTL = parseInt(INDEX_TTL_SECONDS, 10);
const otpCooldownKey = (flow, nid) => `otp:cooldown:${flow}:${nid}`;
const DEV_MODE = String(DEV_OTP_BYPASS).toLowerCase() === 'true';
const OTP_COOLDOWN = parseInt(OTP_COOLDOWN_SECONDS, 10) || 60;
const LOCK_TTL = Math.max(5, parseInt(IMDAD_LOCK_TTL_SECONDS, 10));
const DEPOSIT = Number(BOOKING_DEPOSIT_SAR) || 30;
const PAY_TTL = Math.max(60, parseInt(PAY_INTENT_TTL_SECONDS, 10) || 600);


  if (DEV_MODE) console.log('✅ DEV_OTP_BYPASS=true → سيتم تجاوز الإرسال الفعلي والاكتفاء بالطباعة في الكونسول');


/* ========== Redis ========== */
const isTLS = REDIS_URL?.startsWith('rediss://');
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3, tls: isTLS ? {} : undefined });
await redis.connect().catch((e) => { console.error('❌ Redis error:', e.message || e); process.exit(1); });

const pub = new Redis(REDIS_URL, { tls: isTLS ? {} : undefined });
const sub = new Redis(REDIS_URL, { tls: isTLS ? {} : undefined });

/* ========== Helpers ========== */
const ymNow = () => new Date().toISOString().slice(0,7);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nidHash = (nid) => sha256(PEPPER + String(nid));
const nowISO = () => new Date().toISOString();
const maskPhone = (e164) => (e164 ? `05••••${String(e164).slice(-4)}` : null);
const signJWT = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });


const adminOtpKey = (tx) => `admin:otp:${tx}`;

const signAdminJWT = () =>
  jwt.sign({ role: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '2h' });

function requireAdminAuth(req, res, next) {

  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });

    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }

    next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}


/* ========== 4jawaly SMS OTP (CORRECT) ========== */
const {
  FORJAWALY_API_KEY,
  FORJAWALY_API_SECRET,
  FORJAWALY_SENDER,
} = process.env;

async function sendOtpSms(phoneE164, message) {
  
  // 👈 ضع هذا السطر هنا بالضبط
  if (DEV_MODE) {
    console.log('[DEV MODE] OTP:', message, '→', phoneE164);
    return true; // لا يرسل SMS ولا يخصم رصيد
  }
  if (!FORJAWALY_API_KEY || !FORJAWALY_API_SECRET) {
    if (DEV_MODE) {
      console.log('[DEV] SMS skipped:', phoneE164, message);
      return true;
    }
    throw new Error('sms_credentials_missing');
  }

  const url = 'https://api-sms.4jawaly.com/api/v1/account/area/sms/send';

  const payload = {
  messages: [
    {
      text: message,
      numbers: [phoneE164.replace('+', '')],
      number_iso: 'SA',
    },
  ],
  globals: {
    sender: 'PhenixCL',
  },
};


  try {
    const res = await axios.post(url, payload, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'PhoenixClinic/1.0',
        Authorization:
          'Basic ' +
          Buffer.from(
            `${FORJAWALY_API_KEY}:${FORJAWALY_API_SECRET}`
          ).toString('base64'),
      },
      timeout: 15000,
    });

    console.log('[SMS] 4jawaly OK:', res.data);
    return true;
  } catch (err) {
    console.error('[SMS] 4jawaly ERROR:', err.response?.data || err.message);
    if (!DEV_MODE) throw err;
    return false;
  }
}






const keyIndex     = (hash) => `idx:${hash}`;
const keyOtp       = (tx)   => `otp:${tx}`;
const keyProfile   = (hash) => `profile:${hash}`;
const keyBookings  = (hash) => `bookings:${hash}`;
const keyPhoneIndex = (phone) => `phone:index:${phone}`;
// 🔔 تذكيرات المواعيد (قبل الموعد بساعة)
const REMINDERS_ZSET = 'fcm:reminders';




const slotsKey     = (clinicId, ym) => `imdad:slots:${clinicId}:${ym}`;
const lockKey      = (slotId)       => `imdad:lock:${slotId}`;
const updatesChan  = (clinicId, ym) => `imdad:updates:${clinicId}:${ym}`;

// طابور خاص بإنشاء ملف جديد في إمداد
const NEWFILE_QUEUE_KEY = 'q:imdad:newfile';
// طابور إلغاء الموعد في إمداد
const CANCEL_QUEUE_KEY = 'q:imdad:cancel';

const newFileQueuedKey  = (nid) => `imdad:newfile:queued:${nid}`;

const payIntentKey = (id) => `pay:intent:${id}`;
const makeBookingId = (slot) => `bk_${slot.date.replace(/-/g,'')}_${slot.id}`;

/* -------- normalize YYYY-MM from inputs -------- */
function normalizeYm(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

/* ========== Seed / Slots storage (mock) ========== */
let seededOnce = false;
function seedMockSlots(clinicId, ym) {
  if (seededOnce) return null;
  const [yyyy, mm] = ym.split('-');
  const d = (day, time, docId, docName, srvId, srvName) => ({
    id: Number(`${day}${time.replace(':','')}${docId.length}`),
    date: `${yyyy}-${mm}-${String(day).padStart(2, '0')}`,
    time,
    doctorId: docId,
    doctorName: docName,
    serviceId: srvId,
    serviceName: srvName,
    available: true,
  });

  const base = [
    d(16,'10:00','d_ryan','د. ريان صديق (أسنان)','srv_cleaning','تنظيف الأسنان'),
    d(16,'11:00','d_walaa','د. ولاء (جلدية)','srv_teeth_whitening','تبييض الأسنان'),
    d(16,'12:00','d_hanadi','د. هنادي إدريس (طب عام)','srv_obgyn','كشف عام'),
    d(16,'13:00','d_ronaldo','د. رونالدو كروز (أسنان)','srv_root','حشو عصب'),
    d(16,'14:00','d_abeer','د. عبير إبراهيم (أسنان)','srv_teeth_whitening','تبييض الأسنان'),
    d(16,'15:00','d_moath','د. معاذ علي (أسنان)','srv_cleaning','تنظيف الأسنان'),
    d(16,'16:00','d_ahmed_khalil','د. أحمد عبدالله خليل (أسنان)','srv_cleaning','تنظيف الأسنان'),
  ];
  seededOnce = true;
  return base;
}

async function ensureSlots(clinicId, ym) {
  const k = slotsKey(clinicId, ym);
  let raw = await redis.get(k);
  if (!raw) {
    const seeded = seedMockSlots(clinicId, ym) || [];
    await redis.set(k, JSON.stringify(seeded));
    raw = JSON.stringify(seeded);
  }
  return JSON.parse(raw);
}
async function saveSlots(clinicId, ym, slots) {
  await redis.set(slotsKey(clinicId, ym), JSON.stringify(slots));
  await pub.publish(updatesChan(clinicId, ym), JSON.stringify({ type: 'slots:update', at: nowISO(), slots }));
}
// جدولة تذكير قبل الموعد بساعة
async function scheduleReminderForBooking(nid, booking) {
  try {
    if (!booking.start_ts || !booking.start_iso) return;

    // نحسب وقت التذكير = وقت الموعد - ساعة
    const reminderAt = booking.start_ts - 60 * 60 * 1000;
    if (reminderAt <= Date.now()) return; // لو باقي أقل من ساعة لا نرسل تذكير

    const payload = {
      nid,
      booking_id: booking.id,
      date: booking.date,
      time: booking.time,
      serviceName: booking.serviceName,
      doctorName: booking.doctorName,
      start_iso: booking.start_iso,
    };

    // نستخدم ZSET: score = وقت التذكير (ms)
    await redis.zadd(
      REMINDERS_ZSET,
      reminderAt,
      JSON.stringify(payload),
    );

    console.log('[REMINDER] scheduled 1h before for booking', booking.id);
  } catch (e) {
    console.error('scheduleReminderForBooking error:', e);
  }
}

/* ========== Profiles & Bookings store ========== */
async function getProfile(nid) {
  const hash = nidHash(nid);
  const raw = await redis.get(keyProfile(hash));
  return raw ? JSON.parse(raw) : null;
}
async function setProfile(nid, data) {
  const hash = nidHash(nid);
  await redis.set(keyProfile(hash), JSON.stringify({ ...data, updated_at: nowISO() }));
}
// طابور إنشاء ملف جديد في إمداد لمرة واحدة لكل رقم هوية
async function enqueueNewFileJobForSignup(nid) {
  if (!nid) return;

  const already = await redis.get(newFileQueuedKey(nid));
  if (already) return;

  const profile = await getProfile(nid);
  if (!profile) return;

  const job = {
    id: 'nf_' + crypto.randomBytes(8).toString('hex'),
    nid,
    fullName: profile.fullName || 'مراجع',
    phone_e164: profile.phone_e164 || null,
    gender: profile.gender || null,
    birth_date: profile.birth_date || null,
    nationality: profile.nationality || null,
    created_at: nowISO(),
  };

  await redis.rpush(NEWFILE_QUEUE_KEY, JSON.stringify(job));
  await redis.set(newFileQueuedKey(nid), '1', 'EX', 60 * 60 * 24 * 30);

  console.log('[NEWFILE] enqueued job for nid=', nid);
}



// فهرس ثانوي: من booking_id -> nid
const keyBookingIndex = (bookingId) => `booking:index:${bookingId}`;

async function getBookings(nid) {
  const raw = await redis.get(keyBookings(nidHash(nid)));
  return raw ? JSON.parse(raw) : [];
}

async function saveBooking(nid, booking) {
  const k = keyBookings(nidHash(nid));
  const arr = await getBookings(nid);
  arr.push(booking);
  await redis.set(k, JSON.stringify(arr));

  // فهرس عكسي: booking_id -> nid (لأجل العامل)
  await redis.set(
    keyBookingIndex(booking.id),
    String(nid),
    'EX',
    60 * 60 * 24 * 30, // 30 يوم
  );

  // 🔔 جدولة تذكير قبل الموعد بساعة
  try {
    if (booking.status === 'confirmed') {
      await scheduleReminderForBooking(nid, booking);
    }
  } catch (e) {
    console.error('[REMINDER] schedule error:', e);
  }
}


async function updateBookingStatus(nid, bookingId, patch = {}) {
  const k = keyBookings(nidHash(nid));
  const raw = await redis.get(k);
  if (!raw) return false;

  const arr = JSON.parse(raw);
  const i = arr.findIndex((b) => String(b.id) === String(bookingId));
  if (i === -1) return false;

  arr[i] = { ...arr[i], ...patch, updated_at: nowISO() };
  await redis.set(k, JSON.stringify(arr));
  return true;
}


/* ========== Auth middleware ========== */
function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

/* ========== Legacy ID check + OTP + Login/Signup (كما هي) ========== */
// ... (كل مسارات check-id / otp / login / signup — نفس كودك السابق دون تعديل جوهري)
app.post('/api/auth/check-id', async (req, res) => {
  try {
    const { nid } = req.body || {};
    if (!nid) return res.status(400).json({ error: 'nid_required' });
    const hash = nidHash(nid);
    const idxKey = keyIndex(hash);

    const cachedStr = await redis.get(idxKey);
    if (cachedStr) {
      const cached = JSON.parse(cachedStr);
      return res.json({ exists: cached.exists, file_id: cached.file_id || null, phone_e164: cached.phone_e164 || null, masked_phone: cached.masked_phone || null, stale: false });
    }

    const exists = String(nid).trim().length >= 10;
    const phone = exists ? '+966551234123' : null;
    const payload = { exists, file_id: exists ? 'PC-43210' : null, phone_e164: phone, masked_phone: maskPhone(phone), last_checked_at: nowISO() };
    await redis.set(idxKey, JSON.stringify(payload), 'EX', INDEX_TTL);

    return res.json(
      exists ? { exists: true, file_id: 'PC-43210', phone_e164: phone, masked_phone: maskPhone(phone), stale: false }
             : { exists: false, message: 'not_found' },
    );
  } catch (e) {
    console.error('check-id error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// حفظ FCM token للمستخدم الحالي
app.post('/api/me/fcm-token', requireAuth, async (req, res) => {
  try {
    const { fcmToken } = req.body || {};

    if (!fcmToken || typeof fcmToken !== 'string') {
      return res.status(400).json({ ok: false, error: 'fcmToken_required' });
    }

    // نستخدم أي معرف ثابت عندك في الـ JWT (nid أو id)
    const userId = req.user?.nid || req.user?.id;
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'user_missing' });
    }

    const key = `user:fcm:${userId}`;
    await redis.set(key, fcmToken);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[FCM] save token error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});


app.post('/api/otp/send', async (req, res) => {
  try {
    const { nid } = req.body || {};
    if (!nid) return res.status(400).json({ error: 'nid_required' });

    const hash = nidHash(nid);
    const idxKey = keyIndex(hash);
    const cachedStr = await redis.get(idxKey);
    if (!cachedStr) return res.status(400).json({ error: 'nid_not_indexed' });

    const cached = JSON.parse(cachedStr);
    if (!cached.exists || !cached.phone_e164) {
      return res.status(400).json({ error: 'nid_not_found_or_no_phone' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const tx = 'otp_' + crypto.randomBytes(8).toString('hex');

    await sendOtpSms(
      cached.phone_e164,
      `رمز التحقق: ${code}\nصالح لمدة ${OTP_TTL} ثانية.`
    );

    await redis.set(
      keyOtp(tx),
      JSON.stringify({
        nidHash: hash,
        code,
        expAt: Date.now() + OTP_TTL * 1000,
        flow: 'legacy',
      }),
      'EX',
      OTP_TTL
    );

    return res.json({
      sent: true,
      tx,
      masked_phone: cached.masked_phone,
    });

  } catch (e) {
    console.error('otp/send error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


app.post('/api/otp/verify', async (req, res) => {
  try {
    const { nid, code, tx } = req.body || {};
    if (!nid || !code || !tx) return res.status(400).json({ error: 'invalid_payload' });

    const hash = nidHash(nid);
    const otpStr = await redis.get(keyOtp(tx));
    if (!otpStr) return res.status(400).json({ error: 'tx_not_found_or_expired' });

    const rec = JSON.parse(otpStr);
    if (rec.nidHash !== hash) return res.status(400).json({ error: 'nid_mismatch' });
    if (rec.code !== String(code)) return res.status(400).json({ error: 'code_invalid' });

    await redis.del(keyOtp(tx));

    const profile = (await getProfile(nid)) || { fullName: 'مراجع', phone_e164: null, role: 'client' };
    const token = signJWT({ nid, role: profile.role || 'client' });
    return res.json({ ok: true, token, role: profile.role || 'client', profile });
  } catch (e) {
    console.error('otp/verify error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/auth/login/start', async (req, res) => {
  try {
    const { nid } = req.body || {};
    if (!nid) return res.status(400).json({ error: 'nid_required' });

    const hash = nidHash(nid);

    // 1) تحقق إن عنده بروفايل ومفعّل
    const profile = await getProfile(nid);
    if (!profile || !profile.verified) {
      return res.json({
        need_signup: true,
        reason: !profile ? 'no_profile' : 'not_verified',
      });
    }

    // 2) كول داون
    const cdKey = otpCooldownKey('login', nid);
    const cdTtl = await redis.ttl(cdKey);
    if (cdTtl > 0) {
      return res.status(429).json({
        error: 'otp_cooldown',
        retry_after: cdTtl,
      });
    }

    // 3) تحديث فهرس check-id
    const idxPayload = {
      exists: true,
      file_id: profile.file_id || 'PC-NEW',
      phone_e164: profile.phone_e164,
      masked_phone: maskPhone(profile.phone_e164),
      last_checked_at: nowISO(),
    };
    await redis.set(keyIndex(hash), JSON.stringify(idxPayload), 'EX', INDEX_TTL);

    // 4) إرسال OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const tx = 'otp_' + crypto.randomBytes(8).toString('hex');

    console.log(`[LOGIN] nid=${nid} code=${code} tx=${tx}`);

    await sendOtpSms(
  profile.phone_e164,
  `رمز التحقق: ${code}\nصالح لمدة ${OTP_TTL} ثانية.`
);


    // 5) حفظ OTP
    await redis.set(
      keyOtp(tx),
      JSON.stringify({
        nidHash: hash,
        code,
        expAt: Date.now() + OTP_TTL * 1000,
        flow: 'login',
      }),
      'EX',
      OTP_TTL
    );

    // 6) كول داون 60 ثانية
    await redis.set(cdKey, '1', 'EX', OTP_COOLDOWN);

    return res.json({
      ok: true,
      sent: true,
      tx,
      masked_phone: maskPhone(profile.phone_e164),
    });
  } catch (e) {
    console.error('login/start error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});
// 🔁 إعادة إرسال OTP في تسجيل الدخول (من صفحة OTP)
app.post('/api/auth/login/resend', async (req, res) => {
  try {
    const { nid } = req.body || {};
    if (!nid) return res.status(400).json({ error: 'nid_required' });

    const hash = nidHash(nid);

    // 1) تأكد أن عنده بروفايل ومفعّل
    const profile = await getProfile(nid);
    if (!profile || !profile.verified) {
      return res.status(400).json({ error: 'profile_not_verified' });
    }

    // 2) كول داون
    const cdKey = otpCooldownKey('login', nid);
    const cdTtl = await redis.ttl(cdKey);
    if (cdTtl > 0) {
      return res.status(429).json({
        error: 'otp_cooldown',
        retry_after: cdTtl,
      });
    }

    // 3) إرسال OTP جديد
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const tx = 'otp_' + crypto.randomBytes(8).toString('hex');

    console.log(`[LOGIN-RESEND] nid=${nid} code=${code} tx=${tx}`);

    await sendOtpSms(
  profile.phone_e164,
  `رمز التحقق: ${code}\nصالح لمدة ${OTP_TTL} ثانية.`
);


    // 4) حفظ OTP الجديد + كول داون
    await redis.set(
      keyOtp(tx),
      JSON.stringify({
        nidHash: hash,
        code,
        expAt: Date.now() + OTP_TTL * 1000,
        flow: 'login',
      }),
      'EX',
      OTP_TTL
    );

    await redis.set(cdKey, '1', 'EX', OTP_COOLDOWN);

    return res.json({
      ok: true,
      sent: true,
      tx,
      masked_phone: maskPhone(profile.phone_e164),
    });
  } catch (e) {
    console.error('login/resend error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});


app.post('/api/auth/login/confirm', async (req, res) => {
  try {
    const { nid, code, tx } = req.body || {};
    if (!nid || !code || !tx) return res.status(400).json({ error: 'invalid_payload' });

    const hash = nidHash(nid);
    const otpStr = await redis.get(keyOtp(tx));
    if (!otpStr) return res.status(400).json({ error: 'tx_not_found_or_expired' });

    const rec = JSON.parse(otpStr);
    if (rec.nidHash !== hash) return res.status(400).json({ error: 'nid_mismatch' });
    if (rec.code !== String(code)) return res.status(400).json({ error: 'code_invalid' });

    const profile = (await getProfile(nid));
    if (!profile) return res.json({ need_signup: true });

    await redis.del(keyOtp(tx));

    const token = signJWT({ nid, role: profile.role || 'client' });
    return res.json({ ok: true, token, role: profile.role || 'client', profile });
  } catch (e) {
    console.error('login/confirm error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

   // باقي الكود كما عدّلناه سابقاً (existingProfile, phone check, setProfile ...)
app.post('/api/auth/signup/start', async (req, res) => {
  try {
    const { nid, fullName, phone_e164, gender, birth_date, nationality } = req.body || {};
    if (!nid || !fullName || !phone_e164) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const hash = nidHash(nid);
    const phoneKey = keyPhoneIndex(phone_e164);

    // 👈 كول داون للـ OTP (flow = signup)
    const cdKey = otpCooldownKey('signup', nid);
    const cdTtl = await redis.ttl(cdKey);
    if (cdTtl > 0) {
      return res.status(429).json({
        error: 'otp_cooldown',
        retry_after: cdTtl,
      });
    }

    // 1) هل عنده بروفايل من قبل بنفس الهوية؟
    const existingProfile = await getProfile(nid);

    // لو عنده حساب مفعّل (verified=true) → نمنع تسجيل جديد
    if (existingProfile && existingProfile.verified) {
      return res.status(409).json({ error: 'nid_already_has_account' });
    }

    // 2) هل رقم الجوال مستخدم لحساب آخر (غير نفس الهوية)؟
    const existingNidForPhone = await redis.get(phoneKey);
    if (existingNidForPhone && existingNidForPhone !== String(nid)) {
      return res.status(409).json({
        error: 'phone_already_used',
        by_nid: existingNidForPhone,
      });
    }

    // 3) احفظ / حدّث البروفايل بوضع pending (verified=false)
    const base = existingProfile || {};
    await setProfile(nid, {
      ...base,
      nid,
      fullName,
      phone_e164,
      role: 'client',
      gender,
      birth_date,
      nationality,
      verified: false, // 👈 مهم: الحساب لم يُفعّل بعد
      created_at: base.created_at || nowISO(),
    });

    // اربط الجوال بالهوية في الفهرس
    await redis.set(phoneKey, String(nid));

    // 4) أرسل OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const tx = 'otp_' + crypto.randomBytes(8).toString('hex');
    console.log(`[SIGNUP] nid=${nid} code=${code} tx=${tx}`);

    await sendOtpSms(
  phone_e164,
  `رمز التحقق: ${code}\nصالح لمدة ${OTP_TTL} ثانية.`
);


    await redis.set(
      keyOtp(tx),
      JSON.stringify({
        nidHash: hash,
        code,
        expAt: Date.now() + OTP_TTL * 1000,
        flow: 'signup',
      }),
      'EX',
      OTP_TTL
    );

    // فهرس check-id القديم (عشان التوافُق)
    await redis.set(
      keyIndex(hash),
      JSON.stringify({
        exists: true,
        file_id: 'PC-NEW',
        phone_e164,
        masked_phone: maskPhone(phone_e164),
        last_checked_at: nowISO(),
      }),
      'EX',
      INDEX_TTL
    );

    // 👈 فعّل كول داون ٦٠ ثانية
    await redis.set(cdKey, '1', 'EX', OTP_COOLDOWN);

    return res.json({ sent: true, tx, masked_phone: maskPhone(phone_e164) });
  } catch (e) {
    console.error('signup/start error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// 🔁 إعادة إرسال OTP في إنشاء الحساب (من صفحة OTP)
app.post('/api/auth/signup/resend', async (req, res) => {
  try {
    const { nid } = req.body || {};
    if (!nid) return res.status(400).json({ error: 'nid_required' });

    const hash = nidHash(nid);

    const profile = await getProfile(nid);
    if (!profile) {
      return res.status(400).json({ error: 'profile_not_found' });
    }
    if (profile.verified) {
      return res.status(409).json({ error: 'already_verified' });
    }

    const cdKey = otpCooldownKey('signup', nid);
    const cdTtl = await redis.ttl(cdKey);
    if (cdTtl > 0) {
      return res.status(429).json({
        error: 'otp_cooldown',
        retry_after: cdTtl,
      });
    }

    const phone_e164 = profile.phone_e164;
    if (!phone_e164) {
      return res.status(400).json({ error: 'no_phone_for_profile' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const tx = 'otp_' + crypto.randomBytes(8).toString('hex');
    console.log(`[SIGNUP-RESEND] nid=${nid} code=${code} tx=${tx}`);

    await sendOtpSms(
  phone_e164,
  `رمز التحقق: ${code}\nصالح لمدة ${OTP_TTL} ثانية.`
);


    await redis.set(
      keyOtp(tx),
      JSON.stringify({
        nidHash: hash,
        code,
        expAt: Date.now() + OTP_TTL * 1000,
        flow: 'signup',
      }),
      'EX',
      OTP_TTL
    );

    await redis.set(cdKey, '1', 'EX', OTP_COOLDOWN);

    return res.json({
      ok: true,
      sent: true,
      tx,
      masked_phone: maskPhone(phone_e164),
    });
  } catch (e) {
    console.error('signup/resend error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});


// ✅ تأكيد إنشاء الحساب عبر OTP
app.post('/api/auth/signup/confirm', async (req, res) => {
  try {
    const { nid, code, tx } = req.body || {};
    if (!nid || !code || !tx) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const hash = nidHash(nid);

    // نجيب الـ OTP من Redis
    const otpStr = await redis.get(keyOtp(tx));
    if (!otpStr) {
      return res.status(400).json({ error: 'tx_not_found_or_expired' });
    }

    const rec = JSON.parse(otpStr);

    // تأكد أن الهوية لنفس العملية
    if (rec.nidHash !== hash) {
      return res.status(400).json({ error: 'nid_mismatch' });
    }

    // تأكد من الرمز
    if (rec.code !== String(code)) {
      return res.status(400).json({ error: 'code_invalid' });
    }

    // احذف الـ OTP بعد الاستخدام
    await redis.del(keyOtp(tx));

    // لازم يكون البروفايل محفوظ من signup/start
        // لازم يكون البروفايل محفوظ من signup/start
    const profile = await getProfile(nid);
    if (!profile) {
      return res.status(400).json({ error: 'profile_not_found' });
    }

    // فعّل الحساب: verified=true
    await setProfile(nid, {
      ...profile,
      verified: true,
      updated_at: nowISO(),
    });

    // أنشئ توكن JWT
    const token = signJWT({ nid, role: profile.role || 'client' });

// دفع Job إلى طابور إنشاء الملف في إمداد
try {
  const job = {
    id: 'nf_' + crypto.randomBytes(8).toString('hex'),
    nid,
    fullName: profile.fullName,
    phone_e164: profile.phone_e164,
    gender: profile.gender,
    birth_date: profile.birth_date,
    nationality: profile.nationality,
    attempts: 0,
    created_at: Date.now(),
  };

  await redis.rpush(NEWFILE_QUEUE_KEY, JSON.stringify(job));
  console.log('[NEWFILE] enqueued job for nid=', nid);

} catch (err) {
  console.error('enqueue NEWFILE error:', err.message || err);
}


// ثم الـ return لا تلمسه
return res.json({
  ok: true,
  token,
  role: profile.role || 'client',
  profile,
});

  } catch (e) {
    console.error('signup/confirm error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

function canCancel(start_iso) {
  const now = Date.now();
  const appt = Date.parse(start_iso);
  const diffMs = appt - now;
  const diffHours = diffMs / 1000 / 60 / 60;
  return diffHours >= 2; // يسمح إذا باقي ساعتين أو أكثر
}

/* ================== Utils for times ================== */
function toIsoDate(dateStr) {
  const p = String(dateStr).split('-').map(s => s.trim());
  if (p[0].length === 4) return `${p[0]}-${p[1].padStart(2,'0')}-${p[2].padStart(2,'0')}`;
  return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
}
function parseArabicTimeTo24(timeStr) {
  const s = String(timeStr).replace(/\s+/g,'').toLowerCase();
  const isPM = s.includes('م');
  const isAM = s.includes('ص');
  const core = s.replace(/[مص]/g,'');
  let [hh, mm] = core.split(':').map(x => parseInt(x,10));
  if (isPM && hh < 12) hh += 12;
  if (isAM && hh === 12) hh = 0;
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}
function buildStartISO(dateStr, timeStr) {
  const d = toIsoDate(dateStr);
  const t24 = parseArabicTimeTo24(timeStr);
  return `${d}T${t24}:00+03:00`;
}
// يبحث عن slot_id في جميع مفاتيح imdad:slots:<clinicId>:*
async function findSlotInAnyMonth(clinicId, slotId) {
  const pattern = `imdad:slots:${clinicId}:*`;
  const keys = await redis.keys(pattern); // مثلا: imdad:slots:phoenix-main:2025-11

  for (const k of keys) {
    const ym = k.split(':').pop(); // يأخذ 2025-11 من آخر جزء
    const raw = await redis.get(k);
    if (!raw) continue;

    let slots;
    try {
      slots = JSON.parse(raw);
    } catch (_) {
      continue;
    }

    const slot = slots.find((s) => String(s.id) === String(slotId));
    if (slot) {
      return { slot, ym }; // رجّع الموعد + الشهر الصحيح
    }
  }

  return null;
}
// أقل / أعلى فرق أيام بين الجلسة والرتوش (يمكن تعديلها لاحقًا)
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LASER_RETOUCH_MIN_DAYS = 10; // أقل شيء 10 أيام
const LASER_RETOUCH_MAX_DAYS = 13; // أعلى شيء 13 يوم

// نحدد إن هذا الموعد يخص "الليزر" فقط
function isLaserSlot(slot) {
  const service = (slot.serviceName || '').toString();
  const clinic  = (slot.clinicName || slot.doctorName || '').toString();
  const txt = service + ' ' + clinic;
  return txt.includes('الليزر');
}

// 🆕 دالة تبحث عن سلوْت الرتوش حسب البيانات الجاية من التطبيق
async function findRetouchSlotFromRequest(clinicId, wanted, mainSlot) {
  if (!wanted) return null;

  const pattern = `imdad:slots:${clinicId}:*`;
  const keys = await redis.keys(pattern);
  if (!keys.length) return null;

  for (const k of keys) {
    const ym = k.split(':').pop();
    const raw = await redis.get(k);
    if (!raw) continue;

    let list;
    try { list = JSON.parse(raw); } catch { continue; }

    for (const s of list) {
      if (!s || !s.available) continue;

      // 🔒 مهم: الرتوش لازم يكون ليزر
      if (!isLaserSlot(s)) continue;

      // 🔒 مهم: نفس مجموعة الليزر (نساء)
      if (mainSlot?.doctorId && !s.doctorId.startsWith('d_laser')) continue;

      // تطابق بالـ slot_id
      if (wanted.slot_id && String(s.id) === String(wanted.slot_id)) {
        return { slot: s, ym };
      }
    }
  }
  return null;
}


// نرجع أول موعد ليزر متاح للرتوش بعد الجلسة الأساسية (لو ما وصلنا سلوْت جاهز)
async function findFirstLaserRetouchSlot(clinicId, mainSlot) {
  try {
    const mainIso = toIsoDate(mainSlot.date);
    const mainTs  = Date.parse(mainIso);
    if (!mainTs || Number.isNaN(mainTs)) return null;

    const minTs = mainTs + LASER_RETOUCH_MIN_DAYS * ONE_DAY_MS;
    const maxTs = mainTs + LASER_RETOUCH_MAX_DAYS * ONE_DAY_MS;

    const pattern = `imdad:slots:${clinicId}:*`;
    const keys = await redis.keys(pattern);
    if (!keys.length) return null;

    const candidates = [];

    for (const k of keys) {
      const ym = k.split(':').pop();
      const raw = await redis.get(k);
      if (!raw) continue;

      let list;
      try { list = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(list)) continue;

      for (const s of list) {
        if (!s || !s.available) continue;
        if (String(s.id) === String(mainSlot.id)) continue;
        if (!isLaserSlot(s)) continue;

        const dIso = toIsoDate(s.date);
        const ts   = Date.parse(dIso);
        if (!ts || Number.isNaN(ts)) continue;

        if (ts < minTs || ts > maxTs) continue;

        candidates.push({ slot: s, ym, ts });
      }
    }

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      const ta = (a.slot.time || '').toString();
      const tb = (b.slot.time || '').toString();
      return ta.localeCompare(tb, 'ar');
    });

    return candidates[0]; // { slot, ym, ts }
  } catch (e) {
    console.error('[laser/retouch] findFirstLaserRetouchSlot error:', e.message || e);
    return null;
  }
}


/* ================== Imdad mock API ================== */
app.get('/api/imdad-available-times', async (req, res) => {
  const clinicId = String(req.query.clinic || '');
  const month = String(req.query.month || '');

  const serviceId = String(req.query.service || '');

  let allowedLaserDoctors = null;

  if (serviceId === 'laser_men') {
    allowedLaserDoctors = ['d_laser_men_am'];
  }

  if (serviceId === 'laser_women') {
    allowedLaserDoctors = [
      'd_laser_women_pm',
      'd_laser_am',
      'd_laser_pm',
    ];
  }

  try {


    const clinicId = String(req.query.clinic || IMDAD_DEFAULT_CLINIC_ID);

    // لو المستخدم أرسل month نلتزم به، غير كذا نرجّع الشهر الحالي + القادم
    const explicitYm = normalizeYm(req.query.month);
    const now = new Date();

    const ym1 = now.toISOString().slice(0, 7); // الشهر الحالي
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const ym2 = next.toISOString().slice(0, 7); // الشهر القادم

    const months = explicitYm ? [explicitYm] : [ym1, ym2];

    const todayIso = now.toISOString().slice(0, 10); // YYYY-MM-DD
    let all = [];

    for (const ym of months) {
      // 👈 مهم: نستخدم ensureSlots عشان نقرأ من الكاش
      const list = await ensureSlots(clinicId, ym);
      if (!Array.isArray(list)) continue;

      all.push(
  ...list.filter((s) => {
    const d = (s.date || '').toString().slice(0, 10);
    if (d && d <= todayIso) return false;

    // 🔥 فلترة الليزر حسب نوع الخدمة
    if (allowedLaserDoctors) {
      return allowedLaserDoctors.includes(s.doctorId);
    }

    return true;
  }),
);

    }

    // ترتيب
    all.sort((a, b) => {
      const ad = (a.date || '').toString();
      const bd = (b.date || '').toString();
      if (ad !== bd) return ad.localeCompare(bd);
      const at = (a.time || '').toString();
      const bt = (b.time || '').toString();
      return at.localeCompare(bt, 'ar');
    });

    return res.json({
      ok: true,
      clinicId,
      months,
      slots: all,
    });
  } catch (e) {
    console.error('imdad-available-times error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


app.get('/api/imdad-stream', async (req, res) => {
  try {
    const clinicId = String(req.query.clinic_id || IMDAD_DEFAULT_CLINIC_ID);
    const ym = normalizeYm(req.query.month) || IMDAD_DEFAULT_MONTH || ymNow();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const channel = updatesChan(clinicId, ym);
    await sub.subscribe(channel);

    const snapshot = await ensureSlots(clinicId, ym);
    res.write(`event: init\ndata: ${JSON.stringify({ slots: snapshot, at: nowISO() })}\n\n`);

    const onMessage = (chan, message) => {
      if (chan !== channel) return;
      res.write(`event: update\ndata: ${message}\n\n`);
    };
    sub.on('message', onMessage);

    const pingId = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ at: nowISO() })}\n\n`);
    }, 15000);

    req.on('close', async () => {
      clearInterval(pingId);
      sub.removeListener('message', onMessage);
      try { await sub.unsubscribe(channel); } catch {}
    });
  } catch (e) {
    console.error('imdad-stream error:', e);
    try { res.end(); } catch {}
  }
});

app.post('/api/imdad/lock', requireAuth, async (req, res) => {
  try {
    const { slot_id } = req.body || {};
    if (!slot_id) return res.status(400).json({ error: 'slot_id_required' });

    const owner = req.user?.nid || 'unknown';
    const key = lockKey(slot_id);

    const ok = await redis.set(key, JSON.stringify({ owner, at: nowISO() }), 'EX', LOCK_TTL, 'NX');
    if (ok !== 'OK') return res.status(409).json({ error: 'already_locked' });

    const clinicId = String(req.query.clinic_id || IMDAD_DEFAULT_CLINIC_ID);
    const ym = String(req.query.month || IMDAD_DEFAULT_MONTH);
    await pub.publish(updatesChan(clinicId, ym), JSON.stringify({ type: 'slot:locked', slot_id, owner, at: nowISO(), ttl: LOCK_TTL }));

    return res.json({ ok: true, locked: true, ttl: LOCK_TTL });
  } catch (e) {
    console.error('imdad/lock error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});
app.post('/api/imdad/confirm', requireAuth, async (req, res) => {
  try {
    const { slot_id, retouch } = req.body || {};
    const note = String(req.body?.note || '').trim();

    if (!slot_id) return res.status(400).json({ error: 'slot_id_required' });

    const clinicId = String(req.query.clinic_id || IMDAD_DEFAULT_CLINIC_ID);
    let ym = normalizeYm(req.query.month) || IMDAD_DEFAULT_MONTH || ymNow();
    const nid = req.user?.nid;
    if (!nid) return res.status(401).json({ error: 'unauthorized' });

    /* ✅ القفل أصبح اختياري:
       - لو موجود ومملوك لشخص آخر → نرجّع خطأ
       - لو غير موجود أو مملوك لنفس الشخص → نكمل عادي
    */
    const lkKey = lockKey(slot_id);
    const lkRaw = await redis.get(lkKey);
    if (lkRaw) {
      const lk = JSON.parse(lkRaw);
      if (lk.owner && lk.owner !== nid) {
        return res.status(403).json({ error: 'lock_owned_by_another' });
      }
    }

    // ✅ جب الـ slots حسب الشهر
    let slots = await ensureSlots(clinicId, ym);
    let idx = slots.findIndex((s) => String(s.id) === String(slot_id));

    // لو ما لقيناه، جرّب كل الأشهر (احتياط)
    if (idx === -1) {
      const found = await findSlotInAnyMonth(clinicId, slot_id);
      if (!found) return res.status(404).json({ error: 'slot_not_found' });
      ym = found.ym;
      slots = await ensureSlots(clinicId, ym);
      idx = slots.findIndex((s) => String(s.id) === String(slot_id));
      if (idx === -1) return res.status(404).json({ error: 'slot_not_found' });
    }

    const slot = slots[idx];

    // لو محجوز أصلاً → نرجّع ok بدون إنشاء حجز جديد
    if (!slot.available) {
      await redis.del(lkKey).catch(() => {});
      return res.json({ ok: true, already: true, slot });
    }

    // ✅ علّم الموعد كمحجوز في الكاش
    slots[idx] = { ...slot, available: false, bookedBy: nid, bookedAt: nowISO() };
    await saveSlots(clinicId, ym, slots);
    await redis.del(lkKey).catch(() => {});

    await pub.publish(
      updatesChan(clinicId, ym),
      JSON.stringify({ type: 'slot:confirmed', slot_id, owner: nid, at: nowISO() })
    );

    // ✅ أنشئ Booking في "مواعيدي"
    const start_iso = buildStartISO(slot.date, slot.time);
    const start_ts = Date.parse(start_iso);

    const booking = {
      id: makeBookingId(slot),
      nid,
      clinicId,
      date: toIsoDate(slot.date),
      time: slot.time,
      start_iso,
      start_ts,
      doctorId: slot.doctorId,
      doctorName: slot.doctorName,
      serviceId: slot.serviceId,
      serviceName: slot.serviceName,
      price: DEPOSIT,
      status: 'confirmed',
      ssRaw: slot.ssRaw || null,
      created_at: nowISO(),
      invoice: {
        amount: DEPOSIT,
        currency: 'SAR',
        paid_at: nowISO(),
        provider: 'direct',
        reference: 'DIR-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
        note: 'حجز مؤكد بدون بوابة دفع إلكترونية.',
      },
    };

    await saveBooking(nid, booking);
    // 📊 تحديث الإحصائيات
await redis.incr('stats:bookings:total');

const today =
  new Date().toISOString().slice(0, 10);

const dayKey =
  'stats:bookings:day:' + today;

await redis.incr(dayKey);



const clinicName =
  booking.serviceName || booking.doctorName || booking.clinicId;

const clinicKey =
  'stats:bookings:clinic:' + clinicName;

await redis.incr(clinicKey);



    await redis.set(keyBookingIndex(booking.id), String(nid), 'EX', 60 * 60 * 24 * 30);

    // ✅ جهّز Job للبوت
    const profile = await getProfile(nid);
    const fullName = profile?.fullName || 'مراجع';
    const phone = profile?.phone_e164 || null;

          // ===== 1) جهّز Job الجلسة الأساسية =====
    const jobPayload = {
  id: nanoid(16),
  job_key: hashJobKey({
    nid: booking.nid,
    clinicId: booking.clinicId,
    date: booking.date,
    time: booking.time,
    doctorId: booking.doctorId || 'unknown',
  }),
  booking_id: booking.id,
  nid: booking.nid,
  phone,
  fullName,
  clinicId: booking.clinicId,
  doctorId: booking.doctorId,
  serviceId: booking.serviceId || null,
  date: booking.date,
  time: booking.time,
  ssRaw: slot.ssRaw || booking.ssRaw || null,
  attempts: 0,
  status: 'queued',
  created_at: Date.now(),
  updated_at: Date.now(),
  retouch: null,

  ...(note ? { note } : {}), // ✅ هنا بالضبط
};


    let retouchBooking = null;

// ===== 2) لو الموعد ليزر: نحاول نختار موعد رتوش =====
if (isLaserSlot(slot)) {
  try {
    let found = null;

    // 2.1 جرّب أولاً السلوْت اللي جا من التطبيق (اختيارك أنت)
    if (retouch) {
      found = await findRetouchSlotFromRequest(clinicId, retouch, slot);

    }

    // 2.2 لو ما وجدنا/ما جا شيء من التطبيق → نرجع للمنطق القديم (أول موعد متاح بعد X يوم)
    if (!found) {
      found = await findFirstLaserRetouchSlot(clinicId, slot);
    }
    // ❌ امنع الرتوش من غير عيادة الليزر
if (found && found.slot) {
  const rSlot = found.slot;

  if (!String(rSlot.doctorId || '').includes('laser')) {
    console.warn(
      '[RETOUCH BLOCKED] non-laser retouch slot blocked:',
      rSlot.doctorId
    );
    found = null;
  }
}


    if (found && found.slot) {
      const rSlot = found.slot;
      const rDateIso = toIsoDate(rSlot.date);
      const rStartIso = buildStartISO(rSlot.date, rSlot.time);
      const rStartTs  = Date.parse(rStartIso);

      // باقي الكود حق retouchBooking كما هو 👇
      retouchBooking = {
        id: makeBookingId(rSlot),
        nid,
        clinicId,
        date: rDateIso,
        time: rSlot.time,
        start_iso: rStartIso,
        start_ts: rStartTs,
        doctorId: rSlot.doctorId,
        doctorName: rSlot.doctorName,
        serviceId: rSlot.serviceId,
        serviceName: (rSlot.serviceName || 'عيادة الليزر') + ' (رتوش)',
        price: 0,
        status: 'confirmed',
        ssRaw: rSlot.ssRaw || null,
        created_at: nowISO(),
        invoice: null,
        isRetouch: true,
        parent_booking_id: booking.id,
      };

      await saveBooking(nid, retouchBooking);
      await redis.set(
        keyBookingIndex(retouchBooking.id),
        String(nid),
        'EX',
        60 * 60 * 24 * 30
      );

      try {
        await markSlotBookedInCache(
          clinicId,
          rDateIso,
          rSlot.time,
          rSlot.doctorId || null
        );
      } catch (e) {
        console.error('[laser/retouch] markSlotBookedInCache error:', e.message || e);
      }

      jobPayload.retouch = {
  date: rDateIso,
  time: rSlot.time,
  ssRaw: rSlot.ssRaw || null,
  doctorId: rSlot.doctorId, // ⭐ مهم جدًا
};

    } else {
      console.warn(
        '[imdad/confirm] laser booking but no retouch slot found for',
        booking.id
      );
    }
  } catch (err) {
    console.error(
      '[imdad/confirm] retouch logic error:',
      err.message || err
    );
  }
}


    // ===== 3) دفع Job (بـ retouch أو بدون) للبوت =====
    console.log(
      '[imdad/confirm] enqueue job:',
      jobPayload.id,
      jobPayload.date,
      jobPayload.time,
      jobPayload.retouch ? 'with RETOUCH' : 'no retouch'
    );
    await enqueueJob(jobPayload);

    // نرجّع كلا الحجزين للعميل (لو فيه رتوش)
    return res.json({ ok: true, slot: slots[idx], booking, retouchBooking });


  } catch (e) {
    console.error('imdad/confirm error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});


/* ================== Payment (Intent) ================== */
app.post('/api/pay/start', requireAuth, async (req, res) => {
  try {
    const { slot_id, clinic_id, month } = req.body || {};
    if (!slot_id) return res.status(400).json({ error: 'slot_id_required' });

    const clinicId = String(clinic_id || IMDAD_DEFAULT_CLINIC_ID);
    const nid = req.user?.nid;

    let ym = normalizeYm(month); // لو جوالك أرسل شهر نستخدمه
    let slot = null;

    // 1) جرّب أولاً بالشهر المرسل (لو موجود)
    if (ym) {
      const slots = await ensureSlots(clinicId, ym);
      slot = slots.find((s) => String(s.id) === String(slot_id));
    }

    // 2) لو ما لقينا، نبحث في كل الأشهر الموجودة في Redis
    if (!slot) {
      const found = await findSlotInAnyMonth(clinicId, slot_id);
      if (found) {
        slot = found.slot;
        ym = found.ym;
      }
    }

    if (!slot) {
      console.warn('⚠️ pay/start: slot_not_found', { slot_id, clinicId, ym });
      return res.status(404).json({ error: 'slot_not_found' });
    }

    // لو محجوز أصلاً → اعتبر العملية ناجحة
if (!slot.available) {
  await redis.del(lockKey(slot_id));
  return res.json({ ok: true, already: true, slot });
}


    if (!ym) ym = ymNow(); // احتياط

    // 🔒 نفس منطق القفل السابق
    const k = lockKey(slot_id);
    const existing = await redis.get(k);
    if (existing) {
      const lk = JSON.parse(existing);
      if (lk.owner !== nid) return res.status(409).json({ error: 'already_locked' });
      await redis.expire(k, LOCK_TTL);
    } else {
      const ok = await redis.set(
        k,
        JSON.stringify({ owner: nid, at: nowISO() }),
        'EX',
        LOCK_TTL,
        'NX'
      );
      if (ok !== 'OK') return res.status(409).json({ error: 'already_locked' });
    }

    const intentId = 'pi_' + crypto.randomBytes(8).toString('hex');
    const intent = {
      id: intentId,
      nid,
      slot_id,
      clinicId,
      ym,               // ✅ الآن مخزّن بالشهر الصحيح
      amount: DEPOSIT,
      currency: 'SAR',
      created_at: nowISO(),
      status: 'pending',
    };
    await redis.set(payIntentKey(intentId), JSON.stringify(intent), 'EX', PAY_TTL);

    return res.json({
      ok: true,
      intent_id: intentId,
      amount: DEPOSIT,
      pay_url: `/mockpay/${intentId}`,
    });
  } catch (e) {
    console.error('pay/start error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});


/* ---- إنشاء حجز مبدئي (pending_exec) ليظهر في "مواعيدي" فور الدفع ---- */
// ---- إنشاء حجز مبدئي من الـ intent مع fallback على كل الأشهر ----
// البحث عن الموعد في الشهر الموجود بالـ intent، ولو ما وُجد نبحث في كل الأشهر
async function createPendingBookingFromIntent(intent) {
  const { nid, clinicId, slot_id } = intent;

  let ym = intent.ym;
  let slot = null;

  // 1) جرّب أولاً بالشهر المخزَّن داخل الـ intent
  if (ym != null) {
    try {
      const slots = await ensureSlots(clinicId, ym);
      slot = slots.find((s) => String(s.id) === String(slot_id));
    } catch (e) {
      console.error('createPendingBookingFromIntent ensureSlots error:', e);
    }
  }

  // 2) لو ما لقيناه، نبحث في جميع مفاتيح imdad:slots:<clinicId>:*
  if (slot == null) {
    const found = await findSlotInAnyMonth(clinicId, slot_id);
    if (found != null) {
      slot = found.slot;
      ym = found.ym;
      intent.ym = ym; // تحديث الشهر داخل الـ intent احتياطًا
    }
  }

  // 3) لو ما زال غير موجود → نرمي slot_not_found
  if (slot == null) {
    throw new Error('slot_not_found');
  }

  // 4) نبني الحجز نفسه كما كان
  const start_iso = buildStartISO(slot.date, slot.time);
  const start_ts = Date.parse(start_iso);

  const booking = {
    id: makeBookingId(slot),
    nid,
    clinicId,
    date: toIsoDate(slot.date),
    time: slot.time,
    start_iso,
    start_ts,
    doctorId: slot.doctorId,
    doctorName: slot.doctorName,
    serviceId: slot.serviceId,
    serviceName: slot.serviceName,
    price: DEPOSIT,
    status: 'confirmed',
    ssRaw: slot.ssRaw || null,
    created_at: nowISO(),
    invoice: {
      amount: DEPOSIT,
      currency: 'SAR',
      paid_at: nowISO(),
      provider: 'mock',
      reference: 'PM-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      note: 'المبلغ مدفوع كعربون ويُخصم من قيمة الخدمة.',
    },
  };

await saveBooking(nid, booking);

// 📊 تحديث الإحصائيات (هنا بالضبط)
await redis.incr('stats:bookings:total');

const dayKey = 'stats:bookings:day:' + booking.date; // YYYY-MM-DD
await redis.incr(dayKey);

const clinicName =
  booking.serviceName || booking.doctorName || booking.clinicId;

const clinicKey =
  'stats:bookings:clinic:' + clinicName;

await redis.incr(clinicKey);



// ⬇️ هذا السطر موجود عندك أصلًا
await redis.set(
  keyBookingIndex(booking.id),
  String(nid),
  'EX',
  60 * 60 * 24 * 30
);


  return { booking, slot };
}


/* ---- تأكيد الدفع: لا نحجز فورًا؛ ندفع Job للعامل ---- */
app.post('/api/pay/confirm', requireAuth, async (req, res) => {
  try {
    const { intent_id, success } = req.body || {};
    if (!intent_id) return res.status(400).json({ error: 'intent_id_required' });

    const raw = await redis.get(payIntentKey(intent_id));
    if (!raw) return res.status(404).json({ error: 'intent_not_found_or_expired' });

    const intent = JSON.parse(raw);
    if (intent.nid !== req.user?.nid) return res.status(403).json({ error: 'forbidden' });

    // فشل الدفع
    if (success === false) {
      await redis.del(payIntentKey(intent_id));
      await redis.del(lockKey(intent.slot_id));
      return res.json({ ok: true, canceled: true });
    }

    // أنشئ حجز مبدئي بحالة pending_exec ليظهر في "مواعيدي"
    let booking, slot;
    try {
      const resX = await createPendingBookingFromIntent(intent);
      booking = resX.booking;
      slot = resX.slot;
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg === 'slot_not_found') {
        return res.status(409).json({ error: 'slot_not_found' });
      }
      console.error('❌ createPendingBookingFromIntent error:', msg);
      return res.status(500).json({ error: 'server_error', details: msg });
    }

    // جهّز Job للطابور
  const jobPayload = {
  id: nanoid(16),
  job_key: hashJobKey({
    nid: booking.nid,
    clinicId: booking.clinicId,
    date: booking.date,
    time: booking.time,
    doctorId: booking.doctorId || 'unknown',
  }),
  booking_id: booking.id,
  nid: booking.nid,
  phone: (await getProfile(booking.nid))?.phone_e164 || null,
  fullName: (await getProfile(booking.nid))?.fullName || 'مراجع',
  clinicId: booking.clinicId,
  doctorId: booking.doctorId,          // 👈 أهم سطر
  serviceId: booking.serviceId || null,
  date: booking.date,
  time: booking.time,
  ssRaw: slot?.ssRaw || booking.ssRaw || null,
  attempts: 0,
  status: 'queued',
  created_at: Date.now(),
  updated_at: Date.now(),
};


    await enqueueJob(jobPayload);

    // فك القفل الآن؟ نتركه للعامل ليمسك القفل القصير، لكن بما أنّ LOCK_TTL قصير، لا مشكلة
    // سنمدد القفل قليلًا لضمان عدم سرقة الفتحة قبل العامل (اختياري)
    await redis.expire(lockKey(intent.slot_id), Math.max(LOCK_TTL, 20));

    await redis.del(payIntentKey(intent_id));
    // ... بعد إنشاء booking


    return res.json({ ok: true, booking, intent_id });
  } catch (e) {
    console.error('pay/confirm error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ================== Endpoint يستدعيه العامل بعد النجاح ================== */
// يساعدنا نجيب YYYY-MM من تاريخ ISO مثل 2025-11-16
function ymFromIsoDate(isoDate) {
  if (!isoDate) return null;
  return String(isoDate).slice(0, 7); // "YYYY-MM"
}

// تحديث الكاش: تعليم الموعد على أنه محجوز
async function markSlotBookedInCache(clinicId, dateIso, timeStr, doctorId) {
  if (!clinicId || !dateIso || !timeStr) return;

  const ym = ymFromIsoDate(dateIso);
  if (!ym) return;

  const key = slotsKey(clinicId, ym);
  const raw = await redis.get(key);
  if (!raw) return;

  let slots;
  try {
    slots = JSON.parse(raw);
  } catch {
    return;
  }

  let changed = false;

  const norm = (s) => String(s || '').trim();

  const updated = slots.map((s) => {
    if (
      norm(s.date) === norm(dateIso) &&
      norm(s.time) === norm(timeStr) &&
      (!doctorId || norm(s.doctorId) === norm(doctorId))
    ) {
      changed = true;
      return { ...s, available: false };
    }
    return s;
  });

  if (changed) {
    await saveSlots(clinicId, ym, updated);
    console.log('[slots] marked as booked in cache:', {
      clinicId,
      ym,
      date: dateIso,
      time: timeStr,
      doctorId,
    });
  }
}

app.post('/api/internal/jobs/mark-confirmed', async (req, res) => {
  try {
    const secret = req.header('X-QUEUE-SECRET');
    if (!secret || secret !== process.env.QUEUE_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const { booking_id, imdad_booking_id, screenshot_url } = req.body || {};
    if (!booking_id) return res.status(400).json({ error: 'booking_id_required' });

    // احصل على nid من الفهرس العكسي
    const nid = await redis.get(keyBookingIndex(booking_id));
    if (!nid) return res.status(404).json({ error: 'booking_nid_not_found' });

    // ✅ أولاً: عدّل حالة الحجز إلى confirmed
    const ok = await updateBookingStatus(nid, booking_id, {
      
      status: 'confirmed',
      imdad_id: imdad_booking_id || null,
      imdad_screenshot: screenshot_url || null,
      confirmed_at: nowISO(),
    });
    


    // ✅ ثانياً: حدّث الكاش (imdad:slots) عشان يختفي الموعد من المتاح
    try {
      const bookings = await getBookings(nid);
      const booking = bookings.find(
        (b) => String(b.id) === String(booking_id)
      );

      if (booking && booking.clinicId && booking.date && booking.time) {
        await markSlotBookedInCache(
          booking.clinicId,
          booking.date,      // صيغة YYYY-MM-DD
          booking.time,      // نفس time اللي طلعت من Imdad
          booking.doctorId || null
        );
      }
    } catch (e) {
      console.error('[INTERNAL] markSlotBookedInCache error:', e.message);
    }

    console.log('[INTERNAL] booking confirmed:', {
      booking_id,
      imdad_booking_id,
      screenshot_url,
      ok,
    });
    return res.json({ ok: !!ok });
  } catch (e) {
    console.error('internal mark-confirmed error:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});
/* ===== Endpoint داخلي: بعد إنشاء الملف في إمداد أو اكتشاف أنه موجود ===== */
app.post('/api/internal/imdad/new-file/done', async (req, res) => {
  try {
    const secret = req.header('X-QUEUE-SECRET');
    if (!secret || secret !== QUEUE_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const { nid, file_id, existed } = req.body || {};
    if (!nid) return res.status(400).json({ error: 'nid_required' });

    const hash = nidHash(nid);
    const idxKey = keyIndex(hash);

    // حدّث index (exists + file_id + الجوال المقنّع)
    let idx = null;
    const idxRaw = await redis.get(idxKey);
    if (idxRaw) {
      try { idx = JSON.parse(idxRaw); } catch { idx = null; }
    }
    if (!idx) idx = { exists: true };

    idx.exists = true;
    if (file_id) idx.file_id = String(file_id);

    const profile = await getProfile(nid);
    if (profile?.phone_e164) {
      idx.phone_e164 = profile.phone_e164;
      idx.masked_phone = maskPhone(profile.phone_e164);
    }

    idx.last_checked_at = nowISO();
    await redis.set(idxKey, JSON.stringify(idx), 'EX', INDEX_TTL);

    // حدّث الـ profile وخزّن رقم الملف
    if (profile) {
      await setProfile(nid, {
        ...profile,
        file_id: file_id || profile.file_id || null,
        updated_at: nowISO(),
      });
    }

    console.log('[NEWFILE] done for nid=', nid, {
      file_id: file_id || null,
      existed: !!existed,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('internal imdad/new-file/done error:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});
/* ================== Content: Home Banners ================== */

/* ================== Content: Home Banners ================== */
app.get('/api/content/home-banners', async (req, res) => {
  try {
    // نقرأ الملف الرئيسي للبنرات
    const raw = await fs.promises.readFile(HOME_BANNERS_PATH, 'utf8').catch(() => '{"banners": []}');
    let json;
    try {
      json = JSON.parse(raw);
    } catch (_) {
      json = { banners: [] };
    }

    // نتأكد أن الناتج النهائي List
    const list = Array.isArray(json.banners)
      ? json.banners
      : (Array.isArray(json) ? json : []);

    return res.json({ banners: list });
  } catch (e) {
    console.error('home-banners read error:', e.message || e);
    return res.json({ banners: [] });
  }
});

// حفظ البنرات (لوحة الموظف)
app.post('/api/admin/home-banners', (req, res) => {
  try {
    const { banners } = req.body || {};
    if (!Array.isArray(banners)) {
      return res.status(400).json({ ok: false, error: 'banners_must_be_array' });
    }

    const filePath = path.join(process.cwd(), 'server', 'data', 'home_banners.json');

    const payload = {
      banners: banners.map((b, i) => ({
        id: b.id || `b${i + 1}`,
        title: b.title || '',
        imageUrl: b.imageUrl || '',
        enabled: b.enabled !== false,
        order: Number.isFinite(b.order) ? b.order : i + 1,
      })),
    };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');

    return res.json({ ok: true, banners: payload.banners });
  } catch (err) {
    console.error('Error writing home_banners.json:', err.message || err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});
/* ================== Content: App Campaigns (رسائل التطبيق) ================== */

// جلب الحملات (لوحة الموظف)
app.get('/api/admin/campaigns', async (req, res) => {
  try {
    const raw = await fs.promises
      .readFile(CAMPAIGNS_PATH, 'utf8')
      .catch(() => '{"campaigns": []}');

    let json;
    try {
      json = JSON.parse(raw);
    } catch (_) {
      json = { campaigns: [] };
    }

    const list = Array.isArray(json.campaigns)
      ? json.campaigns
      : (Array.isArray(json) ? json : []);

    return res.json({ campaigns: list });
  } catch (e) {
    console.error('campaigns read error:', e.message || e);
    return res.json({ campaigns: [] });
  }
});

// حفظ الحملات (لوحة الموظف)
app.post('/api/admin/campaigns', async (req, res) => {
  try {
    const { campaigns } = req.body || {};
    if (!Array.isArray(campaigns)) {
      return res
        .status(400)
        .json({ ok: false, error: 'campaigns_must_be_array' });
    }

    const payload = {
      campaigns: campaigns.map((c, i) => ({
        id: c.id || `c${i + 1}`,
        title: c.title || '',
        message: c.message || '',
        kind: c.kind || 'offer', // offer / greeting / alert
        startDate: c.startDate || '',
        endDate: c.endDate || '',
        enabled: c.enabled !== false,
      })),
    };

    await fs.promises.writeFile(
      CAMPAIGNS_PATH,
      JSON.stringify(payload, null, 2),
      'utf8'
    );

    return res.json({ ok: true, campaigns: payload.campaigns });
  } catch (e) {
    console.error('campaigns write error:', e.message || e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 🔹 واجهة عامة للموبايل: ترجع فقط الحملات النشطة والمفعّلة
app.get('/api/campaigns/active', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const raw = await fs.promises
      .readFile(CAMPAIGNS_PATH, 'utf8')
      .catch(() => '{"campaigns": []}');
    let json;
    try {
      json = JSON.parse(raw);
    } catch (_) {
      json = { campaigns: [] };
    }

    const list = Array.isArray(json.campaigns)
      ? json.campaigns
      : (Array.isArray(json) ? json : []);

    const active = list.filter((c) => {
      if (c.enabled === false) return false;

      const start = (c.startDate || '').trim();
      const end = (c.endDate || '').trim();

      // لو مافيه تواريخ → نعتبرها دايمًا نشطة وهي مفعّلة
      if (!start && !end) return true;

      // مقارنة بسيطة نصّية على YYYY-MM-DD
      if (start && today < start) return false;
      if (end && today > end) return false;

      return true;
    });

    return res.json({ campaigns: active });
  } catch (e) {
    console.error('active campaigns error:', e.message || e);
    return res.json({ campaigns: [] });
  }
});


// إعداد التخزين للصور
const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const baseRaw = path.basename(file.originalname || 'img', ext);
    const base = baseRaw.replace(/[^a-zA-Z0-9_-]/g, '') || 'img';
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${base}-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('ONLY_IMAGES_ALLOWED'));
    }
    cb(null, true);
  },
});

/* ================== Health ================== */
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/api/my/bookings', requireAuth, async (req, res) => {
  const nid = req.user?.nid;
  if (!nid) return res.status(401).json({ error: 'unauthorized' });

  const k = keyBookings(nidHash(nid));
  const raw = await redis.get(k);
  if (!raw) return res.json({ bookings: [] });

  return res.json({ bookings: JSON.parse(raw) });
});
/* ================== Cancel Booking (جاري الإلغاء → إلغاء فعلي عبر البوت) ================== */

app.post('/api/my/bookings/:id/cancel', requireAuth, async (req, res) => {
  try {
    const bookingId = req.params.id;
    const nid = req.user?.nid;

    if (!bookingId) return res.status(400).json({ error: 'booking_id_required' });
    if (!nid) return res.status(401).json({ error: 'unauthorized' });

    // 1) نجيب جميع المواعيد
    const bookings = await getBookings(nid);
    const booking = bookings.find(b => String(b.id) === String(bookingId));

    if (!booking) return res.status(404).json({ error: 'booking_not_found' });

    // 2) تحقق من شرط الساعتين
    if (!canCancel(booking.start_iso)) {
      return res.status(400).json({
        error: 'too_late_to_cancel',
        message: 'لا يمكن إلغاء الموعد قبل أقل من ساعتين من وقت الحجز.'
      });
    }

    // 3) حدّث الحجز إلى "جاري الإلغاء"
      await updateBookingStatus(nid, bookingId, { status: 'cancelled' });


    // 4) أرسل Job للبوت في طابور الإلغاء
    const job = {
      id: 'cn_' + crypto.randomBytes(8).toString('hex'),
      bookingId,
      nid,
      nationalId: nid,
      date: booking.date,   // YYYY-MM-DD
      time: booking.time,   // HH:MM
      clinic: booking.clinicId || null,
      doctor: booking.doctorName || null,
      attempts: 0,
      created_at: Date.now()
    };

    // دفع الجوب للطابور
    await redis.rpush(CANCEL_QUEUE_KEY, JSON.stringify(job));

    return res.json({
      ok: true,
      status: 'جاري الإلغاء',
      message: 'تم إرسال طلب الإلغاء، وسيظهر لك "ملغى" بعد نجاح الإلغاء من إمداد.'
    });

  } catch (e) {
    console.error('cancel booking error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});
/* ================== Content: Upload Image ================== */
app.post('/api/content/upload-image', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'no_file' });
    }

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

    return res.json({
      ok: true,
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  } catch (e) {
    console.error('upload-image error:', e.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});
app.post('/api/user/save-fcm-token', async (req, res) => {
  try {
    const token = req.body?.token;
    if (!token) {
      return res.status(400).json({ ok: false, error: 'missing_token' });
    }

    
    const file = './fcm_tokens.json';

    let list = [];
    if (fs.existsSync(file)) {
      list = JSON.parse(fs.readFileSync(file));
    }

    if (!list.includes(token)) {
      list.push(token);
      fs.writeFileSync(file, JSON.stringify(list, null, 2));
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
// 🔔 عامل بسيط: يفحص التذكيرات المستحقة ويرسل FCM
async function processDueReminders() {
  try {
    const now = Date.now();

    // نجيب كل التذكيرات اللي وقتها <= الآن
    const items = await redis.zrangebyscore(REMINDERS_ZSET, 0, now);
    if (!items.length) return;

    for (const raw of items) {
      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        await redis.zrem(REMINDERS_ZSET, raw);
        continue;
      }

      const nid = data.nid;
      if (!nid) {
        await redis.zrem(REMINDERS_ZSET, raw);
        continue;
      }

      // نجيب FCM token من Redis
      const tokenKey = `user:fcm:${nid}`;
      const fcmToken = await redis.get(tokenKey);

      // نحذف من الـ ZSET أولاً عشان ما يتكرر
      await redis.zrem(REMINDERS_ZSET, raw);

      if (!fcmToken) {
        console.warn('[REMINDER] no FCM token for nid', nid);
        continue;
      }

      // نص التذكير
      const date = data.date || '';
      const time = data.time || '';
      const service = data.serviceName || 'موعد طبي';
      const doctor = data.doctorName ? `مع ${data.doctorName}` : '';

      const title = 'تذكير بموعدك بعد ساعة';
      const body = `موعدك اليوم ${date} الساعة ${time} لـ ${service} ${doctor}`.trim();

      try {
        await admin.messaging().send({
          token: fcmToken,
          notification: { title, body },
          data: {
            kind: 'booking_reminder',
            booking_id: String(data.booking_id || ''),
          },
        });

        console.log('[REMINDER] FCM sent to nid', nid, 'booking', data.booking_id);
      } catch (e) {
        console.error('[REMINDER] send FCM error:', e.message || e);
      }
    }
  } catch (e) {
    console.error('[REMINDER] processDueReminders error:', e);
  }
}

// نشغّل العامل كل دقيقة
setInterval(processDueReminders, 60 * 1000);


/* ================== Start ================== */
app.listen(PORT, () => console.log(`Phoenix server running on http://localhost:${PORT}`));
