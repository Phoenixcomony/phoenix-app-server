// server/workers/imdad_newfile.js
import 'dotenv/config';
import puppeteer from 'puppeteer';
import axios from 'axios';
import Redis from 'ioredis';

/* ========== Env ========== */
const {
  REDIS_URL = 'redis://127.0.0.1:6379',
  BASE_URL = 'http://localhost:3000',
  QUEUE_SECRET = '',
} = process.env;

const isTLS = REDIS_URL.startsWith('rediss://');
const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  tls: isTLS ? {} : undefined,
});

const NEWFILE_Q      = 'q:imdad:newfile';
const NEWFILE_Q_PROC = 'q:imdad:newfile:processing';

const USER_SEL   = process.env.IMDAD_USER_SELECTOR   || '#username, input[name="username"]';
const PASS_SEL   = process.env.IMDAD_PASS_SELECTOR   || '#password, input[name="password"]';
const SUBMIT_SEL = process.env.IMDAD_SUBMIT_SELECTOR || 'button[type=submit], input[type=submit], #submit, .btn-login, .btn.btn-primary';
const POST_SEL   = process.env.IMDAD_POST_LOGIN_SELECTOR || '#mainNav,.navbar,.top-menu,#wrapper,#content,body.logged-in';

function must(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing .env key: ${k}`);
  return v;
}

const IMDAD_BASE_URL   = must('IMDAD_BASE_URL');
const IMDAD_LOGIN_PATH = must('IMDAD_LOGIN_PATH');

// حساب مخصص لهذا العامل (newfile) مع fallback
const IMDAD_LOGIN_USER =
  process.env.IMDAD_NEWFILE_USERNAME ||
  process.env.IMDAD_WORKER_USERNAME ||
  process.env.IMDAD_USERNAME ||
  '';

const IMDAD_LOGIN_PASS =
  process.env.IMDAD_NEWFILE_PASSWORD ||
  process.env.IMDAD_WORKER_PASSWORD ||
  process.env.IMDAD_PASSWORD ||
  '';

if (!IMDAD_LOGIN_USER || !IMDAD_LOGIN_PASS) {
  console.warn('⚠️ IMDAD_NEWFILE/WORKER USERNAME/PASSWORD غير مضبوطة، قد يفشل تسجيل الدخول.');
}

/* ========== Helpers ========== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function joinUrl(base, p) {
  return base.replace(/\/+$/, '') + '/' + String(p || '').replace(/^\/+/, '');
}

async function gotoWithRetry(p, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[NAV] goto attempt ${i + 1}/${retries} →`, url);
      await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      return;
    } catch (err) {
      console.warn(`[NAV] attempt ${i + 1} failed: ${err.message}`);
      await sleep(1500);
    }
  }
  throw new Error(`goto_failed_after_${retries}_attempts: ${url}`);
}

async function getPage() {
  const exe = process.env.CHROME_PATH?.trim() || undefined;

  console.log('[BROWSER] launching Chromium (headless=new)…');
  const browser = await puppeteer.launch({
    headless: 'new', // يعمل خلف الكواليس
    executablePath: exe,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  page._phoenixBrowser = browser;
  return page;
}

async function snap(p, job, tag) {
  // لو بغيت screenshots فعّل هنا
  return;
}

function normalizePhoneLocal(phone) {
  if (!phone) return '';
  let s = String(phone).trim();
  if (s.startsWith('+966')) return '0' + s.slice(4);
  if (s.startsWith('966'))  return '0' + s.slice(3);
  return s;
}

function parseBirth(birthStr) {
  if (!birthStr) return { day: null, month: null, year: null };
  const s = String(birthStr).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return { day: null, month: null, year: null };
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
  };
}

function detectGenderValue(g) {
  if (!g) return '1';
  const s = String(g).toLowerCase();
  if (s.startsWith('f') || s.includes('انث') || s.includes('female')) return '2';
  return '1';
}

function detectNationalityValue(n) {
  if (!n) return '27';
  const s = String(n).toLowerCase();
  if (s.includes('sa') || s.includes('سعود')) return '1'; // سعودي
  return '27'; // Other
}

/* ========== Queue helpers ========== */

async function dequeueJob(blockSeconds = 5) {
  const raw = await redis.brpoplpush(NEWFILE_Q, NEWFILE_Q_PROC, blockSeconds);
  if (!raw) return null;
  try {
    const job = JSON.parse(raw);
    job._raw = raw;
    return job;
  } catch {
    await redis.lrem(NEWFILE_Q_PROC, 1, raw);
    return null;
  }
}

async function ackJob(job) {
  if (!job?._raw) return;
  await redis.lrem(NEWFILE_Q_PROC, 1, job._raw);
}

async function requeueJob(job, delayMs = 0) {
  if (job?._raw) {
    await redis.lrem(NEWFILE_Q_PROC, 1, job._raw);
  }
  const clone = { ...job };
  delete clone._raw;
  if (delayMs > 0) await sleep(delayMs);
  await redis.rpush(NEWFILE_Q, JSON.stringify(clone));
}

/* ========== Imdad logic ========== */

async function ensureLoggedIn(p) {
  console.log('[LOGIN] using user =', IMDAD_LOGIN_USER);
  await gotoWithRetry(p, joinUrl(IMDAD_BASE_URL, IMDAD_LOGIN_PATH));
  await snap(p, { id: 'login' }, '00_login_page');

  let loggedIn = false;
  try {
    if (await p.$(POST_SEL)) loggedIn = true;
  } catch (_) {}

  if (loggedIn) {
    console.log('[LOGIN] already logged in (POST_SEL found).');
    return;
  }

  console.log('[LOGIN] filling username/password…');

  const userSel = (await p.$(USER_SEL)) ? USER_SEL : '#username';
  const passSel = (await p.$(PASS_SEL)) ? PASS_SEL : '#password';

  await p.focus(userSel);
  await p.$eval(userSel, (el) => (el.value = ''));
  await p.type(userSel, IMDAD_LOGIN_USER, { delay: 35 });

  await p.focus(passSel);
  await p.$eval(passSel, (el) => (el.value = ''));
  await p.type(passSel, IMDAD_LOGIN_PASS, { delay: 35 });

  await snap(p, { id: 'login' }, '00_filled_credentials');

  const subSel = (await p.$(SUBMIT_SEL))
    ? SUBMIT_SEL
    : 'input[type=submit],button[type=submit]';

  console.log('[LOGIN] clicking submit selector =', subSel);

  await Promise.all([
    p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
    p.click(subSel),
  ]);

  await sleep(1200);
  const url = await p.evaluate(() => window.location.href);
  console.log('[LOGIN] after login URL =', url);

  await snap(p, { id: 'login' }, '00_logged_in');
}

/**
 * بحث في مربع البحث العلوي:
 * - يكتب الهوية ببطء
 * - ينتظر ظهور li[onclick^="fillSearch12("]
 */
async function searchExistingFile(p, nid, label = 'generic') {
  console.log(`[SEARCH:${label}] searching for nid=`, nid);
  await p.waitForSelector('#navbar-search-input', { timeout: 15000 });

  await p.click('#navbar-search-input');
  await p.$eval('#navbar-search-input', (el) => (el.value = ''));

  await p.type('#navbar-search-input', nid, { delay: 120 });

  await p.evaluate(() => {
    const el = document.querySelector('#navbar-search-input');
    if (!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: '0', bubbles: true }));
  });

  await sleep(800);

  let hasSuggestions = await p
    .waitForFunction(
      () => document.querySelectorAll('li[onclick^="fillSearch12("]').length > 0,
      { timeout: 4000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!hasSuggestions) {
    await sleep(1500);
    hasSuggestions = await p.evaluate(
      () => document.querySelectorAll('li[onclick^="fillSearch12("]').length > 0
    );
  }

  if (!hasSuggestions) {
    console.log(`[SEARCH:${label}] no suggestions → patient not found.`);
    return { existed: false, fileId: null };
  }

  const firstText = await p.$eval(
    'li[onclick^="fillSearch12("]',
    (el) => el.textContent || ''
  );
  const parts = firstText.split('*');
  const fileId = parts.length >= 2 ? parts[1].trim() : null;

  await p.evaluate(() => {
    const el = document.querySelector('li[onclick^="fillSearch12("]');
    if (el) el.click();
  });

  await sleep(600);

  console.log(`[SEARCH:${label}] patient exists — first suggestion text =`, firstText);
  console.log(`[SEARCH:${label}] parsed fileId =`, fileId);

  return { existed: true, fileId };
}

async function createNewFile(p, job) {
  console.log('[NEWFILE] creating new file in Imdad for nid =', job.nid);
  console.log('[NEWFILE] job data:', {
    nid: job.nid,
    phone_e164: job.phone_e164,
    gender: job.gender,
    nationality: job.nationality,
    fullName: job.fullName,
    birth_date: job.birth_date,
  });

  // افتح صفحة "ملف جديد"
  const newFileUrl = 'https://phoenix.imdad.cloud/medica13/stq_add.php';
  await gotoWithRetry(p, newFileUrl);

  await sleep(1500);
  await p.waitForSelector('#fname', { timeout: 20000 });

  await snap(p, job, '02_on_newfile_page');

  // ===== تحضير البيانات =====
  const localPhone = normalizePhoneLocal(job.phone_e164);
  const genderVal  = detectGenderValue(job.gender);
  const natVal     = detectNationalityValue(job.nationality);
  let birth        = parseBirth(job.birth_date);

  if (!birth.day || !birth.month || !birth.year) {
    birth = { day: 1, month: 1, year: 2000 };
  }

  const { day, month, year } = birth;

  console.log('[NEWFILE] resolved data to fill:', {
    localPhone,
    genderVal,
    natVal,
    birth,
  });

  // ===== 1) الاسم بالعربي =====
  const fullName = job.fullName || 'مراجع';
  await p.$eval('#fname', (el) => (el.value = ''));
  await p.type('#fname', fullName, { delay: 35 });

  // ===== 2) الاسم بالإنجليزي =====
  await p.evaluate((fallbackName) => {
    const enDiv = document.querySelector('#ename');
    if (!enDiv) return;
    const inp = enDiv.querySelector('input[name="ename"]');
    if (!inp) return;
    if (!inp.value || !inp.value.trim()) {
      inp.value = fallbackName;
    }
  }, fullName);

  // ===== 3) الهوية =====
  await p.$eval('#ssn', (el) => (el.value = ''));
  await p.type('#ssn', String(job.nid), { delay: 35 });

  // ===== 4) تاريخ الميلاد =====
  await p.waitForSelector('#day12', { timeout: 10000 });

  await p.select('#day12', String(day));
  await p.waitForFunction(
    (v) => document.querySelector('#day12')?.value === String(v),
    {},
    day
  );
  await sleep(200);

  await p.select('#month12', String(month));
  await p.waitForFunction(
    (v) => document.querySelector('#month12')?.value === String(v),
    {},
    month
  );
  await sleep(200);

  await p.select('#year12', String(year));
  await p.waitForFunction(
    (v) => document.querySelector('#year12')?.value === String(v),
    {},
    year
  );
  await sleep(250);

  // ===== 5) الجنس =====
  await p.select('#gender', genderVal);

  // ===== 6) الجنسية =====
  await p.select('#n', natVal);

  // ===== 7) الهاتف =====
  if (localPhone) {
    await p.$eval('#phone', (el) => (el.value = ''));
    await p.type('#phone', localPhone, { delay: 30 });
  }

  // ===== 8) لا نلمس التأمين ولا حقول com_name,pno,class_name,assur_no =====
  const textInputsDebug = await p.evaluate((fallbackName) => {
    const fallback = fallbackName && fallbackName.trim()
      ? fallbackName
      : 'Patient';

    const inputs = Array.from(
      document.querySelectorAll('input[type="text"]')
    );

    const unsafeNames = ['com_name', 'pno', 'class_name', 'assur_no'];
    const debug = [];

    for (const inp of inputs) {
      const id   = inp.id   || '';
      const name = inp.name || '';

      // نتجاهل كل حقول التأمين
      if (unsafeNames.includes(name)) continue;

      // لا نلمس الحقول اللي عَبّيناها يدويًا
      if (id === 'fname' || name === 'full_name') continue;
      if (id === 'ssn'   || name === 'ssn')       continue;
      if (id === 'phone' || name === 'phone')     continue;

      // لو الحقل داخل .hidden-content (بلوك التأمين) نتجاهله
      if (inp.closest('.hidden-content')) continue;

      // هنا فقط نطبع القيم، ونعطي قيمة افتراضية للحقول الفارغة (للتجربة)
      if (!inp.value || !inp.value.trim()) {
        inp.value = fallback;
      }

      debug.push({
        id,
        name,
        value: inp.value,
      });
    }

    return debug;
  }, fullName);

  console.log('[NEWFILE] filled extra text inputs:', textInputsDebug);

  await snap(p, job, '03_filled_newfile_form');

  // ===== 9) تسجيل (آخر خطوة) =====
  console.log('[NEWFILE] submitting new file form…');
  await p.waitForSelector('#submit', { visible: true, timeout: 20000 });

  await Promise.all([
    p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
    p.evaluate(() => {
      const btn = document.querySelector('#submit');
      if (!btn) return;
      btn.scrollIntoView({ block: 'center', inline: 'center' });
      btn.click();
    }),
  ]);

  await snap(p, job, '04_after_submit_newfile');

  const afterUrl = await p.evaluate(() => window.location.href);
  const snippet  = await p.evaluate(
    () => (document.body.innerText || '').slice(0, 1200)
  );

  console.log('[NEWFILE] after submit URL =', afterUrl);
  console.log('[NEWFILE] after submit snippet =', snippet);

  if (afterUrl.includes('alert.php')) {
    // هنا نوضح أن المشكلة صلاحيات
    console.error('[NEWFILE] ⚠️ alert.php detected → يبدو أن المستخدم لا يملك صلاحية فتح ملف جديد (New Patient).');
  }

  console.log('[NEWFILE] submit done, will re-search patient by nid');

  return { afterUrl, snippet };
}

async function executeNewFileJob(job) {
  if (!job || !job.nid) throw new Error('invalid_job_payload');

  console.log('==============================');
  console.log('[JOB] executing newfile job:', job);
  console.log('==============================');

  const p = await getPage();
  let result = null;

  try {
    await ensureLoggedIn(p);

    // 1) بحث أولي – هل له ملف أصلاً؟
    const existing = await searchExistingFile(p, job.nid, 'before_create');
    if (existing.existed) {
      console.log('[JOB] patient already exists before createNewFile:', existing);
      result = { existed: true, fileId: existing.fileId || null };
    } else {
      // 2) لا يوجد → أنشئ ملف جديد
      const { afterUrl, snippet } = await createNewFile(p, job);

      // لو alert.php وفيه صلاحية غير مفعلة → نطبعها صراحة
      if (afterUrl.includes('alert.php')) {
        if (snippet.includes('صلاحية غير مفعلة') || snippet.toLowerCase().includes('do not have permission')) {
          console.error('[JOB] ❌ permission error from Imdad: صلاحية غير مفعلة لفتح ملف جديد.');
        } else {
          console.error('[JOB] ❌ alert.php returned but without explicit permission text.');
        }
      }

      // 3) بعد الحفظ، نرجع للسيرش وندور المريض
      const after = await searchExistingFile(p, job.nid, 'after_create');

      if (after.existed) {
        console.log('[JOB] patient found after createNewFile:', after);
        result = { existed: false, fileId: after.fileId || null };
      } else {
        console.error('[JOB] patient still not found after submission → likely failed (permissions/validation).');
        throw new Error('newfile_submit_maybe_failed_no_patient_found');
      }
    }
  } finally {
    try {
      if (p && p._phoenixBrowser) {
        console.log('[BROWSER] closing browser…');
        await p._phoenixBrowser.close();
      }
    } catch (_) {}
  }

  console.log('[JOB] final result for nid', job.nid, '→', result);
  return result;
}

/* ========== Notify server ========== */

async function notifyServerNewFile(job, result) {
  const url = `${BASE_URL}/api/internal/imdad/new-file/done`;
  console.log('[NOTIFY] POST', url, 'payload=', {
    nid: job.nid,
    file_id: result.fileId || null,
    existed: !!result.existed,
  });

  const res = await axios.post(
    url,
    {
      nid: job.nid,
      file_id: result.fileId || null,
      existed: !!result.existed,
    },
    {
      headers: {
        'X-QUEUE-SECRET': QUEUE_SECRET,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );

  console.log('[NOTIFY] response status =', res.status, 'data =', res.data);

  if (res.status !== 200 || res.data?.ok !== true) {
    throw new Error(
      `[new-file/done] HTTP ${res.status} → ${JSON.stringify(res.data)}`
    );
  }
}

/* ========== Main loop ========== */

const MAX_ATTEMPTS = Math.max(
  1,
  parseInt(process.env.NEWFILE_MAX_ATTEMPTS || '5', 10)
);

async function processOne(job) {
  if (!job.nid) throw new Error('invalid_job_payload');

  const result = await executeNewFileJob(job);
  await notifyServerNewFile(job, result);
}

(async function mainLoop() {
  try {
    await redis.connect();
  } catch (e) {
    console.error('[NEWFILE] Redis connect error:', e.message || e);
    process.exit(1);
  }

  console.log('[NEWFILE] worker started. BASE_URL =', BASE_URL);
  console.log('[NEWFILE] using IMDAD_NEWFILE_USERNAME =', IMDAD_LOGIN_USER);

  for (;;) {
    try {
      let job = await dequeueJob(5);
      if (!job) continue;

      job.attempts = (job.attempts || 0) + 1;
      console.log(
        `[NEWFILE] processing #${job.id || 'no-id'} (attempt ${job.attempts}/${MAX_ATTEMPTS})`
      );

      try {
        await processOne(job);
        await ackJob(job);
        console.log(`[NEWFILE] ✅ done #${job.id || 'no-id'}`);
      } catch (err) {
        console.error(
          `[NEWFILE] ❌ failed #${job.id || 'no-id'}: ${err.message}`
        );
        if (job.attempts >= MAX_ATTEMPTS) {
          await ackJob(job);
          console.error(
            `[NEWFILE] ✖ dropped #${job.id || 'no-id'} after ${job.attempts} attempts`
          );
        } else {
          const backoffMs = Math.min(30000, 1000 * 2 ** (job.attempts - 1));
          await requeueJob(job, backoffMs);
          console.warn(
            `[NEWFILE] ↻ requeued #${job.id || 'no-id'} after backoff ${backoffMs}ms`
          );
        }
      }
    } catch (e) {
      console.error('[NEWFILE] loop error:', e.message || e);
      await sleep(1000);
    }
  }
})();
