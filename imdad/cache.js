// server/imdad/cache.js
import 'dotenv/config';
import Redis from 'ioredis';
import { fetchImdadSlots } from './bot.js';
import { isSlotAllowedByConfig } from './doctor_config.js';

/* ---------------- Env ---------------- */
const {
  REDIS_URL = 'redis://localhost:6379',
  IMDAD_REFRESH_SECONDS = '10',
  IMDAD_DEFAULT_CLINIC_ID = 'phoenix-main',
  IMDAD_DEFAULT_MONTH, // تقدر تخليه أو تشيله، ما عاد نستخدمه
  IMDAD_DOCTORS = 'd_ryan,d_abeer,d_moath,d_ronaldo,d_walaa,d_hasnaa',
} = process.env;

// CLI: --month=YYYY-MM
const ARG_MONTH = process.argv.find(a => a.startsWith('--month='))?.split('=')[1];

const NOW = new Date();
const NOW_YYYY_MM = NOW.toISOString().slice(0, 7);
const TODAY_ISO = NOW.toISOString().slice(0, 10); // YYYY-MM-DD لليوم الحالي

// ✅ هنا التعديل المهم: نشيل IMDAD_DEFAULT_MONTH
const YEAR_MONTH = (ARG_MONTH || NOW_YYYY_MM).trim();

const CLINIC_ID = (IMDAD_DEFAULT_CLINIC_ID || 'phoenix-main').trim();
const REFRESH_EVERY = Math.max(5, parseInt(IMDAD_REFRESH_SECONDS, 10));

/* ---------------- Redis ---------------- */
const isTLS = REDIS_URL?.startsWith('rediss://');
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3, tls: isTLS ? {} : undefined });
const pub   = new Redis(REDIS_URL, { tls: isTLS ? {} : undefined });

/* ---------------- Keys ---------------- */
const slotsKey    = (clinicId, ym) => `imdad:slots:${clinicId}:${ym}`;
const updatesChan = (clinicId, ym) => `imdad:updates:${clinicId}:${ym}`;

/* ---------------- Helpers ---------------- */
// تحويل الأرقام العربية/الفارسية إلى إنجليزية
function normalizeDigits(s) {
  if (s == null) return s;
  const map = {
    '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
    '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'
  };
  return String(s).replace(/[٠-٩۰-۹]/g, d => map[d] || d);
}

// يقبل: YYYY-MM-DD / YYYY/MM/DD / DD-MM-YYYY / DD/MM/YYYY → يرجع YYYY-MM
function yyyyMmFromDateString(raw) {
  const s = normalizeDigits(String(raw || '').trim());
  if (!s) return null;

  // YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-]\d{1,2}/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;

  // DD-MM-YYYY or DD/MM/YYYY
  m = s.match(/^\d{1,2}[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}`;

  // ISO-like fallback
  if (/^\d{4}[\/\-]\d{2}/.test(s)) return s.slice(0, 7);

  return null;
}

// نفس اللي فوق لكن يرجّع YYYY-MM-DD للمقارنة مع TODAY_ISO
function ymdFromDateString(raw) {
  const s = normalizeDigits(String(raw || '').trim());
  if (!s) return null;

  // YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) {
    const Y = m[1];
    const M = String(m[2]).padStart(2, '0');
    const D = String(m[3]).padStart(2, '0');
    return `${Y}-${M}-${D}`;
  }

  // DD-MM-YYYY or DD/MM/YYYY
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    const D = String(m[1]).padStart(2, '0');
    const M = String(m[2]).padStart(2, '0');
    const Y = m[3];
    return `${Y}-${M}-${D}`;
  }

  // ISO جاهز
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 10);

  return null;
}

function sameMonth(raw, targetYm) {
  const ym = yyyyMmFromDateString(raw);
  return ym === targetYm;
}

function uniqSlots(arr) {
  const seen = new Set();
  const out = [];
  for (const it of (arr || [])) {
    const key =
      (it.id != null && String(it.id)) ||
      [it.doctorId ?? '', it.date ?? '', it.time ?? ''].join('|');
    if (!seen.has(key)) { seen.add(key); out.push(it); }
  }
  return out;
}

async function saveSlots(clinicId, ym, slots) {
  await redis.set(slotsKey(clinicId, ym), JSON.stringify(slots));
  await pub.publish(
    updatesChan(clinicId, ym),
    JSON.stringify({ type: 'slots:update', at: new Date().toISOString(), count: slots.length })
  );
}
async function loadSlots(clinicId, ym) {
  const raw = await redis.get(slotsKey(clinicId, ym));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}
function minutesFromTimeLabel(label) {
  const s0 = normalizeDigits(String(label || '').trim());
  if (!s0) return null;

  const isAM = s0.includes('ص');
  const isPM = s0.includes('م');

  const m = s0.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;

  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;

  if (isAM) {
    if (hh === 12) hh = 0;      // 12ص = 00:00
  } else if (isPM) {
    if (hh < 12) hh += 12;      // 1م–11م ➜ 13–23
  }

  return hh * 60 + mm;
}

/* ---------------- Main ---------------- */
async function refreshOnce() {
  const doctors = IMDAD_DOCTORS.split(',').map(s => s.trim()).filter(Boolean);
  if (doctors.length === 0) {
    console.warn('[Imdad] IMDAD_DOCTORS فارغة — لن يتم الجلب');
    return;
  }

  // 🟢 شهر حالي + شهر قادم
const now = new Date();
const ym1 = now.toISOString().slice(0, 7);               // الحالي
const ym2 = new Date(now.getFullYear(), now.getMonth()+1, 1).toISOString().slice(0,7); // +1
const ym3 = new Date(now.getFullYear(), now.getMonth()+2, 1).toISOString().slice(0,7); // +2

const months = [ym1, ym2, ym3]; // ← 3 months


  const makeKey = (it) =>
    (it.id != null && String(it.id)) ||
    [it.doctorId ?? '', it.date ?? '', it.time ?? ''].join('|');

  for (const YM of months) {
    const key = slotsKey(CLINIC_ID, YM);

    console.log(
      `[Imdad] refreshing… clinic=${CLINIC_ID} month=${YM} key=${key}`
    );

    // 1) نقرأ المواعيد القديمة من Redis لنحافظ على المحجوزة منها
    let prevByKey = new Map();
    try {
      const prevRaw = await redis.get(key);
      if (prevRaw) {
        const prevList = JSON.parse(prevRaw);
        for (const it of prevList || []) {
          prevByKey.set(makeKey(it), it);
        }
      }
    } catch (e) {
      console.warn('[Imdad] prev slots parse error:', e.message);
    }

    // 2) نجلب من إمداد لكل دكتور (لنفس الشهر)
    const all = [];

    for (const doctorId of doctors) {
  try {
    const optRaw = process.env[`IMDAD_CLINIC_OPTION__${doctorId}`];
    if (!optRaw) {
      console.warn(
        `[Imdad] لا يوجد IMDAD_CLINIC_OPTION__${doctorId} في .env`
      );
      continue;
    }

    const options = optRaw.split('|').map(s => s.trim()).filter(Boolean);

    for (const clinicOption of options) {
      const slots =
        (await fetchImdadSlots({
          clinicId: CLINIC_ID,
          yearMonth: YM,
          doctorId,
          clinicOption,
        })) || [];

      // 🔻 هنا الفلترة حسب إعدادات لوحة الموظف
      const filtered = slots.filter((s) => {
        const iso = ymdFromDateString(s.date);
        if (!iso) return true; // لو التاريخ مو واضح لا نمنعه

       const minutes = minutesFromTimeLabel(s.time);
if (minutes == null) return true;


        // ✔️ يشوف هل هذا الوقت مسموح لهذا الدكتور (d_laser_am, d_laser_pm, d_ryan...)
        return isSlotAllowedByConfig(doctorId, iso, minutes);
      });

      all.push(...filtered);
    }
  } catch (err) {
    console.error(
      `[Imdad] fetch error for doctorId=${doctorId}:`,
      err?.message || err
    );
  }
}


    // 3) دمج بدون تكرار
    const merged = uniqSlots(all).sort((a, b) => {
      if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
      return String(a.time).localeCompare(String(b.time), 'ar');
    });

    // 4) 🛡️ نحافظ على أي موعد كان محجوز سابقاً (available:false)
    const mergedPreserved = merged.map((s) => {
      const k = makeKey(s);
      const prev = prevByKey.get(k);
      if (prev && prev.available === false) {
        return {
          ...s,
          available: false,
          bookedBy: prev.bookedBy || null,
          bookedAt: prev.bookedAt || null,
        };
      }
      return s;
    });

    await saveSlots(CLINIC_ID, YM, mergedPreserved);
    console.log(
      `[Imdad] refreshed ${mergedPreserved.length} slots → ${key}`
    );
  }
}






/* ---------------- Loop ---------------- */
async function loop() {
  console.log('[Imdad] Redis connected');
  console.log(`[Imdad] cache loop start | every ${REFRESH_EVERY}s`);
  while (true) {
    try { await refreshOnce(); }
    catch (e) { console.error('[Imdad] cache loop error:', e?.message || e); }
    await new Promise(r => setTimeout(r, REFRESH_EVERY * 1000));
  }
}

/* ---------------- Bootstrap ---------------- */
(async () => {
  try {
    await redis.connect();
    loop();
  } catch (e) {
    console.error('❌ Redis connect error:', e?.message || e);
    process.exit(1);
  }
})();
