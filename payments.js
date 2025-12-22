// server/payments.js
// جعل الدفع مجرد "تأكيد حجز" بدون أموال

export async function startPay(req, res) {
  // هنا تقدر تبقي منطق إنشاء الحجز/job لو كان موجود عندك
  // أو بس ترجع intent_id وهمي
  return res.json({
    ok: true,
    intent_id: "direct_booking",
  });
}

export async function confirmPay(req, res) {
  // هنا تقدر تستدعي منطق إنشاء job في إمـداد،
  // أو ترجع OK فقط لو حاب نكمل بعدها.
  return res.json({
    ok: true,
    confirmed: true,
  });
}
