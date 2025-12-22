// server/imdad/doctorPeriodsStore.js
import fs from 'fs';
import path from 'path';

const FILE_PATH = path.join(process.cwd(), 'server', 'data', 'doctor_periods.json');

function readAll() {
  try {
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    // لو الملف مو موجود أو فاضي نرجّع كائن فاضي
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * توحيد أسماء الدكاترة قبل قراءة الفترات
 * أي اسم/ID غريب نحاول نحوله لـ ID ثابت مثل d_ryan, d_abeer, d_ahmed_pm ...
 */
function normalizeDoctorId(doctorId) {
  if (!doctorId) return '';

  const raw = String(doctorId).trim();
  const id  = raw.toLowerCase();

  // 🔹 IDs المعتمدة كما هي (بدون أي تحويل)
  if (raw === 'd_laser_am') return 'd_laser_am';
  if (raw === 'd_laser_pm') return 'd_laser_pm';

  if (raw === 'd_clean_pm')   return 'd_clean_pm';
  if (raw === 'd_ryan')       return 'd_ryan';
  if (raw === 'd_abeer')      return 'd_abeer';
  if (raw === 'd_moath')      return 'd_moath';
  if (raw === 'd_ronaldo')    return 'd_ronaldo';
  if (raw === 'd_hasnaa')     return 'd_hasnaa';
  if (raw === 'd_walaa')      return 'd_walaa';
  if (raw === 'd_general')    return 'd_general';
  if (raw === 'd_ahmed_pm')   return 'd_ahmed_pm';

  // أسنان (أسماء)
  if (id.includes('ryan')   || id.includes('ريان'))     return 'd_ryan';
  if (id.includes('abeer')  || id.includes('عبير'))     return 'd_abeer';
  if (id.includes('moath')  || id.includes('معاذ'))     return 'd_moath';
  if (id.includes('ronaldo')|| id.includes('رونالدو'))  return 'd_ronaldo';

  // نساء وولادة
  if (id.includes('hasnaa') || id.includes('حسناء'))    return 'd_hasnaa';

  // جلدية
  if (id.includes('walaa')  || id.includes('wlaa') || id.includes('ولاء'))
    return 'd_walaa';

  // طب عام
  if (id.includes('general') || id.includes('عام') || id.includes('هنادي'))
    return 'd_general';

  // تنظيف البشرة
  if (id.includes('clean')) return 'd_clean_pm';

  // ⚠️ لاحظ: أزلنا الـ if القديمة اللي ترجع دائمًا d_laser_pm
  // لو احتجت مستقبلاً تحويل أسماء عربية مثل "عيادة الليزر (فترة أولى)"
  // ممكن تضيف:
  // if (id.includes('الليزر') && id.includes('أولى')) return 'd_laser_am';
  // if (id.includes('الليزر') && id.includes('ثانية')) return 'd_laser_pm';

  // د. أحمد
  if (id.includes('ahmed') || id.includes('أحمد') || id.includes('احمد'))
    return 'd_ahmed_pm';

  // الافتراضي: نرجع النص كما هو
  return raw;
}



// كل إعدادات كل الدكاترة
export function getAllDoctorPeriods() {
  return readAll();
}

/**
 * إعدادات دكتور معيّن.
 * تدعم:
 *  - IDs مختلفة تتحوّل لـ ID ثابت عبر normalizeDoctorId
 *  - لاحقة _am / _pm
 *  - العكس: لو الكاش يطلب d_x والملف فيه d_x_am أو d_x_pm
 */
export function getDoctorPeriods(doctorId) {
  if (!doctorId) return [];

  const all = readAll();

  // 0) توحيد الـ ID أولاً
  const normalized = normalizeDoctorId(doctorId) || doctorId;

  // 1) الاسم كما هو بعد التوحيد
  if (all[normalized]) return all[normalized];

  // 2) شيل لاحقة _am / _pm وجرب
  const base = normalized.replace(/_(am|pm)$/i, '');
  if (all[base]) return all[base];

  // 3) العكس: لو عندنا d_x_am / d_x_pm والـ worker يطلب base
   // 3) لو عندنا d_x_am / d_x_pm والـ worker يطلب base (مثال: d_laser)
  const am = `${base}_am`;
  const pm = `${base}_pm`;

  const merged = [];
  if (all[am]) merged.push(...all[am]);
  if (all[pm]) merged.push(...all[pm]);
  if (merged.length) return merged;

  return [];
}





// حفظ إعدادات دكتور معيّن (تستخدمها لوحة الموظف كما هي)
export function setDoctorPeriods(doctorId, periods) {
  const all = readAll();

  // نخزّن بالـ ID الموحّد عشان ما يصير تكرار
  const key = normalizeDoctorId(doctorId) || doctorId;
  all[key] = periods;

  writeAll(all);
  return all[key];
}
