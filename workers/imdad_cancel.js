// server/workers/imdad_cancel.js
// بوت إلغاء المواعيد في إمداد (يستخدم يوزر/باس خاصين)

import 'dotenv/config';
import puppeteer from 'puppeteer';
import Redis from 'ioredis';

/* =============[ ENV ]============= */

const {
  REDIS_URL = 'redis://localhost:6379',

  IMDAD_BASE_URL = 'https://phoenix.imdad.cloud',
  IMDAD_LOGIN_PATH = '/medica13/login.php',
  IMDAD_APPTS_PATH = '/medica13/appoint_display.php',

  // يوزر/باس خاصين للإلغاء
  IMDAD_CANCEL_USERNAME,
  IMDAD_CANCEL_PASSWORD,

  // fallback ليوزر الحجز لو ما حطّيت يوزر خاص للكانسل
  IMDAD_USERNAME,
  IMDAD_PASSWORD,

  // مفتاح الطابور الخاص بالإلغاء
  IMDAD_CANCEL_QUEUE_KEY = 'q:imdad:cancel',

  // سرّ الطابور (حاليًا لا نستخدمه هنا، بس ممكن تحتاجه لاحقًا)
  QUEUE_SECRET = '',
} = process.env;

const CANCEL_QUEUE_KEY = IMDAD_CANCEL_QUEUE_KEY;

/* =============[ Redis ]============= */

const isTLS = REDIS_URL.startsWith('rediss://');
const redis = new Redis(REDIS_URL, { tls: isTLS ? {} : undefined });

/* =============[ Helpers عامة ]============= */

function getCancelCredentials() {
  const user = IMDAD_CANCEL_USERNAME || IMDAD_USERNAME;
  const pass = IMDAD_CANCEL_PASSWORD || IMDAD_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'IMDAD_CANCEL_USERNAME/IMDAD_CANCEL_PASSWORD (أو IMDAD_USERNAME/IMDAD_PASSWORD) غير موجودة في .env'
    );
  }
  return { user, pass };
}

function normalizeDate(str) {
  // يدعم شكل "20-11-2025" أو "2025-11-20"
  if (!str) return null;
  const parts = str.split('-').map((s) => s.trim());
  if (parts.length !== 3) return null;

  if (parts[0].length === 4) {
    // 2025-11-20
    return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  } else {
    // 20-11-2025 => 2025-11-20
    return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
}

function normalizeTime(str) {
  // مثال: "2:00 م" أو "3:30 ص" أو "1:00ص"
  if (!str) return null;
  let s = String(str).replace(/\s+/g, ' ').trim();
  const isPM = s.includes('م');
  const isAM = s.includes('ص');

  s = s.replace(/[^\d:]/g, ''); // نشيل الأحرف العربية ونترك الأرقام والنقطتين
  const [hRaw, mRaw] = s.split(':');
  let h = parseInt(hRaw || '0', 10);
  const m = parseInt(mRaw || '0', 10);

  if (isPM && h < 12) h += 12;
  if (isAM && h === 12) h = 0;

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* =============[ Puppeteer: تسجيل الدخول ]============= */

async function loginToImdad(page) {
  const { user, pass } = getCancelCredentials();
  const loginUrl = IMDAD_BASE_URL + IMDAD_LOGIN_PATH;

  console.log('[cancel] opening login page:', loginUrl);
  await page.goto(loginUrl, { waitUntil: 'networkidle2' });

  const USER_SEL = '#username, input[name="username"]';
  const PASS_SEL = '#password, input[name="password"]';
  const SUBMIT_SEL =
    'button[type=submit], input[type=submit], #submit, .btn-login, .btn.btn-primary';

  await page.waitForSelector(USER_SEL);
  const userInput = await page.$(USER_SEL);
  const passInput = await page.$(PASS_SEL);

  if (!userInput || !passInput) {
    throw new Error(
      '[cancel] لم يتم العثور على حقول اليوزر/الباس في صفحة تسجيل الدخول'
    );
  }

  await userInput.click({ clickCount: 3 });
  await userInput.type(user, { delay: 50 });

  await passInput.click({ clickCount: 3 });
  await passInput.type(pass, { delay: 50 });

  const submitBtn = await page.$(SUBMIT_SEL);
  if (!submitBtn) {
    throw new Error('[cancel] لم يتم العثور على زر الدخول');
  }

  await Promise.all([
    submitBtn.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
  ]);

  console.log('[cancel] login done');
}

/* =============[ Puppeteer: إلغاء موعد واحد ]============= */

/**
 * payload المتوقع (من السيرفر):
 * {
 *   nationalId: '1234567890',           // رقم الهوية
 *   date: '2025-11-20' أو '20-11-2025', // تاريخ الموعد
 *   time: '3:00م',                      // وقت الموعد (مع ص/م أو بدون)
 *   clinic: '...',                      // اختياري (نستخدمه مستقبلاً لو حاب)
 *   doctor: '...',                      // اختياري
 *   bookingId: 'bk_...'                 // رقم الحجز عندنا
 * }
 */
async function cancelAppointmentInImdad(page, payload) {
  const { nationalId, date, time, clinic, doctor } = payload;
  if (!nationalId || !date || !time) {
    throw new Error(
      '[cancel] nationalId + date + time مطلوبة في الـ payload'
    );
  }

  const targetDate = normalizeDate(date);
  const targetTime = normalizeTime(time); // يحوّل "3:00م" → "15:00"

  console.log('[cancel] target:', {
    nationalId,
    targetDate,
    targetTime,
    clinic,
    doctor,
  });

  // 1) افتح صفحة المواعيد
  const apptsUrl = IMDAD_BASE_URL + IMDAD_APPTS_PATH;
  console.log('[cancel] open appointments page:', apptsUrl);
  await page.goto(apptsUrl, { waitUntil: 'networkidle2' });

  // 2) كتابة الهوية واختيار أول مريض من القائمة المنسدلة
  try {
    const nidStr = String(nationalId || '').trim();
    console.log('[cancel] nidStr =', nidStr);

    await page.waitForSelector('#SearchBox120', { timeout: 15000 });

    await page.evaluate((nid) => {
      const el = document.querySelector('#SearchBox120');
      if (!el) return;

      el.value = '';
      el.value = nid;

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(
        new KeyboardEvent('keyup', { key: '0', bubbles: true })
      );
    }, nidStr);

    const typedVal = await page.$eval('#SearchBox120', (el) => el.value);
    console.log('[cancel] value after type =', typedVal);

    const hadSuggestions = await page
      .waitForFunction(
        () =>
          document.querySelectorAll('li[onclick^="fillSearch120("]').length >
          0,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);

    if (!hadSuggestions) {
      console.error(`[cancel] no patient suggestions for NID: ${nidStr}`);
      throw new Error('no_patient_suggestions_for_nid');
    }

    await page.click('li[onclick^="fillSearch120("]');
    console.log('[cancel] patient suggestion clicked');
  } catch (e) {
    console.error('[cancel] nid_search error:', e.message || e);
    throw e;
  }

  // 3) اضغط زر "بحث : Search"
  const searchBtnSelector = 'input[name="submit"][value*="بحث"]';
  const searchBtn = await page.$(searchBtnSelector);
  if (!searchBtn) {
    throw new Error('[cancel] لم يتم العثور على زر "بحث : Search"');
  }

  await Promise.all([
    searchBtn.click(),
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
  ]);
  console.log('[cancel] search submitted, waiting for table...');

  // 4) ابحث عن الصف المطلوب في جدول المواعيد
  const match = await page.evaluate(
    ({ targetDate, targetTime }) => {
      function normalizeDateInRow(d) {
        if (!d) return null;
        const parts = d.split('-').map((s) => s.trim());
        if (parts.length !== 3) return null;
        if (parts[0].length === 4) {
          // 2025-11-20
          return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(
            2,
            '0'
          )}`;
        } else {
          // 20-11-2025
          return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(
            2,
            '0'
          )}`;
        }
      }

      function normalizeTimeInRow(str) {
        if (!str) return null;
        let s = str.replace(/\s+/g, ' ').trim();
        const isPM = s.includes('م');
        const isAM = s.includes('ص');
        s = s.replace(/[^\d:]/g, '');
        const [hRaw, mRaw] = s.split(':');
        let h = parseInt(hRaw || '0', 10);
        const m = parseInt(mRaw || '0', 10);
        if (isPM && h < 12) h += 12;
        if (isAM && h === 12) h = 0;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }

      const rows = Array.from(
        document.querySelectorAll('table tbody tr')
      );
      const dataRows = rows.slice(2); // نتجاوز صف العنوان + الهيدر

      for (const tr of dataRows) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 12) continue;

        const dateText = tds[1].textContent.trim();
        const timeText = tds[2].textContent.trim();
        const clinicText = tds[3].textContent.trim();
        const doctorText = tds[4].textContent.trim();

        const rowDate = normalizeDateInRow(dateText);
        const rowTime = normalizeTimeInRow(timeText);

        if (rowDate !== targetDate) continue;
        if (rowTime !== targetTime) continue;

        const deleteLink = tr.querySelector(
          'a[href*="appoint_delete.php"]'
        );
        if (!deleteLink) continue;

        const href = deleteLink.getAttribute('href') || '';
        return {
          href,
          dateText,
          timeText,
          clinicText,
          doctorText,
        };
      }

      return null;
    },
    { targetDate, targetTime }
  );

  if (!match) {
    throw new Error(
      '[cancel] لم يتم العثور على موعد يطابق التاريخ/الوقت المحددة'
    );
  }

  console.log('[cancel] matched row:', match);

  // 5) اضغط زر الإلغاء (سيُظهر confirm من d_cancel())
  await page.evaluate((href) => {
    const link = Array.from(
      document.querySelectorAll('a[href*="appoint_delete.php"]')
    ).find((a) => a.getAttribute('href') === href);
    if (link) {
      link.click();
    }
  }, match.href);

  // ننتظر شوية لتطبيق الإلغاء / إعادة تحميل الصفحة
  await new Promise((r) => setTimeout(r, 2000));
  console.log('[cancel] delete click done, waiting final state...');
}

/* =============[ Main Loop: طابور الإلغاء ]============= */

async function main() {
  console.log('[cancel] worker started');
  console.log('[cancel] REDIS_URL =', REDIS_URL);
  console.log('[cancel] IMDAD_BASE_URL =', IMDAD_BASE_URL);
  console.log('[cancel] QUEUE_KEY =', CANCEL_QUEUE_KEY);

  try {
    while (true) {
      console.log('[cancel] waiting for job…');

      // نقرأ جوب من الطابور q:imdad:cancel (ويُحذف تلقائيًا من القائمة)
      const raw = await redis.brpop(CANCEL_QUEUE_KEY, 0);
      if (!raw) continue;

      const job = JSON.parse(raw[1]);
      console.log('[cancel] got job:', job);

      // 💡 متصفّح + صفحة جديدة لكل جوب
      const browser = await puppeteer.launch({
       headless: "new",   
        defaultViewport: null,
        args: ['--start-maximized'],
      });

      const page = await browser.newPage();

      // 👇 قبول أي Dialog (رسالة تأكيد الإلغاء)
      page.on('dialog', async (dialog) => {
        try {
          console.log('[cancel] dialog message:', dialog.message());
          await dialog.accept();
        } catch (err) {
          console.error(
            '[cancel] error handling dialog:',
            err.message || err
          );
        }
      });

      try {
        await loginToImdad(page);
        await cancelAppointmentInImdad(page, job);

        console.log(
          '[cancel] job done for bookingId =',
          job.bookingId
        );
      } catch (err) {
        console.error('[cancel] job error:', err);
        // لو حاب ترجع الجوب للطابور في حالة الفشل:
        // await redis.rpush(CANCEL_QUEUE_KEY, JSON.stringify(job));
      } finally {
        try {
          await page.close();
        } catch (_) {}
        try {
          await browser.close();
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('[cancel] fatal error:', err);
  } finally {
    await redis.quit();
  }
}

// تشغيل العامل إذا هذا الملف هو الـ entry
if (process.argv[1] && process.argv[1].includes('imdad_cancel.js')) {
  main();
}
