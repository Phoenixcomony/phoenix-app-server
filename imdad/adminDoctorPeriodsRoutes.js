// server/imdad/adminDoctorPeriodsRoutes.js
import express from 'express';
import {
  getAllDoctorPeriods,
  getDoctorPeriods,
  setDoctorPeriods,
} from './doctorPeriodsStore.js';

const router = express.Router();

// رجّع كل الإعدادات
router.get('/admin/doctor-periods', (req, res) => {
  res.json(getAllDoctorPeriods());
});

// رجّع إعدادات دكتور معين
router.get('/admin/doctor-periods/:doctorId', (req, res) => {
  const doctorId = req.params.doctorId;
  res.json({
    doctorId,
    periods: getDoctorPeriods(doctorId),
  });
});
// ✅ API للـموبايل: يرجّع فترات دكتور معيّن للاستخدام في الفلتر
router.get('/api/doctor-periods/:doctorId', (req, res) => {
  const doctorId = req.params.doctorId;
  const periods = getDoctorPeriods(doctorId);
  res.json({
    doctorId,
    periods: periods || [],
  });
});


// حفظ إعدادات دكتور
router.post('/admin/doctor-periods/:doctorId', (req, res) => {
  const doctorId = req.params.doctorId;
  const periods = Array.isArray(req.body.periods) ? req.body.periods : [];
  const saved = setDoctorPeriods(doctorId, periods);

  res.json({
    doctorId,
    periods: saved,
  });
});

export default router;
