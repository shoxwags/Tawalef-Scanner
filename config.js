// ============================================================
//  سكانر مستودع التوالف — الإعدادات
//  ده الملف الوحيد اللي محتاج تعدله.
// ============================================================

window.TW_CONFIG = {
  // من Supabase: Project Settings > API (أو زرار Connect).
  // "Project URL" مثلاً https://abcdefghijkl.supabase.co
  SUPABASE_URL: "https://ayokdkmkhgdiqfwtwufr.supabase.co",
  // مفتاح "anon" / "publishable". آمن إنه يتحط هنا، لأن قواعد قاعدة البيانات هي اللي بتحمي البيانات.
  // متحطش أبداً مفتاح "service_role" / "secret" هنا.
  SUPABASE_ANON_KEY: "sb_publishable_2ROz5M_M2b2tABsR2qcKaw_doMhLxA0",

  // الحساب المشترك اللي كل الموظفين بيدخلوا بيه (باسورد واحد للكل).
  // اعمله من Authentication > Users > Add user، وحط الإيميل هنا. الباسورد بتقوله للموظفين بس.
  SHARED_EMAIL: "team@tawalef.local",

  // سيبهم زي ما هم إلا لو غيرتهم في setup.sql.
  BUCKET: "tawalef-data",
  FILE: "products.csv",

  // الاسم اللي بيظهر فوق في التطبيق.
  APP_NAME: "مستودع التوالف",
};
