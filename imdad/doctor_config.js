// server/imdad/doctor_config.js
// فلترة المواعيد حسب إعدادات لوحة الموظف (doctor_periods.json)

import { getDoctorPeriods } from './doctorPeriodsStore.js';

/**
 * يحوّل "HH:MM" إلى دقائق من بداية اليوم
 */
function timeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const parts = hhmm.split(':');
  if (parts.length !== 2) return null;

  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  return h * 60 + m;
}

/**
 * ctx = {
 *   slotDoctorId: 'd_laser_am' | 'd_laser_pm' | 'd_laser_men_am' | ...
 *   serviceId:    'laser_women' | 'laser_men' | غيرها
 * }
 */
export function isSlotAllowedByConfig(ctx, isoDate, minutesFromMidnight) {
  const { slotDoctorId, serviceId } = ctx || {};

  /* =====================================================
     1) فلترة الليزر حسب نوع الخدمة (الحل الجذري)
     ===================================================== */
  if (serviceId === 'laser_women') {
    // ليزر نساء = ثلاث تعريفات فقط
    return ['d_laser_women_pm', 'd_laser_am', 'd_laser_pm']
      .includes(slotDoctorId);
  }

  if (serviceId === 'laser_men') {
    // ليزر رجال
    return slotDoctorId === 'd_laser_men_am';
  }

  /* =====================================================
     2) باقي العيادات → فلترة حسب فترات لوحة الموظف
     ===================================================== */
  if (!slotDoctorId || typeof minutesFromMidnight !== 'number') {
    return true;
  }

  // نجيب الفترات من ملف لوحة الموظف
  const periods = getDoctorPeriods(slotDoctorId);

  // لو ما فيه إعدادات → نسمح بكل شيء
  if (!periods || periods.length === 0) {
    return true;
  }

  // قراءة التاريخ
  let dateObj = null;
  if (isoDate && typeof isoDate === 'string') {
    const parts = isoDate.split('-'); // YYYY-MM-DD
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const d = parseInt(parts[2], 10);
      if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
        dateObj = new Date(y, m - 1, d);
      }
    }
  }

  if (!dateObj || Number.isNaN(dateObj.getTime())) {
    return true;
  }

  const isFriday = dateObj.getDay() === 5; // الجمعة

  // نمر على الفترات
  for (const p of periods) {
    if (!p || p.enabled === false) continue;
    if (isFriday && !p.allowFriday) continue;

    const fromM = timeToMinutes(p.from || '00:00');
    const toM   = timeToMinutes(p.to   || '23:59');
    if (fromM == null || toM == null) continue;

    if (minutesFromMidnight >= fromM && minutesFromMidnight <= toM) {
      return true;
    }
  }

  return false;
}
