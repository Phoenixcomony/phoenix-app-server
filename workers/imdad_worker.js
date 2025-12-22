// server/workers/imdad_worker.js
import 'dotenv/config';
import axios from 'axios';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { dequeueJob, ackJob, requeueJob } from '../queue.js';

/* =====================[ Selectors + Env ]===================== */

const USER_SEL   = process.env.IMDAD_USER_SELECTOR   || '#username, input[name="username"]';
const PASS_SEL   = process.env.IMDAD_PASS_SELECTOR   || '#password, input[name="password"]';
const SUBMIT_SEL = process.env.IMDAD_SUBMIT_SELECTOR || 'button[type=submit], input[type=submit], #submit, .btn-login, .btn.btn-primary';
const POST_SEL   = process.env.IMDAD_POST_LOGIN_SELECTOR || '#mainNav,.navbar,.top-menu,#wrapper,#content,body.logged-in';

const BASE_URL     = process.env.BASE_URL || 'http://localhost:3000';
const QUEUE_SECRET = process.env.QUEUE_SECRET || '';
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.QUEUE_MAX_ATTEMPTS || '5', 10));

const must = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing .env key: ${k}`);
  return v;
};

// 👈 حساب خاص لهذا العامل (مع fallback للحساب العادي لو ما تم تحميل القيم)
const IMDAD_WORKER_USERNAME =
  process.env.IMDAD_WORKER_USERNAME || process.env.IMDAD_USERNAME || '';
const IMDAD_WORKER_PASSWORD =
  process.env.IMDAD_WORKER_PASSWORD || process.env.IMDAD_PASSWORD || '';

if (!IMDAD_WORKER_USERNAME || !IMDAD_WORKER_PASSWORD) {
  console.warn(
    '⚠️ IMDAD_WORKER_USERNAME/PASSWORD غير مضبوطة، وقد يفشل تسجيل الدخول في إمداد.'
  );
}

const joinUrl = (base, p) =>
  base.replace(/\/+$/, '') + '/' + String(p || '').replace(/^\/+/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLOW_MS = 1200; // 1.2 ثانية
async function slow(tag) {
  console.log('[slow]', tag, 'for', SLOW_MS, 'ms');
  await sleep(SLOW_MS);
}

/* =====================[ Time helpers ]===================== */

// يحول "2025-11-20" إلى "20-11-2025"
const toDmy = (iso) => {
  if (!iso) return null;
  const parts = String(iso).split('-');
  if (parts.length !== 3) return null;
  const [Y, M, D] = parts;
  return `${D}-${M}-${Y}`;
};

// يحول "3:00م" أو "03:00 PM" أو "15:00" إلى "HH:MM"
function normalizeTime(t) {
  let s = String(t || '').trim();
  if (!s) return '';

  // توحيد العربية/الإنجليزية
  s = s.replace('ص', 'AM').replace('م', 'PM').replace(/\s+/g, '');
  const m = s.match(/^(\d{1,2}):(\d{2})(AM|PM)?$/i);
  if (!m) {
    // لو أصلاً جاي "15:00" بدون AM/PM نرجعه كما هو (أول 5 خانات)
    return s.slice(0, 5);
  }

  let hh = parseInt(m[1], 10);
  const mm = m[2];
  const ap = (m[3] || '').toUpperCase();

  if (ap === 'AM' && hh === 12) hh = 0;
  if (ap === 'PM' && hh !== 12) hh += 12;

  return `${String(hh).padStart(2, '0')}:${mm}`;
}

// يحول job.date إلى "DD-MM-YYYY"
function buildDmyFromJob(job) {
  if (job.date_dmy) return String(job.date_dmy);
  if (job.date) {
    const parts = String(job.date).split('-');
    if (parts.length === 3) {
      const [y, m, d] = parts;
      return `${d}-${m}-${y}`;
    }
  }
  return null;
}

// يحول HH:MM إلى تنسيق إمداد "H:0" أو "H:30"
function buildLegacyTimeFromJob(job) {
  const raw = normalizeTime(job.time || job.hhmm);
  if (!raw) return null;
  const [hStr, mStr] = raw.split(':');
  const hNum = parseInt(hStr || '0', 10);
  const mNum = parseInt(mStr || '0', 10);

  const hLegacy = String(hNum); // بدون صفر في اليسار
  const mLegacy = mNum === 0 ? '0' : String(mNum); // "0" أو "30"

  return `${hLegacy}:${mLegacy}`; // مثال: "10:0" أو "18:30"
}

// يبني pattern النهائي "DD-MM-YYYY*H:m"
function buildSlotPattern(job) {
  const dmy = buildDmyFromJob(job);
  const legacyTime = buildLegacyTimeFromJob(job);
  if (!dmy || !legacyTime) return null;
  return `${dmy}*${legacyTime}`;
}

/* =====================[ اختيار العيادة (صباح/مساء) ]===================== */

// يحدد مفتاح الـ ENV الصحيح حسب الدكتور + الوقت
function resolveClinicEnvKey(job) {
  const docId = job.doctorId || job.clinicId || '';
  if (!docId) return null;

  // نحاول تمييز صباح/مساء من الوقت
  const hhmm = normalizeTime(job.time || job.hhmm);
  let suffix = '';

  if (['d_ryan', 'd_abeer', 'd_hasnaa', 'd_general'].includes(docId)) {
    if (hhmm) {
      const hour = parseInt(hhmm.split(':')[0] || '0', 10);
      const isMorning = hour < 15; // أقل من 3 العصر = صباحي
      suffix = isMorning ? '_am' : '_pm';
    }
  }

  // 1) نحاول بالمفتاح مع am/pm
  if (suffix) {
    const keyWithSuffix = `IMDAD_CLINIC_OPTION__${docId}${suffix}`;
    if (process.env[keyWithSuffix]) return keyWithSuffix;
  }

  // 2) لو ما لقيناه، نجرب المفتاح العادي بدون suffix
  const plainKey = `IMDAD_CLINIC_OPTION__${docId}`;
  if (process.env[plainKey]) return plainKey;

  // 3) آخر شيء نرجّع null
  return null;
}

/* =====================[ Browser ]===================== */

async function getPage() {
  const exe = process.env.CHROME_PATH?.trim() || undefined;
  const browser = await puppeteer.launch({
    headless: "new", 
    executablePath: exe,
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  page._phoenixBrowser = browser;
  return page;
}

/* =====================[ Helpers ]===================== */

async function gotoWithRetry(p, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      return;
    } catch (err) {
      console.warn(`[gotoWithRetry] attempt ${i + 1} → ${err.message}`);
      await sleep(1500);
    }
  }
  throw new Error(`goto_failed_after_${retries}_attempts: ${url}`);
}

async function snap(p, job, tag) {
  try {
    const root = path.resolve(
      process.cwd(),
      'screens',
      String(job.booking_id || job.id || 'job')
    );
    fs.mkdirSync(root, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(root, `${ts}__${tag}.png`);
    await p.screenshot({ path: file, fullPage: true });
    console.log(`[snap] ${tag} → ${file}`);
    return file;
  } catch {
    // تجاهل أي خطأ في السكرين شوت
  }
}

/* =====================[ Core: execute booking ]===================== */

export async function executeInImdad(job) {
  if (!job || !job.nid || !job.clinicId || !job.date || !job.time) {
    throw new Error('invalid_job_fields');
  }

  const dmy  = toDmy(job.date);
  const hhmm = normalizeTime(job.time);

  console.log('[worker] target slot:', {
    date: job.date,
    dmy,
    time: job.time,
    hhmm,
    doctorId: job.doctorId,
    clinicId: job.clinicId,
    serviceName: job.serviceName || null,
  });

  const p = await getPage();
  const base = must('IMDAD_BASE_URL');

  let result;

  try {
    /* ========== 0) تسجيل الدخول ========== */

    await gotoWithRetry(p, joinUrl(base, must('IMDAD_LOGIN_PATH')));
    await snap(p, job, '00_login_page');

    let loggedIn = false;
    try {
      if (await p.$(POST_SEL)) loggedIn = true;
    } catch (_) {}

    if (!loggedIn) {
      const userSel = (await p.$(USER_SEL)) ? USER_SEL : '#username';
      const passSel = (await p.$(PASS_SEL)) ? PASS_SEL : '#password';

      await p.focus(userSel);
      await p.$eval(userSel, (el) => (el.value = ''));
      await p.type(userSel, IMDAD_WORKER_USERNAME, { delay: 20 });

      await p.focus(passSel);
      await p.$eval(passSel, (el) => (el.value = ''));
      await p.type(passSel, IMDAD_WORKER_PASSWORD, { delay: 20 });

      await snap(p, job, '00_filled_credentials');

      const subSel = (await p.$(SUBMIT_SEL))
        ? SUBMIT_SEL
        : 'input[type=submit],button[type=submit]';

      await Promise.all([
        p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
        p.click(subSel),
      ]);
    }

    await snap(p, job, '00_logged_in');

    /* ========== 1) صفحة المواعيد الأساسية ========== */

    const apptsPath = must('IMDAD_APPTS_PATH');
    await gotoWithRetry(p, joinUrl(base, apptsPath));
    await snap(p, job, '05_on_appoint_display');

    /* ========== 2) اختيار العيادة/الفترة ========== */

    let selectedClinic = false;

    try {
      await p.waitForSelector('#clinic_id', { timeout: 10000 });

      const clinicEnvKey = resolveClinicEnvKey(job);
      const clinicKey = job.doctorId || job.clinicId || '';
      const envOpt = clinicEnvKey ? process.env[clinicEnvKey] : null;

      console.log('[worker] clinic selection:', {
        clinicKey,
        clinicEnvKey,
        envOpt: !!envOpt,
        clinicName: job.clinicName || null,
      });

      if (envOpt) {
        // أولوية 1: قيمة من ENV (رابط أو قيمة سلكت)
        await p.$eval(
          '#clinic_id',
          (el, val) => {
            el.value = val;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (val) window.location = val;
          },
          envOpt
        );

        try {
          await p.waitForNavigation({
            waitUntil: 'networkidle2',
            timeout: 60000,
          });
        } catch (_) {}

        selectedClinic = true;
      } else if (job.clinicName) {
        // أولوية 2: البحث بالاسم داخل النص
        selectedClinic = await p.$eval(
          '#clinic_id',
          (el, wanted) => {
            const opts = Array.from(el.options || []);
            const found = opts.find((o) =>
              (o.textContent || '').includes(wanted)
            );
            if (found) {
              el.value = found.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              if (found.value) window.location = found.value;
              return true;
            }
            return false;
          },
          job.clinicName
        );

        if (selectedClinic) {
          try {
            await p.waitForNavigation({
              waitUntil: 'networkidle2',
              timeout: 60000,
            });
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn('[clinic_select] failed:', e.message);
    }

    await snap(
      p,
      job,
      selectedClinic ? '06_after_select_clinic' : '06_clinic_dropdown_found'
    );

    console.log(
      '[worker] skip month dropdown on purpose (we rely on URL from clinic selection).'
    );
    /* ========== 2.5) اختيار "2 months" إن وُجد ========== */
try {
  const hasMonthSelect = await p.$('select[name="day_no"], #day_no');
  if (hasMonthSelect) {
    const twoMonthValue = await p.$eval(
      'select[name="day_no"], #day_no',
      (sel) => {
        const opts = Array.from(sel.options || []);
        const found = opts.find((o) => {
          const v = String(o.value || '');
          const txt = String(o.textContent || '').toLowerCase();
          return (
  v.includes('day_no=90') ||
  txt.includes('3 months')
);

        });
        return found ? found.value : null;
      }
    );

    if (twoMonthValue) {
      console.log('[worker] selecting 2 months option:', twoMonthValue);
      await Promise.all([
        p.waitForNavigation({
          waitUntil: 'networkidle2',
          timeout: 60000,
        }),
        p.evaluate((val) => {
          window.location.href = val;
        }, twoMonthValue),
      ]);
    } else {
      console.log('[worker] no explicit 2 months option found');
    }
  } else {
    console.log('[worker] no day_no/month selector on page');
  }
} catch (err) {
  console.warn('[worker] 2-month dropdown step failed:', err.message);
}


    /* ========== 3) كتابة الهوية واختيار أول مريض ========== */

    try {
      const nidStr = String(job.nid || '').trim();
      console.log('[nid_debug] nidStr =', nidStr);

      await p.waitForSelector('#SearchBox120', { timeout: 15000 });

      await p.evaluate((nid) => {
        const el = document.querySelector('#SearchBox120');
        if (!el) return;

        el.value = '';
        el.value = nid;

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: '0', bubbles: true }));
      }, nidStr);

      const typedVal = await p.$eval('#SearchBox120', (el) => el.value);
      console.log('[nid_debug] value after type =', typedVal);

      await snap(p, job, '08_after_type_nid');

      const hadSuggestions = await p
        .waitForFunction(
          () =>
            document.querySelectorAll('li[onclick^="fillSearch120("]').length > 0,
          { timeout: 15000 }
        )
        .then(() => true)
        .catch(() => false);

      if (!hadSuggestions) {
        await snap(p, job, '08_no_patient_suggestions');
        console.error(`[worker] no patient suggestions for NID: ${nidStr}`);
        throw new Error('no_patient_suggestions_for_nid');
      }

      await p.click('li[onclick^="fillSearch120("]');
      await snap(p, job, '08_after_pick_patient');
      /* ========== 3.5) كتابة الملحوظة (اختياري) ========== */
try {
  const note = String(job.note || '').trim();
  if (note) {
    await p.waitForSelector('input[name="notes"]', { timeout: 5000 });

    await p.focus('input[name="notes"]');
    await p.$eval('input[name="notes"]', (el) => (el.value = ''));
    await p.type('input[name="notes"]', note, { delay: 15 });

    console.log('[worker] ✅ note typed:', note);
    await snap(p, job, '08b_after_type_note');
  } else {
    console.log('[worker] note empty → skip');
  }
} catch (e) {
  console.warn('[worker] note step skipped:', e.message);
}

    } catch (e) {
      if (e.message === 'no_patient_suggestions_for_nid') throw e;
      console.error('[nid_search] error:', e.message);
      throw e;
    }

    /* ========== 4) اختيار خانة الموعد الصحيحة ========== */

await p.waitForSelector('input[name="ss"]', { timeout: 15000 });

const allValues = await p.$$eval('input[name="ss"]', (els) =>
  els.map((el) => el.value || '')
);
console.log('[slot_debug] all ss values:', allValues);

// 🆕 أولاً: لو عندنا ssRaw، نحاول نطابقه حرفياً
let matchedValue = null;

if (job.ssRaw) {
  const desired = String(job.ssRaw);
  matchedValue = await p.$$eval(
    'input[name="ss"]',
    (els, wanted) => {
      const el = els.find((e) => String(e.value || '') === wanted);
      if (!el) return null;
      const label = el.closest('label');
      if (label) {
        label.click();
      } else {
        el.click();
      }
      return el.value;
    },
    desired
  );
  console.log('[slot_debug] try ssRaw:', desired, '→', matchedValue);
}

// لو ssRaw ما نفع أو مهو موجود، نرجع للطريقة القديمة بالـ patterns
if (!matchedValue) {
  const basePattern = buildSlotPattern(job);
  const legacyTime  = buildLegacyTimeFromJob(job);

  const patterns = [];
  if (basePattern) patterns.push(basePattern);

  if (job.date && legacyTime) {
    const iso = String(job.date);
    const parts = iso.split('-'); // YYYY-MM-DD
    if (parts.length === 3) {
      const [Y, M, D] = parts;
      const dInt = parseInt(D, 10);
      const mInt = parseInt(M, 10);

      const dNoZero = `${dInt}-${mInt}-${Y}`;
      patterns.push(`${dNoZero}*${legacyTime}`);
      patterns.push(`${Y}-${M}-${D}*${legacyTime}`);
    }
  }

  console.log('[slot_debug] trying patterns:', patterns);

  if (patterns.length === 0) {
    console.error('[slot_debug] no patterns built (date/time invalid)');
    await snap(p, job, '09_no_pattern');
    throw new Error('slot_pattern_invalid');
  }

  matchedValue = await p.$$eval(
    'input[name="ss"]',
    (els, wantedList) => {
      const el = els.find((e) => {
        const v = e.value || '';
        return wantedList.some((p) => p && v.includes(p));
      });
      if (!el) return null;

      const label = el.closest('label');
      if (label) {
        label.click();
        return el.value;
      }
      el.click();
      return el.value;
    },
    patterns
  );
}

console.log('[slot_debug] picked slot radio value:', matchedValue);

if (!matchedValue) {
  console.error('[slot_debug] no matching slot radio (ssRaw + patterns)');
  await snap(p, job, '09_no_matching_slot');
  throw new Error('slot_not_found');
}

await snap(p, job, '09_after_pick_slot');


    /* ========== 5) الحجز (زر حجز/Reserve) ========== */

    await Promise.all([
      p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }),
      p.click(
        'input[type="submit"][name="submit"][value*="Reserve"], input[value*="حجز"]'
      ),
    ]);
    await snap(p, job, '11_after_reserve');

    /* ========== 6) لقطة نهائية + نتيجة وهمية ========== */

    const outDir = path.resolve(process.cwd(), 'screens');
    fs.mkdirSync(outDir, { recursive: true });
    const shotPath = path.join(
      outDir,
      `confirm_${job.booking_id || job.id}.png`
    );
    await p.screenshot({ path: shotPath, fullPage: true });

    result = {
      imdad_booking_id:
        'IMDAD-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      screenshot_url: shotPath,
    };
  } finally {
    try {
      if (p && p._phoenixBrowser) {
        await p._phoenixBrowser.close();
      }
    } catch (_) {}
  }

  return result;
}

/* =====================[ Notify server ]===================== */

async function markConfirmedOnServer({
  booking_id,
  nid,
  imdad_booking_id,
  screenshot_url,
}) {
  const url = `${BASE_URL}/api/internal/jobs/mark-confirmed`;
  const res = await axios.post(
    url,
    { booking_id, nid, imdad_booking_id, screenshot_url },
    {
      headers: {
        'X-QUEUE-SECRET': QUEUE_SECRET,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );

  if (res.status !== 200 || res.data?.ok !== true) {
    throw new Error(
      `[mark-confirmed] HTTP ${res.status} → ${JSON.stringify(res.data)}`
    );
  }
  return true;
}

/* =====================[ Process one job ]===================== */

async function processOne(job) {
  if (!job || !job.booking_id) throw new Error('invalid_job_payload');

  // 1) حجز الجلسة الأولى (الأساسية)
  console.log('[worker] booking PRIMARY slot for job', job.id);
  const result = await executeInImdad(job);

  // 2) لو في جلسة رتوش مرفقة نحاول نحجزها "بدون" ما نطيّح الجوب لو فشلت
  if (job.retouch) {
    const r = job.retouch || {};

    // لازم يكون عندنا على الأقل تاريخ + وقت أو ssRaw
    if (r.date || r.time || r.ssRaw) {
      // 🛑 حماية: تأكد أن الرتوش من عيادة ليزر نساء فقط
if (!r.doctorId || !r.doctorId.startsWith('d_laser_women')) {
  console.warn('[RETOUCH SKIPPED] invalid retouch doctor:', r.doctorId);
} else {
  // بناء retouchJob + الحجز
}


      const retouchJob = {
  ...job,

  // ⭐ هذا السطر هو الحل
  doctorId: r.doctorId || job.doctorId,

  // نغيّر التاريخ/الوقت/ssRaw إلى قيم الرتوش
  date: r.date || job.date,
  time: r.time || job.time,
  ssRaw: r.ssRaw || job.ssRaw,

  // booking_id مختلف للسكرين شوت فقط
  booking_id: `${job.booking_id}__retouch`,
};
// 👈 هنا بالضبط
console.log('[RETOUCH DEBUG]', {
  primaryDoctor: job.doctorId,
  retouchDoctor: r.doctorId,
  usedDoctor: retouchJob.doctorId,
});

      console.log('[worker] booking RETOUCH slot for job', job.id, '→', {
        date: retouchJob.date,
        time: retouchJob.time,
        ssRaw: retouchJob.ssRaw,
      });

      try {
        await executeInImdad(retouchJob);
        console.log('[worker] ✅ RETOUCH booked for job', job.id);
      } catch (err) {
        // ⚠️ مهم: لا نرمي الخطأ عشان ما يُعاد الجوب ويحجز الجلسة الأساسية مرة ثانية
        console.warn(
          '[worker] ⚠ RETOUCH failed but PRIMARY is booked. reason =',
          err.message
        );
      }
    } else {
      console.warn(
        '[worker] retouch object موجود لكن بدون date/time/ssRaw كافية، سيتم تجاهله'
      );
    }
  }

  // 3) إبلاغ السيرفر بحجز الجلسة الأساسية فقط (كما كان سابقًا)
  await markConfirmedOnServer({
    booking_id: job.booking_id,
    nid: job.nid,
    imdad_booking_id: result.imdad_booking_id,
    screenshot_url: result.screenshot_url,
  });
}



/* =====================[ Main loop ]===================== */

(async function mainLoop() {
  console.log('[worker] started. BASE_URL=', BASE_URL);
  console.log('[worker] env check:', {
    REDIS_URL: process.env.REDIS_URL,
    BASE_URL: process.env.BASE_URL,
    IMDAD_BASE_URL: process.env.IMDAD_BASE_URL,
    IMDAD_LOGIN_PATH: process.env.IMDAD_LOGIN_PATH,
    IMDAD_APPTS_PATH: process.env.IMDAD_APPTS_PATH,
  });

  for (;;) {
    try {
      const job = await dequeueJob(5);
      if (!job) continue;

      job.attempts = (job.attempts || 0) + 1;
      console.log(
        `[worker] processing #${job.id} (attempt ${job.attempts}/${MAX_ATTEMPTS})`
      );

      try {
        await processOne(job);
        await ackJob(job);
        console.log(`[worker] ✅ done #${job.id}`);
      } catch (err) {
        console.error(
          `[worker] ❌ failed #${job.id}: ${err.message}`
        );
        if (job.attempts >= MAX_ATTEMPTS) {
          await ackJob(job);
          console.error(
            `[worker] ✖ dropped #${job.id} after ${job.attempts} attempts`
          );
        } else {
          const backoffMs = Math.min(
            30000,
            1000 * 2 ** (job.attempts - 1)
          );
          await requeueJob(job, { delayMs: backoffMs });
          console.warn(
            `[worker] ↻ requeued #${job.id} after backoff ${backoffMs}ms`
          );
        }
      }
    } catch (e) {
      console.error('[worker] loop error:', e.message);
      await sleep(1000);
    }
  }
})();
