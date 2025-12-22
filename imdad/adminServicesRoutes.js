// server/imdad/adminServicesRoutes.js
// راوت بسيط لإدارة الخدمات (لوحة الموظف) — نسخة ESM

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// مسار ملف البيانات
const SERVICES_PATH = path.join(process.cwd(), 'server', 'data', 'services.json');

// قراءة الخدمات من الملف
function loadServices() {
  try {
    const raw = fs.readFileSync(SERVICES_PATH, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch (e) {
    // لو الملف مو موجود أو فيه مشكلة نرجّع مصفوفة فاضية
    return [];
  }
}

// حفظ الخدمات في الملف
function saveServices(services) {
  fs.writeFileSync(
    SERVICES_PATH,
    JSON.stringify(services, null, 2),
    'utf8'
  );
}

// ============= ENDPOINTS للوحة الموظف ============= //

// جلب كل الخدمات (للاستخدام في لوحة الموظف)
router.get('/admin/services', (req, res) => {
  const services = loadServices();
  res.json({ services });
});

// حفظ كل الخدمات (استقبال قائمة كاملة من الـ HTML)
router.post('/admin/services', (req, res) => {
  const body = req.body || {};
  const services = Array.isArray(body.services) ? body.services : [];

  // تنظيف بسيط
  const cleaned = services.map((s, idx) => ({
    id: s.id || `srv_${idx + 1}`,
    name: String(s.name || '').trim(),
    description: String(s.description || '').trim(),
    durationMinutes: Number(s.durationMinutes || 0) || 0,
    clinic: String(s.clinic || '').trim(),      // مثل derma / women / laser ...
    doctorIds: Array.isArray(s.doctorIds) ? s.doctorIds : [],
    imageUrl: String(s.imageUrl || '').trim(),
    enabled: s.enabled !== false,
    order: Number(s.order || idx + 1) || idx + 1,
  }));

  saveServices(cleaned);
  res.json({ ok: true, services: cleaned });
});

// ============= ENDPOINT عام للتطبيق (Flutter) ============= //

// جلب الخدمات للتطبيق (Flutter)
// مثال:  GET /api/services?clinic=derma
router.get('/services', (req, res) => {
  const { clinic, doctorId } = req.query;
  let services = loadServices().filter((s) => s.enabled !== false);

  if (clinic) {
    services = services.filter(
      (s) => String(s.clinic) === String(clinic)
    );
  }

  if (doctorId) {
    services = services.filter(
      (s) =>
        Array.isArray(s.doctorIds) &&
        s.doctorIds.includes(String(doctorId))
    );
  }

  res.json({ services });
});

export default router;
