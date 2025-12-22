// server/imdad/bot.js
import dotenv from 'dotenv';
dotenv.config({ override: true });

import puppeteer from 'puppeteer';
import crypto from 'crypto';
import fs from 'fs';

import {
  IMDAD_BASE_URL,
  IMDAD_LOGIN_PATH,
  IMDAD_APPTS_PATH,
  IMDAD_USERNAME,
  IMDAD_PASSWORD,
} from './config.js';

import { isSlotAllowedByConfig } from './doctor_config.js';

/* ---------------- Utilities ---------------- */
const sha = (s) =>
  crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const stableId = (label, prefix) =>
  `${prefix}_${sha(String(label).normalize('NFC'))}`;

function normalizeArabicDigits(str = '') {
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const eastern = '۰۱۲۳۴۵۶۷۸۹';
  return String(str).replace(/[٠-٩۰-۹]/g, (d) => {
    const i1 = arabic.indexOf(d);
    if (i1 > -1) return String(i1);
    const i2 = eastern.indexOf(d);
    if (i2 > -1) return String(i2);
    return d;
  });
}

function parseArTimeToMinutes(t = '') {
  let s = normalizeArabicDigits(t).trim().replace(/\s+/g, '');
  let isAM = /ص/.test(s);
  let isPM = /م/.test(s);
  s = s.replace(/[صم]/g, '');
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);

  if (!isAM && !isPM) return hh * 60 + mm;

  if (isAM) {
    if (hh === 12) hh = 0;
  } else if (isPM) {
    if (hh < 12) hh += 12;
  }
  return hh * 60 + mm;
}

function periodWindowFromOptionValue(optionValue = '') {
  const perMatch = optionValue.match(/per_id=(\d+)/);
  const per = perMatch ? perMatch[1] : null;
  if (per === '1') return { min: 9 * 60, max: 11 * 60 + 30 };
  if (per === '2') return { min: 15 * 60, max: 20 * 60 + 30 };
  return { min: 0, max: 24 * 60 - 1 };
}

/* 🔁 توحيد IDs */
function canonicalDoctorId(id) {
  if (!id) return id;

  // ❌ لا نلمس الليزر أبدًا
  if (id.startsWith('d_laser')) return id;

  if (id === 'd_hasnaa_am' || id === 'd_hasnaa_pm') return 'd_hasnaa';
  if (id === 'd_ryan_am' || id === 'd_ryan_pm') return 'd_ryan';
  if (id === 'd_abeer_am' || id === 'd_abeer_pm') return 'd_abeer';
  if (id === 'd_general_am' || id === 'd_general_pm') return 'd_general';

  return id;
}


/* ---------------- Config checks ---------------- */
function assertConfig() {
  if (!IMDAD_BASE_URL || !IMDAD_LOGIN_PATH || !IMDAD_APPTS_PATH)
    throw new Error('❌ IMDAD config missing');
  if (!IMDAD_USERNAME || !IMDAD_PASSWORD)
    throw new Error('❌ Missing username/password');
}

/* ---------------- Puppeteer launch ---------------- */
function browserLaunchOptions() {
  const opts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=ar-SA,ar;q=0.9,en;q=0.8',
    ],
  };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  return opts;
}

/* ---------------- Clinic option mapping ---------------- */
function clinicOptionForDoctor(doctorId) {
  const key = `IMDAD_CLINIC_OPTION__${doctorId}`;
  return process.env[key] || process.env.IMDAD_CLINIC_OPTION || '';
}

const defaultDoctorLabels = {
  d_ryan: 'د. ريان صديق (أسنان)',
  d_abeer: 'د. عبير إبراهيم (أسنان)',
  d_ahmed_pm: 'د. أحمد عبدالله خليل (أسنان)',
  d_hasnaa: 'د. حسناء الموافي (نساء وولادة)',
  d_general: 'طبيب عام**الفترة الثانية',
  d_laser_am: 'عيادة الليزر (1)**الفترة الاولى',
  d_laser_pm: 'عيادة الليزر (1)**الفترة الثانية',
  d_laser_men_am: 'عيادة الليزر (رجال)**الفترة الاولى',
  d_laser_women2_pm: 'عيادة الليزر (نساء 2)**الفترة الثانية',
  d_clean_pm: 'عيادة تنظيف البشرة**الفترة الثانية',
  d_moath: 'د. معاذ علي',
  d_ronaldo: 'د. رونالدو كروز',
  d_walaa: 'د. ولاء',
};

function doctorLabel(doctorId, fallback = '') {
  const key = `DOCTOR_LABEL__${doctorId}`;
  return (
    process.env[key] ||
    defaultDoctorLabels[doctorId] ||
    fallback ||
    'العيادة المختارة'
  );
}

function filterSlotByDoctorTime({ doctorId, minutes, optionValue }) {
  const docId = canonicalDoctorId(doctorId);

  if (
  [
    'd_ryan',
    'd_abeer',
    'd_hasnaa',
    'd_general',
    'd_laser_am',
    'd_laser_pm',
    'd_laser_men_am',
    'd_laser_women2_pm'
  ].includes(docId)
)
  return true;


  const { min: MIN_M, max: MAX_M } = periodWindowFromOptionValue(optionValue);
  return minutes >= MIN_M && minutes <= MAX_M;
}

/* ---------------- Core Scraper ---------------- */
export async function fetchImdadSlots({ clinicId, yearMonth, doctorId }) {
  assertConfig();

  const browser = await puppeteer.launch(browserLaunchOptions());
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ar-SA,ar;q=0.9,en;q=0.8',
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36'
  );

  try {
    /* LOGIN */
    const loginUrl = `${IMDAD_BASE_URL}${IMDAD_LOGIN_PATH}`;
    console.log(`[ImdadBot] goto login: ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector('#username, input[name="username"]');
    await page.type('#username, input[name="username"]', IMDAD_USERNAME);
    await page.waitForSelector('#password, input[name="password"]');
    await page.type('#password, input[name="password"]', IMDAD_PASSWORD);

    await Promise.allSettled([
      page.click('input[type=submit], button[type=submit]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    /* OPEN APPOINTMENTS */
    const apptsUrl = `${IMDAD_BASE_URL}${IMDAD_APPTS_PATH}`;
    await page.goto(apptsUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    let usedOptionValue = '';
    const desired = clinicOptionForDoctor(doctorId);

    if (await page.$('#clinic_id')) {
      let val = desired;

      const exists = await page.$$eval(
        '#clinic_id option',
        (opts, wanted) => opts.some((o) => o.value === wanted),
        val
      );

      if (!exists) {
        val = await page.$eval('#clinic_id', (sel) => {
          const v = Array.from(sel.options)
            .map((o) => o.value)
            .filter((s) => s);
          return v[0] || '';
        });
      }

      usedOptionValue = val;

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.evaluate((v) => (window.location.href = v), val),
      ]);
    }

  /* SELECT 3 MONTHS */
try {
  const v = await page.$eval('#day_no', (sel) => {
    const found = [...sel.options].find((o) =>
      String(o.value).includes('day_no=90') // 👈 3 months
    );
    return found?.value || null;
  });

  if (v)
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.evaluate((v) => (window.location.href = v), v),
    ]);
} catch (_) {}


    /* EXTRACT */
    const radios = await page
      .$$eval('input[type=radio][name=ss]', (els) =>
        els.map((el) => {
          const v = String(el.value || '');
          const p = v.split('*');
          const rawDate = p[0] || '';
          const rawTime =
            el.closest('label')?.querySelector('span')?.textContent ||
            p[1] ||
            '';
          return { date: rawDate, time: rawTime, raw: v };
        })
      )
      .catch(() => []);

    const clinicText = await page
      .$eval('#clinic_id option:checked', (o) => o.textContent.trim())
      .catch(() => '');

    const drName = doctorLabel(doctorId, clinicText);
    const srvName = clinicText || 'العيادة المختارة';

    /* 🔥 laser flags ثابتة فوق الفلترة */
    const optionText = String(usedOptionValue || '');
    const isLaserMorning =
      optionText.includes('clinic_id=138') &&
      optionText.includes('per_id=1');
    const isLaserEvening =
      optionText.includes('clinic_id=138') &&
      optionText.includes('per_id=2');

    const normalized = (radios || [])
  .map((r) => {
    const dateTxt = normalizeArabicDigits(r.date);
    const timeTxt = normalizeArabicDigits(r.time);
    const minutes = parseArTimeToMinutes(timeTxt);

    const ssRaw = r.raw || null;

    const m = dateTxt.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    const isoDate = m ? `${m[3]}-${m[2]}-${m[1]}` : dateTxt;

    return { date: dateTxt, isoDate, time: timeTxt, minutes, ssRaw };
  })
  .filter((r) => {
    const opt = String(usedOptionValue || '');

    // 🔹 نحتفظ بهذي للتسمية فقط (periodType/Label)
    const isLaserMorning =
      opt.includes('clinic_id=138') && opt.includes('per_id=1');
    const isLaserEvening =
      opt.includes('clinic_id=138') && opt.includes('per_id=2');
      const isLaserMenMorning =
  opt.includes('clinic_id=133') && opt.includes('per_id=1');

const isLaserWomen2Evening =
  opt.includes('clinic_id=133') && opt.includes('per_id=2');


    const stableDocId = canonicalDoctorId(doctorId) || doctorId;

    // 1) أولاً: نطبق فترات لوحة الموظف على الجميع (بما فيهم الليزر)
    if (
  !isSlotAllowedByConfig(
    {
      slotDoctorId: stableDocId,
      serviceId: doctorId, // 👈 مهم جدًا (laser_women / laser_men)
    },
    r.isoDate,
    r.minutes
  )
) {
  return false;
}


    // 2) دكاترة نعتمد فقط على لوحة الموظف (ما نستخدم per_id)
    if (
      [
        'd_ryan',
        'd_abeer',
        'd_hasnaa',
        'd_general',
        'd_walaa',
        'd_moath',
        'd_ronaldo',
        'd_ahmed_pm',
        'd_laser_am',
        'd_laser_pm',
      ].includes(stableDocId)
    ) {
      return true;
    }

    // 3) الباقي يستخدم فلترة per_id كالعادة
    return filterSlotByDoctorTime({
      doctorId,
      minutes: r.minutes,
      optionValue: usedOptionValue,
    });
  })
  .map((r) => {
    const isoDate = r.isoDate;
    const doctorIdStable = canonicalDoctorId(doctorId) || stableId(drName, 'doc');
    const serviceId = stableId(srvName, 'srv');

    const idSeed = `${isoDate}_${r.time}_${doctorIdStable}`;
    const numStr = sha(idSeed).replace(/[a-f]/g, (c) =>
      String(c.charCodeAt(0) % 10)
    );
    const id = Number(`1${numStr}`);

    // 👇 نستخدم isLaserMorning/Evening هنا فقط للتسمية
    const opt = String(usedOptionValue || '');
    const isLaserMorning =
      opt.includes('clinic_id=138') && opt.includes('per_id=1');
    const isLaserEvening =
      opt.includes('clinic_id=138') && opt.includes('per_id=2');
      const isLaserMenMorning =
  opt.includes('clinic_id=133') && opt.includes('per_id=1');

const isLaserWomen2Evening =
  opt.includes('clinic_id=133') && opt.includes('per_id=2');


    return {
      id,
      date: isoDate,
      time: r.time.replace(/\s+/g, ''),
      doctorId: doctorIdStable,
      doctorName: drName,
      serviceId,
      serviceName: srvName,
      available: true,
      ssRaw: r.ssRaw || null,
      periodType: isLaserMorning
          ? 'am'
          : isLaserEvening
              ? 'pm'
              : null,
      periodLabel: isLaserMorning
          ? 'الفترة الصباحية'
          : isLaserEvening
              ? 'الفترة المسائية'
              : null,
    };
  });


    console.log(`[ImdadBot] extracted ${normalized.length} slots`);
    return normalized;
  } catch (err) {
    console.error('[ImdadBot] error:', err);
    throw err;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
