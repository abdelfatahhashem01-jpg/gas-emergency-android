import React, { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { apiRequest, authApi } from "./apiClient";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* ============================== ثوابت ============================== */

const ROLES = {
  super_admin: { label: "سوبر أدمن", icon: "👑" },
  manager: { label: "مدير", icon: "🛡️" },
  response: { label: "فريق الاستجابة", icon: "🚒" },
  observer: { label: "مراقب", icon: "👁️" },
  reporter: { label: "مُبلِّغ", icon: "📢" },
};

const INCIDENT_TYPES = [
  "تسرب غاز", "رائحة غاز قوية", "غاز ضعيف", "خط غاز مكسور", "انفجار غاز",
  "حريق ناتج عن غاز", "اشتباه في تسرب", "عطل عداد مسبق الدفع", "عبث عميل",
  "تأمين", "تسريب شبكة أرضية", "ماس كهربائي", "حريق", "عطل عداد ميكانيكي",
  "إعادة تشغيل", "انهيار عقار", "انفجار خط غاز 7 بار", "حريق منظم", "حادثة محطة غاز", "أخرى",
];

const SEVERITIES = [
  { id: "1", label: "أولى", color: "#D93025", bg: "#FDECEA", emoji: "🔴" },
  { id: "2", label: "ثانية", color: "#B76B00", bg: "#FFF3DE", emoji: "🟠" },
  { id: "3", label: "ثالثة", color: "#188038", bg: "#E6F4EA", emoji: "🟢" },
];

const STATUSES = [
  { id: "new", label: "جديد", color: "#1A73E8", bg: "#E8F0FE" },
  { id: "processing", label: "قيد المعالجة", color: "#B76B00", bg: "#FFF3DE" },
  { id: "done", label: "مكتمل", color: "#188038", bg: "#E6F4EA" },
];

const sevMeta = (id) => {
  const base = SEVERITIES.find((s) => s.id === id) || SEVERITIES[2];
  const override = dynamicSettings.severityIcons[id];
  return override ? { ...base, emoji: override } : base;
};
const statusMeta = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];

// إعدادات قابلة للتخصيص من صفحة "⚙️ الإعدادات" (اسم البرنامج، أيقونات الأدوار
// ودرجات الخطورة) — تُخزَّن في localStorage وتُقرأ من هنا في كل مكان بالتطبيق
// بدل تمريرها كخاصية (prop) عبر كل مكوّن على حدة.
// جهات تنبيهات الطوارئ عبر واتساب — قائمة قابلة للتعديل بالكامل (إضافة/حذف/
// تعديل)، وكل جهة لها: مسمّى (وظيفة أو اسم)، رقم واتساب، ووصف اختياري.
// "الرقم المختصر" لكل جهة هو موضعها في القائمة (١، ٢، ٣...) ويُحسب تلقائياً
// من ترتيب القائمة، فيُستخدم في نص رسالة واتساب بدل كتابة المسمى بالكامل.
const NOTIFY_ROLES = [
  "رئيس الشركة",
  "مساعد رئيس الشركة",
  "مدير عام مراقبة التشغيل",
  "مدير المنطقة",
  "مهندس العمليات",
];
function defaultWhatsappNumbers() {
  return NOTIFY_ROLES.map((role) => ({ role, phone: "", description: "" }));
}
function defaultAppSettings() {
  return { appName: "نظام طوارئ الغاز", roleIcons: {}, severityIcons: {}, whatsappNumbers: defaultWhatsappNumbers(), zoomLink: "", theme: { primary: "#a51d2d", primary2: "#741321", accent: "#c62828", bg: "#f6eeee", card: "#ffffff", shape: "rounded" } };
}
let dynamicSettings = defaultAppSettings();
// يهاجر أي شكل قديم (بحقل "name" بدل "role"، أو بدون "description") للشكل
// الحالي، مع الحفاظ على كل البيانات الموجودة فعلاً
function migrateWhatsappNumbers(list) {
  if (!Array.isArray(list) || list.length === 0) return defaultWhatsappNumbers();
  return list.map((n) => ({
    role: (n && (n.role || n.name)) || "",
    phone: (n && n.phone) || "",
    description: (n && n.description) || "",
  }));
}
function applyAppSettings(s) {
  dynamicSettings = {
    appName: (s && s.appName) || "نظام طوارئ الغاز",
    roleIcons: (s && s.roleIcons) || {},
    severityIcons: (s && s.severityIcons) || {},
    whatsappNumbers: migrateWhatsappNumbers(s && s.whatsappNumbers),
    zoomLink: (s && s.zoomLink) || "",
    theme: { ...(defaultAppSettings().theme), ...((s && s.theme) || {}) },
  };
}
function roleIcon(role) { return dynamicSettings.roleIcons[role] || ROLES[role]?.icon || ""; }
function currentAppName() { return dynamicSettings.appName; }

// يبني نص رسالة التنبيه لحادثة شديدة الخطورة — يتضمن رابط موقع الحادثة على
// الخريطة (لو متاح) ورابط اجتماع الطوارئ الثابت على Zoom (لو مضبوط في الإعدادات)
// وسطر "تم إبلاغ" بأكواد الوظائف المسجَّل لها رقم هاتف (بدل كتابة كل مسمى
// وظيفي بالكامل، للحفاظ على اختصار الرسالة)
function buildWhatsAppAlertMessage(report, regions) {
  const mapLink = regions ? reportMapLink(report, regions) : null;
  const notifiedCodes = (dynamicSettings.whatsappNumbers || [])
    .map((n, i) => ({ ...n, code: i + 1 }))
    .filter((n) => n.phone)
    .map((n) => n.code);
  let msg =
    `🚨 حالة طوارئ شديدة الخطورة\n` +
    `نوع الحادثة: ${report.incidentType}\n` +
    `اسم العميل: ${report.reporterName} - ${report.phone}\n` +
    `سجّل البلاغ: ${report.reportSenderName || report.createdBy || "—"}\n` +
    `العنوان: ${report.address || "—"}\n` +
    `رقم البلاغ: ${report.crn || "—"}\n`;
  if (mapLink) msg += `📍 موقع الحادثة: ${mapLink}\n`;
  if (dynamicSettings.zoomLink) msg += `🎥 اجتماع الطوارئ (Zoom): ${dynamicSettings.zoomLink}\n`;
  if (notifiedCodes.length > 0) msg += `✅ تم إبلاغ: ${notifiedCodes.join("، ")}\n`;
  msg += `يرجى المتابعة الفورية.`;
  return msg;
}

// يحاول الإرسال التلقائي الكامل عبر سيرفر الشركة (لو مزوَّد بنقطة /api/whatsapp
// متصلة بـ Meta WhatsApp Business API). يُرجع true لو نجح الإرسال التلقائي،
// و false لو غير متاح أو فشل — وقتها يظهر للمستخدم اختيار الأرقام يدوياً بدلاً
// من محاولة فتح كل الروابط تلقائياً (المتصفحات بتمنع فتح أكتر من نافذة واحدة
// تلقائياً في نفس الوقت، فالأفضل يختار المستخدم ويضغط "إرسال" بنفسه لكل رقم).
async function trySelfHostedWhatsApp(report, regions) {
  // Automated WhatsApp delivery is not configured on the server yet.
  return false;
}

// تحديد درجة الخطورة تلقائياً حسب نوع الحادثة — بدلاً من إدخالها يدوياً من
// المُبلِّغ. القيم اجتهادية حسب خطورة كل نوع ويمكن تعديلها لاحقاً حسب سياسة الشركة.
const INCIDENT_SEVERITY_MAP = {
  "تسرب غاز": "1", "رائحة غاز قوية": "1", "غاز ضعيف": "2", "خط غاز مكسور": "1",
  "انفجار غاز": "1", "حريق ناتج عن غاز": "1", "اشتباه في تسرب": "2",
  "عطل عداد مسبق الدفع": "3", "عبث عميل": "2", "تأمين": "3",
  "تسريب شبكة أرضية": "1", "ماس كهربائي": "2", "حريق": "1",
  "عطل عداد ميكانيكي": "3", "إعادة تشغيل": "3", "انهيار عقار": "1",
  "انفجار خط غاز 7 بار": "1", "حريق منظم": "1", "حادثة محطة غاز": "1", "أخرى": "2",
};
function autoSeverity(type) { return INCIDENT_SEVERITY_MAP[type] || "2"; }

// يحوّل الأرقام العربية الشرقية (٠-٩) — التي يرجعها التعرف الصوتي غالباً —
// إلى أرقام إنجليزية عادية، لأن باقي الكود (تحقق رقم الهاتف مثلاً) يتوقعها كذلك
function toLatinDigits(s) {
  return String(s || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}

// "مساعد تسجيل البلاغ بالصوت": يحاول توزيع نص مُتحدَّث كامل (اسم + هاتف +
// عنوان + نوع الحادثة في جملة واحدة متصلة) على حقول النموذج المناسبة تلقائياً،
// لتسريع تسجيل البلاغ وقت الطوارئ بدل الكتابة اليدوية لكل حقل على حدة.
// التحليل قائم على كلمات مفتاحية بسيطة (وليس ذكاءً اصطناعياً)، فقد لا يكون
// دقيقاً 100% دائماً — لذلك النص الكامل يُحفظ أيضاً في حقل "تفاصيل" كضمان
// لعدم ضياع أي معلومة، ويبقى بإمكان الموظف مراجعة وتعديل الحقول قبل الإرسال.
function parseVoiceReport(text) {
  const norm = toLatinDigits(text);
  const result = {};

  let matchedType = null;
  for (const t of INCIDENT_TYPES) {
    if (norm.includes(t) && (!matchedType || t.length > matchedType.length)) matchedType = t;
  }
  if (matchedType) result.incidentType = matchedType;

  const phoneMatch = norm.match(/\d{10,11}/);
  if (phoneMatch) result.phone = phoneMatch[0].slice(0, 11);

  const addrMatch = norm.match(/(?:العنوان|في شارع|في حي|في منطقة)\s*[:\-]?\s*(.+?)(?:$|،|\.|رقم|هاتف|اسم)/);
  if (addrMatch && addrMatch[1].trim()) result.address = addrMatch[1].trim();

  const nameMatch = norm.match(/(?:اسمي|اسم المبلغ|اسم العميل|الاسم)\s*[:\-]?\s*(.+?)(?:$|،|\.|رقم|هاتف|عنوان)/);
  if (nameMatch && nameMatch[1].trim()) result.reporterName = nameMatch[1].trim();

  return result;
}

// أنواع الحوادث اللي تستوجب تنبيه فوري عبر واتساب للسوبر أدمن ومجموعة
// المهندسين، بالإضافة للتصنيف التلقائي كدرجة "أولى"
const WHATSAPP_ALERT_TYPES = [
  "انفجار خط غاز 7 بار", "خط غاز مكسور", "انفجار غاز",
  "حريق", "حريق ناتج عن غاز", "حريق منظم", "حادثة محطة غاز",
];

// إجراءات خاصة بحالات معينة (بالإضافة للإجراءات القياسية العامة) — بتتحدد
// حسب نوع الحادثة نفسه، وبتظهر لفريق الاستجابة أول ما يبدأ معالجة البلاغ
const INCIDENT_SPECIFIC_PROCEDURES = {
  "انهيار عقار": [
    "الوصول الفوري لمكان البلاغ وعمل كردون أمني لعدم حدوث إصابات ولسهولة وسرعة التعامل مع الحالة",
    "ربط سكويز لعدم سريان الغاز حسب مسارات خطوط الغاز",
    "عمل حصر بحالات الوفيات والإصابات إن وجدت",
    "عمل حصر بأعداد العملاء الذين تم فصل الغاز عنهم",
  ],
  "حريق": [
    "فصل الغاز عن العقار من المحبس الرئيسي (الشاكوش) إذا استدعى الأمر ذلك",
    "في حالة امتداد الحريق للمبنى بالكامل، يتم تأمين المباني المجاورة",
    "بعد تأمين الحالة من قبل الدفاع المدني وانتهاء الحريق، يتم التحري قدر الإمكان عن أسباب الحريق وحصر خسائر الشركة مبدئياً (المواسير والخامات)",
    "عمل حصر بحالات الوفيات والإصابات إن وجدت",
    "عمل حصر بأعداد العملاء الذين تم فصل الغاز عنهم",
    "بعد إخماد الحريق من قبل الحماية المدنية، تتم معاينة العقار للتأكد من سلامة الوصلات وإعادة تشغيل الغاز للحالات التي لا يوجد بها أضرار بوصلات الغاز",
  ],
  "انفجار غاز": [
    "الوصول الفوري للموقع وعمل كردون أمني واسع طبقاً لمستوى الخطورة",
    "إيقاف الحركة المرورية بالموقع بالتنسيق مع الجهات المختصة",
    "قياس نسب الغاز وتحديد حدود منطقة الخطر",
    "إخلاء المواطنين والمنشآت الواقعة داخل نطاق التأثير",
    "منع جميع مصادر الاشتعال والأعمال بالموقع",
    "التنسيق مع غرفة العمليات لعزل الخط المتضرر",
  ],
};
// "حريق ناتج عن غاز" و"خط غاز مكسور" يشتركان في نفس إجراءات "حريق" و"انفجار غاز" على الترتيب
INCIDENT_SPECIFIC_PROCEDURES["حريق ناتج عن غاز"] = INCIDENT_SPECIFIC_PROCEDURES["حريق"];
INCIDENT_SPECIFIC_PROCEDURES["خط غاز مكسور"] = INCIDENT_SPECIFIC_PROCEDURES["انفجار غاز"];
INCIDENT_SPECIFIC_PROCEDURES["انفجار خط غاز 7 بار"] = INCIDENT_SPECIFIC_PROCEDURES["انفجار غاز"];
INCIDENT_SPECIFIC_PROCEDURES["حريق منظم"] = INCIDENT_SPECIFIC_PROCEDURES["حريق"];
INCIDENT_SPECIFIC_PROCEDURES["حادثة محطة غاز"] = INCIDENT_SPECIFIC_PROCEDURES["انفجار غاز"];

// الإجراءات القياسية ببطاقة غرفة العمليات (نموذج FP-36-01)
const OPS_ACTIONS = [
  { id: "confirmTenantPresence", label: "التأكد من العميل بأهمية التواجد بالشقة" },
  { id: "thankReporter", label: "توجيه الشكر للمُبلِّغ مع التأكد من اتخاذ اللازم" },
  { id: "confirmRepairAction", label: "التأكد بأنه سيتم اتخاذ اللازم لإصلاح الجهاز" },
  { id: "directToAuthorities", label: "توجيه المُبلِّغ للاتصال بالجهات المختصة" },
  { id: "closeApplianceValve", label: "إغلاق محبس الأجهزة" },
  { id: "closeMeterValve", label: "إغلاق محبس العداد" },
  { id: "openVents", label: "فتح منافذ التهوية" },
  { id: "noElectricSwitch", label: "لا تستخدم مفتاح كهرباء (فتح/غلق) وأطفئ مصادر اللهب" },
];
function emptyOpsCard() {
  return {
    workOrderNo: "", receivedBy: "", alertRecipient: "", reporterName: "",
    actions: {}, arrivalTime: "", endTime: "",
    workDetails: "", performedBy: "",
    review: { actionsMatch: "", priorityMatch: "", arrivalStandard: "", resolutionStandard: "", followUp: "" },
    shiftLeader: "", supervisor: "", engineer: "",
  };
}

function genCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => chars[b % chars.length]).join("");
}
function uid() {
  return crypto.randomUUID();
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString("ar-EG", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return ""; }
}
function fmtDuration(ms) {
  if (ms == null || ms < 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "أقل من دقيقة";
  if (mins < 60) return `${mins} دقيقة`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs} س ${rem} د` : `${hrs} ساعة`;
}
// يحوّل توقيت (ms) إلى صيغة تصلح لحقل <input type="datetime-local">
function toDatetimeLocal(ms) {
  try {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ""; }
}
// يحوّل عنوان نصي (مكتوب بدون GPS) لإحداثيات (خط عرض/طول) تلقائياً عبر خدمة
// Nominatim المجانية من OpenStreetMap (نفس مصدر الخريطة، بدون مفتاح API أو
// تكلفة) — بهذا يظهر أي بلاغ على "لوحة العمليات" فوراً بمجرد كتابة عنوانه،
// حتى لو ما كانش عنده موقع GPS مرفق فعلياً.
// يحوّل عنوان نصي (مكتوب بدون GPS) لإحداثيات (خط عرض/طول) عبر خدمة Nominatim
// المجانية من OpenStreetMap (نفس مصدر الخريطة، بدون مفتاح API أو تكلفة).
// يُرجع { ok, coords, reason } بدل قيمة صامتة، عشان أي فشل يكون واضحاً
// وقابلاً للتشخيص بدل ما يختفي بصمت.
async function geocodeAddress(address, regionName) {
  if (!address || !address.trim()) return { ok: false, coords: null, reason: "العنوان فارغ" };
  try {
    const q = encodeURIComponent(`${address}${regionName ? ", " + regionName : ""}, مصر`);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0&q=${q}`,
      { headers: { "Accept-Language": "ar" } }
    );
    if (!res.ok) return { ok: false, coords: null, reason: `فشل الاتصال بخدمة الخرائط (كود ${res.status})` };
    const data = await res.json();
    if (data && data[0]) {
      return { ok: true, coords: { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }, reason: null };
    }
    return { ok: false, coords: null, reason: "لم يتم التعرف على هذا العنوان — جرّب صياغة أوضح (شارع، حي، مدينة)" };
  } catch (e) {
    return { ok: false, coords: null, reason: "تعذّر الوصول لخدمة الخرائط (تحقق من الاتصال بالإنترنت)" };
  }
}
// صفارة إنذار قصيرة (٤ نغمات متبادلة) باستخدام Web Audio API مباشرة — بدون
// أي ملف صوت خارجي — تُشغَّل تلقائياً عند وصول بلاغ جديد شديد الخطورة، بنفس
// روح أجهزة إنذار غرف عمليات الطوارئ الحقيقية.
function playAlertSiren() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = (freq, start, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.02);
    };
    [0, 0.24, 0.48, 0.72].forEach((t, i) => beep(i % 2 === 0 ? 880 : 660, t, 0.2));
  } catch (e) { /* المتصفح لا يدعم Web Audio أو منع التشغيل التلقائي — تجاهل بأمان */ }
}
// ترتيب أولوية تلقائي: درجة الخطورة (أولى فأولى) ثم حالة المعالجة (الأحدث احتياجاً أولاً) ثم الأحدث زمنياً
const SEVERITY_RANK = { "1": 0, "2": 1, "3": 2 };
const STATUS_RANK = { new: 0, processing: 1, done: 2 };
function sortByPriority(list) {
  return [...list].sort((a, b) => {
    const sv = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (sv !== 0) return sv;
    const stt = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (stt !== 0) return stt;
    return b.createdAt - a.createdAt;
  });
}

/* ============================== تخزين ============================== */

// طبقة تخزين مستقلة بالكامل: تعتمد على localStorage الخاص بالمتصفح فقط،
// بدون أي استدعاء لأدوات Claude الخارجية. هذا يجعل التطبيق يعمل بشكل مستقل
// تماماً عند رفعه على أي استضافة خاصة بك (Vercel أو غيرها) دون أي اعتماد خارجي.
// ملاحظة: داخل معاينة Claude.ai نفسها قد يمنع الوضع الآمن (sandbox) الوصول لـ
// localStorage، فيتحول التطبيق تلقائياً لتخزين مؤقت بالذاكرة (لجلسة العرض هذه
// فقط) حتى لا يتعطل — لكن بعد رفع الملف على سيرفرك الخاص سيعمل التخزين الدائم
// بشكل طبيعي وكامل.
const memoryStore = {};

async function loadJSON(key, fallback) {
  let value;
  if (key === "gas_users") value = (await apiRequest("/users")).map((user) => ({ ...user, region: user.regionId || "" }));
  else if (key === "gas_regions") value = await apiRequest("/regions");
  else if (key === "gas_alerts") value = await apiRequest("/alerts");
  else if (key === "gas_settings") value = (await apiRequest("/settings")) || fallback;
  else if (key === "gas_reports") {
    value = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = await apiRequest(`/reports?${query.toString()}`);
      value.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
  } else return fallback;
  memoryStore[key] = value;
  return value;
}

async function saveJSON(key, value) {
  let persistedValue = value;
  if (key === "gas_settings") await apiRequest("/settings", { method: "PUT", body: value });
  else if (key === "gas_regions") {
    const prior = memoryStore.gas_regions || [];
    for (const region of value) {
      if (!prior.some((item) => item.id === region.id)) {
        const saved = await apiRequest("/regions", { method: "POST", body: region });
        region.id = saved.id;
      }
    }
  } else if (key === "gas_alerts") {
    const priorIds = new Set((memoryStore.gas_alerts || []).map((item) => item.id));
    if (!value.length && priorIds.size) await apiRequest("/alerts", { method: "DELETE", body: {} });
    else {
      const savedAlerts = new Map();
      for (const alert of value) {
        if (!priorIds.has(alert.id)) savedAlerts.set(alert.id, await apiRequest("/alerts", { method: "POST", body: alert }));
      }
      persistedValue = value.map((alert) => savedAlerts.get(alert.id) || alert);
    }
  } else if (key === "gas_reports") {
    const prior = memoryStore.gas_reports || [];
    const priorById = new Map(prior.map((item) => [item.id, item]));
    const nextById = new Map(value.map((item) => [item.id, item]));
    if (!value.length && prior.length) await apiRequest("/reports", { method: "DELETE", body: {} });
    else {
      const savedReports = new Map();
      for (const report of value) {
        const old = priorById.get(report.id);
        const extraData = {};
        const standard = new Set(["id", "crn", "incidentType", "severity", "status", "reporterName", "reporterPhone", "phone", "address", "subscriptionNumber", "subscriberNumber", "regionId", "region", "createdById", "assigneeId", "lat", "lng", "startedAt", "completedAt", "opsCard", "version", "createdAt", "updatedAt", "timeline"]);
        for (const [field, fieldValue] of Object.entries(report)) if (!standard.has(field)) extraData[field] = fieldValue;
        const body = { ...report, reporterPhone: report.phone ?? report.reporterPhone, subscriptionNumber: report.subscriptionNumber ?? report.subscriberNumber, regionId: report.regionId ?? report.region, extraData };
        if (!old) savedReports.set(report.id, await apiRequest("/reports", { method: "POST", body }));
        else {
          const oldComparable = { ...old }; const nextComparable = { ...report };
          delete oldComparable.version; delete nextComparable.version; delete oldComparable.updatedAt; delete nextComparable.updatedAt;
          if (JSON.stringify(oldComparable) === JSON.stringify(nextComparable)) continue;
          const timelineChanged = JSON.stringify(old.timeline || []) !== JSON.stringify(report.timeline || []);
          const event = timelineChanged ? report.timeline?.at(-1) : null;
          const saved = await apiRequest(`/reports/${report.id}`, { method: "PATCH", body: { ...body, expectedVersion: old.version || 1, eventType: event?.event, eventNote: event?.note } });
          savedReports.set(report.id, saved);
          if (!saved) continue;
        }
        if (old && !savedReports.has(report.id)) savedReports.set(report.id, old);
      }
      for (const old of prior) if (!nextById.has(old.id)) await apiRequest(`/reports/${old.id}`, { method: "DELETE" });
      persistedValue = value.map((report) => ({ ...report, ...(savedReports.get(report.id) || {}) }));
    }
  } else throw new Error(`الحفظ غير مدعوم لهذا النوع من البيانات: ${key}`);
  memoryStore[key] = persistedValue;
  return { persisted: true, error: null };
}

/* ============================== أنماط عامة ============================== */

// روابط خرائط جوجل — إما بإحداثيات دقيقة (موقع GPS) أو ببحث نصي (عنوان/منطقة)
function mapsLinkForCoords(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}
function mapsLinkForQuery(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
// روابط خريطة مُضمَّنة (iframe) داخل البرنامج نفسه بدل الاكتفاء برابط خارجي —
// بهذا يشوف فريق الاستجابة موقع الحالة على الخريطة مباشرة من داخل تفاصيل البلاغ
function mapsEmbedForCoords(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}&z=16&output=embed`;
}
function mapsEmbedForQuery(q) {
  return `https://www.google.com/maps?q=${encodeURIComponent(q)}&output=embed`;
}
// يطلب من المتصفح تحديد الموقع الحالي (GPS)، ويُرجع الإحداثيات إن وافق المستخدم
function captureLocation() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      return reject(new Error("المتصفح أو الجهاز لا يدعم تحديد الموقع"));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy, ts: Date.now(),
      }),
      (err) => {
        const messages = {
          1: "تم رفض إذن الوصول للموقع",
          2: "تعذّر تحديد الموقع الحالي",
          3: "انتهت مهلة تحديد الموقع",
        };
        reject(new Error(messages[err.code] || "تعذّر تحديد الموقع"));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

function themeCss(theme) {
  const t = { ...(defaultAppSettings().theme), ...(theme || {}) };
  const shape = t.shape || "rounded";
  const radii = {
    square: ["2px", "2px", "4px"],
    rounded: ["12px", "10px", "18px"],
    pill: ["999px", "999px", "22px"],
    hexagon: ["10px", "10px", "14px"],
  }[shape] || ["12px", "10px", "18px"];
  return {
    "--mg-primary": t.primary, "--mg-primary-2": t.primary2, "--mg-accent": t.accent,
    "--mg-bg": t.bg, "--mg-bg-soft": t.bg, "--mg-card": t.card,
    "--mg-radius": radii[0], "--mg-radius-sm": radii[1], "--mg-radius-lg": radii[2],
  };
}

function GlobalStyle() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      :root { --mg-primary:#a51d2d; --mg-primary-2:#741321; --mg-accent:#c62828; --mg-bg:#f8eeee; --mg-card:#fffdfd; --mg-text:#2b171a; --mg-muted:#725c60; --mg-line:#ead4d7; --mg-soft:#fff7f8; --mg-green:#0f9d58; --mg-amber:#d97706; --mg-blue:#2563eb; }
      @keyframes mgPulse { 0%,100% { box-shadow:0 0 0 0 rgba(198,40,40,.25) } 50% { box-shadow:0 0 0 8px rgba(198,40,40,0) } }
      @keyframes mgBannerFlash { 0%,100% { background:#b91c1c } 50% { background:#7f1d1d } }
      @keyframes mgShimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
      .mg-root { direction:rtl; font-family:'Segoe UI',Tahoma,Arial,sans-serif; background:linear-gradient(180deg,var(--mg-bg) 0%,var(--mg-bg-soft) 48%,var(--mg-bg) 100%); color:var(--mg-text); min-height:100vh; }
      .mg-shell { max-width:1440px; margin:0 auto; padding:18px; }
      .mg-btn { border:0; border-radius:var(--mg-radius); padding:10px 16px; font-size:14px; font-weight:700; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:7px; transition:transform .12s, box-shadow .18s, opacity .18s; }
      .mg-btn:hover { transform:translateY(-1px); box-shadow:0 5px 14px rgba(15,23,42,.10); }
      .mg-btn:active { transform:scale(.98); }
      .mg-theme-hexagon .mg-btn, .mg-theme-hexagon .mg-tab { clip-path:polygon(8% 0,92% 0,100% 50%,92% 100%,8% 100%,0 50%); border-radius:0; }
      .mg-theme-hexagon .mg-card, .mg-theme-hexagon .mg-stat { clip-path:polygon(3% 0,97% 0,100% 8%,100% 92%,97% 100%,3% 100%,0 92%,0 8%); border-radius:0; }
      .mg-btn:disabled { opacity:.5; cursor:not-allowed; transform:none; box-shadow:none; }
      .mg-btn-primary { background:linear-gradient(135deg,var(--mg-primary),var(--mg-primary-2)); color:#fff; }
      .mg-btn-outline { background:#fff; color:var(--mg-primary); border:1px solid #fecaca; }
      .mg-btn-ghost { background:#f1f5f9; color:#334155; }
      .mg-btn-sm { padding:7px 11px; font-size:12.5px; border-radius:var(--mg-radius-sm); }
      .mg-input,.mg-select,.mg-textarea { width:100%; border:1px solid #d7dee8; border-radius:var(--mg-radius); padding:11px 13px; font-size:14px; background:#fff; color:var(--mg-text); font-family:inherit; box-shadow:0 1px 2px rgba(15,23,42,.03); transition:border-color .15s, box-shadow .15s; }
      .mg-input:focus,.mg-select:focus,.mg-textarea:focus { outline:none; border-color:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,.10); }
      .mg-label { font-size:12.5px; font-weight:800; color:#475569; margin-bottom:7px; display:block; }
      .mg-card { background:rgba(255,255,255,.97); border-radius:var(--mg-radius-lg); padding:18px; box-shadow:0 8px 30px rgba(15,23,42,.06); border:1px solid rgba(226,232,240,.95); }
      .mg-header { background:linear-gradient(135deg,#741321 0%,#a51d2d 52%,#c62828 100%); color:#fff; padding:12px 18px; position:sticky; top:0; z-index:40; box-shadow:0 5px 22px rgba(127,29,29,.25); }
      .mg-header-inner { max-width:1440px; margin:0 auto; display:flex; align-items:center; justify-content:space-between; gap:16px; }
      .mg-brand { display:flex; align-items:center; gap:12px; min-width:0; }
      .mg-brand-logo { height:40px; min-width:68px; object-fit:contain; background:#fff; border-radius:10px; padding:4px 8px; }
      .mg-brand-title { font-weight:900; font-size:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .mg-brand-sub { font-size:11.5px; opacity:.9; margin-top:2px; }
      .mg-tabs { display:flex; gap:7px; overflow-x:auto; padding:9px max(18px,calc((100% - 1440px)/2 + 18px)); background:rgba(255,255,255,.94); border-bottom:1px solid #e5e7eb; position:sticky; top:64px; z-index:35; scrollbar-width:none; box-shadow:0 3px 14px rgba(15,23,42,.05); }
      .mg-tabs::-webkit-scrollbar { display:none; }
      .mg-tab { border:1px solid transparent; background:transparent; padding:9px 13px; border-radius:10px; font-size:13px; font-weight:800; color:#64748b; white-space:nowrap; cursor:pointer; }
      .mg-tab:hover { background:#f8fafc; color:#334155; }
      .mg-tab.active { background:#fff1f2; color:#b91c1c; border-color:#fecdd3; box-shadow:0 2px 8px rgba(185,28,28,.08); }
      .mg-page-title { font-size:24px; font-weight:900; margin:0; color:#0f172a; }
      .mg-page-sub { color:#64748b; font-size:13px; margin-top:5px; }
      .mg-section-head { display:flex; justify-content:space-between; align-items:end; gap:12px; margin-bottom:14px; flex-wrap:wrap; }
      .mg-stat { background:linear-gradient(180deg,#fff,#f8fafc); border-radius:16px; padding:16px; text-align:right; border:1px solid #e2e8f0; min-height:94px; box-shadow:0 5px 18px rgba(15,23,42,.04); }
      .mg-stat .num { font-size:28px; font-weight:900; color:#0f172a; line-height:1; }
      .mg-stat .lbl { font-size:12px; color:#64748b; margin-top:8px; font-weight:700; }
      .mg-stat-danger .num { color:#b91c1c; } .mg-stat-success .num { color:#047857; } .mg-stat-blue .num { color:#1d4ed8; } .mg-stat-amber .num { color:#b45309; }
      .mg-kpi-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
      .mg-dashboard-grid { display:grid; grid-template-columns:minmax(0,1.65fr) minmax(320px,.95fr); gap:14px; align-items:start; }
      .mg-two-col { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
      .mg-three-col { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
      .mg-report-row { background:#fff; border-radius:15px 15px 0 0; padding:15px; border:1px solid #e2e8f0; margin-bottom:0; cursor:pointer; transition:transform .12s, box-shadow .15s, border-color .15s; box-shadow:0 2px 8px rgba(15,23,42,.03); }
      .mg-report-row:hover { transform:translateY(-1px); box-shadow:0 8px 20px rgba(15,23,42,.07); border-color:#cbd5e1; }
      .mg-report-statusline { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
      .mg-sender-chip { display:inline-flex; align-items:center; gap:6px; padding:5px 10px; border-radius:999px; background:#f8fafc; border:1px solid #e2e8f0; color:#334155; font-size:12px; font-weight:700; }
      .mg-room-card { margin:0 0 12px; padding:13px; border:1px solid #dbe4ee; border-top:0; border-radius:0 0 15px 15px; background:linear-gradient(180deg,#f8fbff,#fff); box-shadow:0 5px 14px rgba(15,23,42,.035); }
      .mg-room-head { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
      .mg-room-title { display:flex; align-items:center; gap:8px; font-weight:800; color:#0f172a; }
      .mg-room-icon { width:32px; height:32px; border-radius:10px; display:inline-flex; align-items:center; justify-content:center; background:#e8f0fe; border:1px solid #c7d7f8; }
      .mg-room-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
      .mg-room-field { background:#fff; border:1px solid #e7edf4; border-radius:10px; padding:8px 10px; min-width:0; }
      .mg-room-field-label { display:block; font-size:10.5px; color:#94a3b8; margin-bottom:3px; }
      .mg-room-field-value { display:block; font-size:12.5px; color:#334155; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .mg-action-bar { display:flex; gap:7px; flex-wrap:wrap; margin-top:10px; }
      .mg-action-pill { border:1px solid #dbe4ee; background:#fff; color:#334155; border-radius:10px; padding:7px 10px; display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:800; cursor:pointer; transition:.15s; }
      .mg-action-pill:hover { transform:translateY(-1px); box-shadow:0 4px 10px rgba(15,23,42,.08); }
      .mg-action-pill.primary { background:#e8f0fe; border-color:#bfd2f7; color:#1a56db; }
      .mg-action-pill.success { background:#e6f4ea; border-color:#b8dfc2; color:#188038; }
      .mg-action-pill.danger { background:#fdecea; border-color:#f5b9b3; color:#b3261e; }
      @media(max-width:900px){ .mg-room-grid{grid-template-columns:repeat(2,minmax(0,1fr));} }
      @media(max-width:520px){ .mg-room-grid{grid-template-columns:1fr;} }
      .mg-report-meta { color:#64748b; font-size:12px; display:flex; flex-wrap:wrap; gap:10px; }
      .mg-badge { display:inline-flex; align-items:center; gap:4px; padding:4px 9px; border-radius:999px; font-size:11.5px; font-weight:800; }
      .mg-progress { height:8px; border-radius:999px; background:#e2e8f0; overflow:hidden; }
      .mg-progress > span { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,#ef4444,#b91c1c); }
      .mg-score { width:58px; height:58px; border-radius:50%; display:grid; place-items:center; font-size:17px; font-weight:900; border:6px solid #f1f5f9; }
      .mg-table { width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; border:1px solid #e2e8f0; border-radius:14px; }
      .mg-table th { background:#f8fafc; color:#475569; font-size:11.5px; text-align:right; padding:11px 10px; border-bottom:1px solid #e2e8f0; white-space:nowrap; }
      .mg-table td { padding:11px 10px; font-size:12.5px; border-bottom:1px solid #eef2f7; vertical-align:middle; }
      .mg-table tr:last-child td { border-bottom:0; }
      .mg-empty { text-align:center; padding:36px 20px; color:#64748b; }
      .mg-alert-card { border:1px solid #fecaca; background:linear-gradient(135deg,#fff7f7,#fff); border-radius:15px; padding:14px; }
      .mg-modal-overlay { position:fixed; inset:0; background:rgba(15,23,42,.62); backdrop-filter:blur(3px); display:flex; align-items:flex-end; justify-content:center; z-index:100; }
      @media (min-width:640px) { .mg-modal-overlay{align-items:center} }
      .mg-modal { background:#fff; border-radius:20px 20px 0 0; width:100%; max-width:720px; max-height:91vh; overflow-y:auto; padding:22px; box-shadow:0 24px 80px rgba(15,23,42,.28); }
      @media (min-width:640px){ .mg-modal{border-radius:20px} }
      .mg-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
      .mg-fab { position:fixed; bottom:20px; left:20px; z-index:30; border-radius:999px; padding:14px 20px; box-shadow:0 10px 28px rgba(185,28,28,.28); }
      .mg-live-dot { width:9px; height:9px; border-radius:50%; background:#22c55e; display:inline-block; box-shadow:0 0 0 4px rgba(34,197,94,.13); }
      .mg-side-list { display:flex; flex-direction:column; gap:8px; }
      .mg-side-item { padding:11px 12px; border:1px solid #e2e8f0; border-radius:12px; background:#fff; }
      .mg-chip-row { display:flex; flex-wrap:wrap; gap:7px; }
      .mg-chip { border:1px solid #e2e8f0; background:#f8fafc; border-radius:999px; padding:6px 10px; font-size:11.5px; font-weight:800; color:#475569; }
      ::placeholder { color:#94a3b8; }
      @media(max-width:1050px){ .mg-kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr));}.mg-dashboard-grid{grid-template-columns:1fr}.mg-three-col{grid-template-columns:repeat(2,minmax(0,1fr));} }
      @media(max-width:720px){ .mg-shell{padding:10px}.mg-header{padding:10px}.mg-tabs{top:60px;padding:8px 10px}.mg-kpi-grid,.mg-two-col,.mg-three-col,.mg-grid2{grid-template-columns:1fr}.mg-page-title{font-size:20px}.mg-brand-sub{display:none}.mg-brand-logo{height:34px}.mg-card{padding:14px}.mg-table{display:block;overflow-x:auto;white-space:nowrap}.mg-report-row{padding:12px}.mg-btn{padding:9px 12px} }
    `}</style>
  );
}

/* ============================== مكوّن نافذة عامة ============================== */

function Modal({ title, onClose, children }) {
  return (
    <div className="mg-modal-overlay" onClick={onClose}>
      <div className="mg-modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 17, color: "#241614" }}>{title}</h3>
          <button className="mg-btn mg-btn-ghost mg-btn-sm" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// زر تسجيل صوتي يحوّل الكلام لنص تلقائياً (Web Speech API المدمجة في المتصفح —
// بدون أي خدمة خارجية أو تكلفة إضافية). عند التوقف، يستدعي onResult بالنص
// المُتعرَّف عليه ليضيفه الاستدعاء الأب لحقل النص المناسب (تفاصيل البلاغ أو
// وصف الأعمال ببطاقة غرفة العمليات). يعمل بشكل موثوق على Google Chrome؛
// المتصفحات الأخرى قد لا تدعمه فيظهر تنبيه بسيط بدلاً من كسر الصفحة.
function VoiceInputButton({ onResult, disabled }) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);

  function toggle() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("متصفحك لا يدعم التعرف على الصوت. جرّب فتح البرنامج على Google Chrome.");
      return;
    }
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = "ar-EG";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = e.results?.[0]?.[0]?.transcript;
      if (text) onResult(text);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    try { rec.start(); setListening(true); } catch (e) { setListening(false); }
  }

  return (
    <button
      type="button" className="mg-btn mg-btn-sm" disabled={disabled}
      style={{ background: listening ? "#D93025" : "#F3E9E8", color: listening ? "#fff" : "#6B4B47" }}
      onClick={toggle}
    >
      {listening ? "⏹️ جارٍ الاستماع… إيقاف" : "🎙️ تسجيل صوتي"}
    </button>
  );
}

/* ============================== شاشة الإعداد الأولي ============================== */

function SetupScreen({ onDone }) {
  const [name, setName] = useState("");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    setErr("");
    if (!name.trim()) return setErr("أدخل اسم المسؤول");
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(loginId.trim())) return setErr("اسم الدخول: 3 أحرف على الأقل، إنجليزية أو أرقام");
    if (password.length < 12) return setErr("كلمة المرور يجب ألا تقل عن 12 حرفاً");
    if (password !== confirm) return setErr("كلمة المرور وتأكيدها غير متطابقين");
    if (!setupToken.trim()) return setErr("أدخل رمز التهيئة الذي أعدّه مسؤول الخادم");
    setSaving(true);
    try {
      const result = await authApi.setup({ name: name.trim(), loginId: loginId.trim(), password }, setupToken.trim());
      onDone(result.user);
    } catch (error) {
      setErr(error.status === 403 ? "رمز التهيئة غير صحيح أو سبق تهيئة الخادم" : error.message || "تعذر إنشاء الحساب");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mg-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <GlobalStyle />
      <div className="mg-card" style={{ maxWidth: 420, width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <img src="/logo.png" alt="MODERNGAS" style={{ height: 52, margin: "0 auto 10px", display: "block" }} />
          <h2 style={{ margin: "4px 0 2px" }}>الشركة الحديثة للغاز الطبيعي</h2>
        <div style={{ color: "#8A6C68", fontSize: 13.5 }}>تهيئة آمنة لأول تشغيل</div>
        </div>

        <label className="mg-label">اسم المسؤول *</label>
        <input className="mg-input" style={{ marginBottom: 12 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: محمد عبد المقصود" />

        <label className="mg-label">اسم الدخول *</label>
        <input className="mg-input" style={{ marginBottom: 12 }} value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="username" />
        <label className="mg-label">كلمة مرور قوية (12 حرفاً على الأقل) *</label>
        <input type="password" className="mg-input" style={{ marginBottom: 12 }} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <label className="mg-label">تأكيد كلمة المرور *</label>
        <input type="password" className="mg-input" style={{ marginBottom: 12 }} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        <label className="mg-label">رمز التهيئة من مسؤول الخادم *</label>
        <input type="password" className="mg-input" style={{ marginBottom: 14 }} value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" />

        {err && <div style={{ color: "#D93025", fontSize: 13, marginBottom: 10 }}>⚠️ {err}</div>}

        <button className="mg-btn mg-btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={saving} onClick={handleCreate}>
          {saving ? "جارٍ الإنشاء…" : "✅ إنشاء حساب السوبر أدمن"}
        </button>
      </div>
    </div>
  );
}

/* ============================== شاشة تسجيل الدخول ============================== */

function LoginScreen({ onLogin }) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleLogin() {
    setErr("");
    if (!loginId.trim() || !password) return setErr("أدخل اسم الدخول وكلمة المرور");
    setBusy(true);
    try { const result = await authApi.login(loginId.trim(), password); onLogin(result.user); }
    catch (error) { setErr(error.status === 429 ? "محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة." : "بيانات الدخول غير صحيحة أو تعذر الاتصال بالخادم"); }
    finally { setBusy(false); }
  }

  return (
    <div className="mg-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <GlobalStyle />
      <div className="mg-card" style={{ maxWidth: 380, width: "100%", textAlign: "center" }}>
        <img src="/logo.png" alt="MODERNGAS" style={{ height: 60, margin: "0 auto 12px", display: "block" }} />
        <h2 style={{ margin: "2px 0" }}>نظام طوارئ الغاز</h2>
        <div style={{ color: "#8A6C68", fontSize: 13.5, marginBottom: 4 }}>الشركة الحديثة للغاز الطبيعي</div>
        <div style={{ color: "#B79A96", fontSize: 12, marginBottom: 20 }}>إدارة الطوارئ والعمليات</div>

        <div style={{ textAlign: "right" }}>
          <label className="mg-label">اسم الدخول</label>
          <input
            className="mg-input" style={{ marginBottom: 12 }}
            value={loginId} onChange={(e) => setLoginId(e.target.value)}
            autoComplete="username"
          />
          <label className="mg-label">كلمة المرور</label>
          <input type="password" className="mg-input" style={{ marginBottom: 12 }} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleLogin()} autoComplete="current-password" />
        </div>
        {err && <div style={{ color: "#D93025", fontSize: 13, marginBottom: 10 }}>⚠️ {err}</div>}
        <button className="mg-btn mg-btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy} onClick={handleLogin}>
          {busy ? "جارٍ التحقق…" : "دخول ←"}
        </button>
      </div>
    </div>
  );
}

/* ============================== نموذج بلاغ جديد ============================== */

function IncidentForm({ currentUser, regions, onSubmitted }) {
  const empty = {
    reporterName: "", phone: "", subscriberNumber: "", incidentType: "",
    severity: "", details: "", region: regions[0]?.id || "",
    address: "", location: null,
  };
  const [form, setForm] = useState(empty);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [locStatus, setLocStatus] = useState("idle"); // idle | loading | done | error
  const [locErr, setLocErr] = useState("");
  const [lastCrn, setLastCrn] = useState("");
  const [waAlertReport, setWaAlertReport] = useState(null); // بلاغ حرِج يحتاج اختيار أرقام واتساب يدوياً
  const [dupWarning, setDupWarning] = useState(null); // بلاغات مشابهة محتملة قبل التأكيد النهائي

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  // اختيار نوع الحادثة يحدد درجة الخطورة تلقائياً — لا تدخل يدوي من المُبلِّغ
  function setIncidentType(t) { setForm((f) => ({ ...f, incidentType: t, severity: autoSeverity(t) })); }

  async function attachLocation() {
    setLocStatus("loading"); setLocErr("");
    try {
      const loc = await captureLocation();
      set("location", loc);
      setLocStatus("done");
    } catch (e) {
      setLocStatus("error");
      setLocErr(e.message || "تعذّر تحديد الموقع");
    }
  }

  async function submit() {
    setErr(""); setOk(false);
    if (!form.reporterName.trim()) return setErr("اسم العميل مطلوب");
    if (!/^\d{11}$/.test(form.phone.trim())) return setErr("رقم الهاتف يجب أن يكون 11 رقماً");
    if (!form.subscriberNumber.trim()) return setErr("رقم المشترك مطلوب");
    if (!form.incidentType) return setErr("اختر نوع الحادثة");

    // كشف البلاغات المكررة: نفس رقم الهاتف أو نفس العنوان، خلال آخر ساعة،
    // ولسه مفتوح (غير مُنجز) — تحذير قبل الإرسال بدل ازدواج تحرك الفرق
    const existing = await loadJSON("gas_reports", []);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const dups = existing.filter((r) =>
      r.status !== "done" && r.createdAt > oneHourAgo &&
      (r.phone === form.phone.trim() || (form.address.trim() && r.address && r.address.trim() === form.address.trim()))
    );
    if (dups.length > 0) { setDupWarning(dups); return; }
    await doSubmit();
  }

  async function doSubmit() {
    setDupWarning(null);
    setSaving(true);
    const reports = await loadJSON("gas_reports", []);
    // رقم مرجعي فريد للبلاغ (CRN) يسهّل البحث والمتابعة لاحقاً
    const crn = `MG-${new Date().getFullYear()}-${uid().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const report = {
      id: uid(), crn, ...form, status: "new", assignee: "", comments: "",
      createdBy: currentUser.name, reportSenderName: currentUser.name, createdAt: Date.now(),
      startedAt: null, completedAt: null, opsCard: { ...emptyOpsCard(), reportSenderName: currentUser.name, reporterName: form.reporterName.trim() },
      timeline: [{ ts: Date.now(), event: "تسجيل البلاغ", by: currentUser.name, note: "" }],
    };
    const next = [report, ...reports];
    await saveJSON("gas_reports", next);
    const alerts = await loadJSON("gas_alerts", []);
    const locNote = form.location ? " 📍 مع الموقع الجغرافي" : "";
    const urgentPrefix = form.severity === "1" ? "🚨 عاجل — " : "";
    await saveJSON("gas_alerts", [{ id: uid(), text: `${urgentPrefix}بلاغ جديد (${sevMeta(form.severity).label}) رقم ${crn} من العميل ${form.reporterName} — سجله ${currentUser.name}${locNote}`, ts: Date.now() }, ...alerts].slice(0, 100));
    // حوادث شديدة الخطورة (انفجار/كسر خط غاز/حريق/محطة غاز) تستوجب تنبيه فوري
    // عبر واتساب للسوبر أدمن ومجموعة المهندسين، بجانب التنبيه الداخلي بالأعلى.
    // نحاول أولاً الإرسال التلقائي الكامل عبر سيرفر الشركة (لو متاح)، وإلا
    // نعرض للمستخدم قائمة الأرقام ليختار ويرسل بنفسه (لتفادي منع المتصفح
    // لفتح عدة نوافذ واتساب تلقائياً في نفس الوقت).
    if (WHATSAPP_ALERT_TYPES.includes(form.incidentType)) {
      const sentAutomatically = await trySelfHostedWhatsApp(report, regions);
      if (!sentAutomatically) setWaAlertReport(report);
    }
    // تفاعل الخريطة مع العنوان: لو البلاغ عنده عنوان نصي بدون موقع GPS مرفق،
    // نحوّله لإحداثيات في الخلفية (بدون تأخير إرسال البلاغ) ليظهر تلقائياً
    // كنقطة على "لوحة العمليات" فور معرفة موقعه
    if (form.address.trim() && !form.location) {
      const regionName = regions.find((rg) => rg.id === form.region)?.name;
      geocodeAddress(form.address.trim(), regionName).then(async (result) => {
        if (!result.ok) return;
        const latest = await loadJSON("gas_reports", []);
        const updated = latest.map((x) => (x.id === report.id ? { ...x, geocoded: result.coords } : x));
        await saveJSON("gas_reports", updated);
      });
    }
    setSaving(false);
    setForm(empty);
    setLocStatus("idle"); setLocErr("");
    setLastCrn(crn);
    setOk(true);
    onSubmitted && onSubmitted(next);
    setTimeout(() => setOk(false), 5000);
  }

  function applyVoiceParse(text) {
    const parsed = parseVoiceReport(text);
    setForm((f) => ({
      ...f,
      reporterName: parsed.reporterName || f.reporterName,
      phone: parsed.phone || f.phone,
      address: parsed.address || f.address,
      incidentType: parsed.incidentType || f.incidentType,
      severity: parsed.incidentType ? autoSeverity(parsed.incidentType) : f.severity,
      details: f.details ? f.details + " " + text : text,
    }));
  }

  return (
    <div className="mg-card">
      <h3 style={{ marginTop: 0 }}>📋 تسجيل بلاغ جديد</h3>

      <div style={{ background: "#FDECEA", borderRadius: 12, padding: 12, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12.5, color: "#6B4B47" }}>
          🎙️ اتكلم وقول بيانات البلاغ (الاسم، الهاتف، العنوان، نوع الحادثة) في جملة واحدة، وهيتم تعبئة الحقول تلقائياً
        </div>
        <VoiceInputButton onResult={applyVoiceParse} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label className="mg-label" style={{ margin: 0 }}>اسم العميل *</label>
        <VoiceInputButton onResult={(text) => set("reporterName", text)} />
      </div>
      <input className="mg-input" style={{ marginBottom: 12 }} value={form.reporterName} onChange={(e) => set("reporterName", e.target.value)} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label className="mg-label" style={{ margin: 0 }}>رقم الهاتف * (11 رقم)</label>
        <VoiceInputButton onResult={(text) => set("phone", toLatinDigits(text).replace(/\D/g, "").slice(0, 11))} />
      </div>
      <input className="mg-input" style={{ marginBottom: 4 }} value={form.phone} onChange={(e) => set("phone", e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={11} />
      {form.phone && form.phone.length !== 11 && (
        <div style={{ color: "#B76B00", fontSize: 12, marginBottom: 8 }}>⚠️ رقم الهاتف ناقص — يجب إدخال 11 رقماً كاملاً</div>
      )}
      <div style={{ marginBottom: 12 }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label className="mg-label" style={{ margin: 0 }}>رقم المشترك *</label>
        <VoiceInputButton onResult={(text) => set("subscriberNumber", toLatinDigits(text))} />
      </div>
      <input className="mg-input" style={{ marginBottom: 12 }} value={form.subscriberNumber} onChange={(e) => set("subscriberNumber", e.target.value)} placeholder="**-**-**-**" />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label className="mg-label" style={{ margin: 0 }}>العنوان البريدي</label>
        <VoiceInputButton onResult={(text) => set("address", text)} />
      </div>
      <input className="mg-input" style={{ marginBottom: 8 }} value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="مثال: شارع..، حي..، المدينة" />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <button type="button" className="mg-btn mg-btn-outline mg-btn-sm" disabled={locStatus === "loading"} onClick={attachLocation}>
          {locStatus === "loading" ? "⏳ جارٍ تحديد الموقع…" : "📍 إرفاق موقعي الحالي"}
        </button>
        {locStatus === "done" && form.location && (
          <span style={{ fontSize: 12.5, color: "#188038" }}>
            ✅ تم إرفاق الموقع —{" "}
            <a href={mapsLinkForCoords(form.location.lat, form.location.lng)} target="_blank" rel="noreferrer" style={{ color: "#188038" }}>عرض على الخريطة</a>
          </span>
        )}
        {locStatus === "error" && <span style={{ fontSize: 12.5, color: "#D93025" }}>⚠️ {locErr}</span>}
      </div>

      <label className="mg-label">المنطقة</label>
      <select className="mg-select" style={{ marginBottom: 12 }} value={form.region} onChange={(e) => set("region", e.target.value)}>
        <option value="">— بدون تحديد —</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>

      <label className="mg-label">نوع الحادثة *</label>
      <select className="mg-select" style={{ marginBottom: 12 }} value={form.incidentType} onChange={(e) => setIncidentType(e.target.value)}>
        <option value="">— اختر —</option>
        {INCIDENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      {form.incidentType && (
        <div style={{ marginBottom: 12 }}>
          <label className="mg-label">درجة الخطورة (تُحدَّد تلقائياً حسب نوع الحادثة)</label>
          <span className="mg-badge" style={{ background: sevMeta(form.severity).bg, color: sevMeta(form.severity).color, fontSize: 14, padding: "8px 14px" }}>
            {sevMeta(form.severity).emoji} {sevMeta(form.severity).label}
          </span>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label className="mg-label" style={{ margin: 0 }}>تفاصيل</label>
        <VoiceInputButton onResult={(text) => set("details", form.details ? form.details + " " + text : text)} />
      </div>
      <textarea className="mg-textarea" style={{ marginBottom: 14, minHeight: 80 }} value={form.details} onChange={(e) => set("details", e.target.value)} />

      {err && <div style={{ color: "#D93025", fontSize: 13, marginBottom: 10 }}>⚠️ {err}</div>}
      {ok && <div style={{ color: "#188038", fontSize: 13, marginBottom: 10 }}>✅ تم إرسال البلاغ بنجاح — رقم المرجع: <strong style={{ fontFamily: "monospace" }}>{lastCrn}</strong></div>}

      <button className="mg-btn mg-btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={saving} onClick={submit}>
        {saving ? "جارٍ الإرسال…" : "📤 إرسال البلاغ"}
      </button>

      {waAlertReport && (
        <WhatsAppSendModal report={waAlertReport} regions={regions} onClose={() => setWaAlertReport(null)} />
      )}

      {dupWarning && (
        <Modal title="⚠️ بلاغ مشابه مسجَّل بالفعل" onClose={() => setDupWarning(null)}>
          <div style={{ fontSize: 13, color: "#B36B00", marginBottom: 12 }}>
            وُجد {dupWarning.length} بلاغ مشابه (نفس رقم الهاتف أو نفس العنوان) خلال الساعة الماضية ولسه غير مُنجز.
            تأكد إن ده مش نفس البلاغ قبل ما تكمل:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
            {dupWarning.map((r) => (
              <div key={r.id} style={{ background: "#FFF4E5", borderRadius: 8, padding: 10, fontSize: 12.5 }}>
                <div style={{ fontWeight: 700 }}>{r.crn} — {r.incidentType}</div>
                <div style={{ color: "#8A6C68" }}>{r.reporterName} · {r.phone} · {fmtTime(r.createdAt)}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="mg-btn mg-btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={doSubmit}>
              📤 تسجيل كبلاغ جديد منفصل
            </button>
            <button className="mg-btn mg-btn-outline" style={{ flex: 1, justifyContent: "center" }} onClick={() => setDupWarning(null)}>
              إلغاء
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ============================== نافذة إرسال تنبيه واتساب يدوياً ============================== */

// تعرض قائمة أرقام السوبر أدمن/المهندسين المسجّلة في الإعدادات، مع خانة اختيار
// لكل رقم وزر إرسال مستقل بجانبه — كل ضغطة تفتح واتساب لنفس الرقم فوراً كنتيجة
// مباشرة لتفاعل المستخدم، فلا يمنعها المتصفح (بعكس فتح عدة نوافذ تلقائياً دفعة واحدة)
function WhatsAppSendModal({ report, regions, onClose }) {
  const numbers = (dynamicSettings.whatsappNumbers || [])
    .map((n, i) => ({ ...n, code: i + 1 }))
    .filter((n) => n.phone);
  const [selected, setSelected] = useState(() => Object.fromEntries(numbers.map((n) => [n.code, true])));
  const [sentTo, setSentTo] = useState({});
  // نص الرسالة قابل للتعديل والإضافة قبل الإرسال — يبدأ بالنص المقترح تلقائياً
  const [message, setMessage] = useState(() => buildWhatsAppAlertMessage(report, regions));

  function toggle(code) { setSelected((s) => ({ ...s, [code]: !s[code] })); }
  function selectAll(v) { setSelected(Object.fromEntries(numbers.map((n) => [n.code, v]))); }
  function sendTo(n) {
    const digits = (n.phone || "").replace(/[^\d]/g, "");
    if (!digits) return;
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, "_blank");
    setSentTo((s) => ({ ...s, [n.code]: true }));
  }

  return (
    <Modal title="📱 إرسال تنبيه واتساب — حالة شديدة الخطورة" onClose={onClose}>
      <div style={{ fontSize: 13, color: "#D93025", fontWeight: 700, marginBottom: 10 }}>
        بلاغ {report.crn} — {report.incidentType}. اختر الأرقام المطلوب تنبيهها وادوس "إرسال" بجانب كل رقم.
      </div>

      <label className="mg-label">نص الرسالة (تقدر تعدّل أو تضيف أي شيء قبل الإرسال)</label>
      <textarea
        className="mg-textarea" style={{ minHeight: 130, marginBottom: 14, fontFamily: "inherit" }}
        value={message} onChange={(e) => setMessage(e.target.value)}
      />

      {dynamicSettings.zoomLink && (
        <button
          type="button" className="mg-btn mg-btn-sm"
          style={{ width: "100%", justifyContent: "center", background: "#2D8CFF", color: "#fff", marginBottom: 14 }}
          onClick={() => window.open(dynamicSettings.zoomLink, "_blank")}
        >
          🎥 بدء اجتماع الطوارئ على Zoom
        </button>
      )}

      {numbers.length === 0 ? (
        <div style={{ fontSize: 13, color: "#8A6C68" }}>
          لا يوجد أرقام واتساب مسجّلة. أضِفها من ⚙️ الإعدادات → أرقام واتساب تنبيهات الطوارئ.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button type="button" className="mg-btn mg-btn-ghost mg-btn-sm" onClick={() => selectAll(true)}>تحديد الكل</button>
            <button type="button" className="mg-btn mg-btn-ghost mg-btn-sm" onClick={() => selectAll(false)}>إلغاء التحديد</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {numbers.map((n) => (
              <div key={n.code} style={{ display: "flex", alignItems: "center", gap: 10, background: "#FBF0EF", borderRadius: 8, padding: "8px 10px" }}>
                <input type="checkbox" checked={!!selected[n.code]} onChange={() => toggle(n.code)} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    <span style={{ color: "#D93025", fontFamily: "monospace" }}>({n.code})</span> {n.role || "—"}
                  </div>
                  <div style={{ fontSize: 12, color: "#8A6C68", fontFamily: "monospace" }}>{n.phone}</div>
                  {n.description && <div style={{ fontSize: 11.5, color: "#8A6C68", marginTop: 2 }}>{n.description}</div>}
                </div>
                <button
                  type="button" className="mg-btn mg-btn-sm"
                  style={{ background: sentTo[n.code] ? "#188038" : "#25D366", color: "#fff" }}
                  disabled={!selected[n.code]}
                  onClick={() => sendTo(n)}
                >
                  {sentTo[n.code] ? "✅ أُرسل" : "📤 إرسال"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <button className="mg-btn mg-btn-outline" style={{ width: "100%", justifyContent: "center" }} onClick={onClose}>إغلاق</button>
    </Modal>
  );
}

/* ============================== قائمة البلاغات ============================== */

// أفضل رابط خريطة متاح للبلاغ: إحداثيات GPS دقيقة، فالعنوان اليدوي + اسم المنطقة،
// فإحداثيات مركز المنطقة، فاسم المنطقة فقط كبحث نصي
function reportMapLink(r, regions) {
  if (r.location) return mapsLinkForCoords(r.location.lat, r.location.lng);
  const region = regions.find((rg) => rg.id === r.region);
  if (r.address && r.address.trim()) {
    const q = region ? `${r.address} ${region.name}` : r.address;
    return mapsLinkForQuery(q);
  }
  if (region && region.lat != null && region.lng != null) return mapsLinkForCoords(region.lat, region.lng);
  if (region) return mapsLinkForQuery(region.name);
  return null;
}
// نفس منطق reportMapLink لكن يُرجع رابط خريطة "مُضمَّنة" (embed) لعرضها كإطار داخل التطبيق
function reportMapEmbedUrl(r, regions) {
  if (r.location) return mapsEmbedForCoords(r.location.lat, r.location.lng);
  const region = regions.find((rg) => rg.id === r.region);
  if (r.address && r.address.trim()) {
    const q = region ? `${r.address} ${region.name}` : r.address;
    return mapsEmbedForQuery(q);
  }
  if (region && region.lat != null && region.lng != null) return mapsEmbedForCoords(region.lat, region.lng);
  if (region) return mapsEmbedForQuery(region.name);
  return null;
}

function ReportsList({ reports, regions, currentUser, canEdit, onChanged }) {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(null);
  const [completing, setCompleting] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [safetyFor, setSafetyFor] = useState(null); // بلاغ "أولى" تم بدء معالجته حالاً — نعرض له إجراءات السلامة فوراً
  const [deleteTarget, setDeleteTarget] = useState(null); // بلاغ في انتظار تأكيد الحذف
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false); // تأكيد مسح كل البلاغات دفعة واحدة

  const visible = sortByPriority(
    reports.filter((r) => {
      if (currentUser.role === "reporter" && r.createdBy !== currentUser.name) return false;
      if (filter !== "all" && filter !== "sev1" && r.status !== filter) return false;
      if (filter === "sev1" && r.severity !== "1") return false;
      if (q.trim()) {
        const s = q.trim().toLowerCase();
        const haystack = [
          r.crn, r.reporterName, r.reportSenderName, r.createdBy, r.phone, r.subscriberNumber, r.address,
          r.incidentType, r.assignee, r.comments, r.details,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(s)) return false;
      }
      return true;
    })
  );

  async function logAlert(text) {
    const alerts = await loadJSON("gas_alerts", []);
    await saveJSON("gas_alerts", [{ id: uid(), text, ts: Date.now() }, ...alerts].slice(0, 100));
  }

  async function persist(next) {
    await saveJSON("gas_reports", next);
    onChanged(next);
  }

  // حذف بلاغ نهائياً — للسوبر أدمن فقط (مثلاً لتنظيف بلاغات تجريبية)، بعد
  // تأكيد صريح لأن الحذف لا يمكن التراجع عنه
  async function deleteReport(r) {
    const next = reports.filter((x) => x.id !== r.id);
    await persist(next);
    await logAlert(`🗑️ حذف ${currentUser.name} بلاغ ${r.crn || r.reporterName}`);
    setDeleteTarget(null);
    setSelected(null);
  }

  // مسح كل البلاغات دفعة واحدة (لتنظيف بيانات تجريبية قبل الاستخدام الفعلي) —
  // للسوبر أدمن فقط، وبعد تأكيد صريح لأن الحذف لا يمكن التراجع عنه
  async function deleteAllReports() {
    const count = reports.length;
    await persist([]);
    await logAlert(`🧹 مسح ${currentUser.name} كل البلاغات (${count} بلاغ)`);
    setDeleteAllConfirm(false);
  }

  // بدء المعالجة: يحوّل الحالة تلقائياً إلى "قيد المعالجة" ويسجّل وقت البدء
  // لحساب سرعة الاستجابة لاحقاً، ويربط البلاغ بالمستخدم الذي بدأ العمل عليه
  async function startProcessing(r) {
    const now = Date.now();
    const updated = {
      ...r, status: "processing", assignee: currentUser.name, startedAt: now,
      timeline: [...(r.timeline || []), { ts: now, event: "بدء المعالجة", by: currentUser.name, note: "" }],
    };
    const next = reports.map((x) => (x.id === r.id ? updated : x));
    await persist(next);
    await logAlert(`⚙️ بدأ ${currentUser.name} معالجة بلاغ ${r.crn || r.reporterName}`);
    // بلاغات درجة "أولى" (شديدة الخطورة): تُعرض إجراءات السلامة القياسية
    // فوراً أمام فريق الاستجابة عند بدء المعالجة، بدون الحاجة لفتح بطاقة العمليات
    if (r.severity === "1") setSafetyFor(updated);
  }

  // إكمال الحالة: يسجّل وقت الإنجاز، ويحفظ ملخص التقرير النهائي كتعليق،
  // وأيضاً يسجّله تلقائياً داخل بطاقة غرفة العمليات (وصف الأعمال + وقت
  // الوصول/الانتهاء) بدل ما يتطلب من فريق الاستجابة تعبئتها يدوياً مرة أخرى
  async function completeReport(r, note) {
    const now = Date.now();
    const card = r.opsCard || emptyOpsCard();
    const updatedCard = {
      ...card,
      workDetails: note ? (card.workDetails ? card.workDetails + "\n" + note : note) : card.workDetails,
      arrivalTime: card.arrivalTime || (r.startedAt ? toDatetimeLocal(r.startedAt) : card.arrivalTime),
      endTime: toDatetimeLocal(now),
    };
    const updated = {
      ...r, status: "done", completedAt: now,
      comments: note ? (r.comments ? r.comments + "\n" + note : note) : r.comments,
      opsCard: updatedCard,
      timeline: [...(r.timeline || []), { ts: now, event: "إنجاز الحالة", by: currentUser.name, note: note || "" }],
    };
    const next = reports.map((x) => (x.id === r.id ? updated : x));
    await persist(next);
    await logAlert(`✅ أنجز ${currentUser.name} بلاغ ${r.crn || r.reporterName}`);
    setCompleting(null);
  }

  return (
    <div>
      <div className="mg-card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input className="mg-input" placeholder="🔍 بحث برقم البلاغ (CRN) أو الاسم أو الهاتف أو العنوان..." value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="mg-btn mg-btn-outline mg-btn-sm" onClick={() => setExporting(true)}>📊 تصدير Excel</button>
          {currentUser.role === "super_admin" && reports.length > 0 && (
            <button className="mg-btn mg-btn-outline mg-btn-sm" style={{ color: "#D93025", borderColor: "#D93025" }} onClick={() => setDeleteAllConfirm(true)}>
              🧹 مسح الكل
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { id: "all", label: "📋 الكل" }, { id: "new", label: "🆕 جديد" },
            { id: "processing", label: "⚙️ معالجة" }, { id: "done", label: "✅ مكتمل" },
            { id: "sev1", label: "🔴 أولى" },
          ].map((f) => (
            <button
              key={f.id} className="mg-tab" style={{ background: filter === f.id ? "#D93025" : "#F3E9E8", color: filter === f.id ? "#fff" : "#6B4B47" }}
              onClick={() => setFilter(f.id)}
            >{f.label}</button>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: "#B79A96", marginTop: 8 }}>الترتيب تلقائي حسب درجة الخطورة ثم حالة المعالجة الأكثر إلحاحاً</div>
      </div>

      {visible.length === 0 && (
        <div className="mg-card" style={{ textAlign: "center", color: "#8A6C68" }}>لا توجد بلاغات مطابقة</div>
      )}

      {visible.map((r) => {
        const sv = sevMeta(r.severity), st = statusMeta(r.status);
        const urgent = r.severity === "1" && r.status !== "done";
        return (
          <React.Fragment key={r.id}>
            <div
              className="mg-report-row" onClick={() => setSelected(r)}
              style={urgent ? { borderRight: "4px solid #D93025", background: "#FFFBFA" } : undefined}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {urgent && <span>🚨</span>}
                    <span>{r.reporterName || "عميل غير مسجل"}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#D93025", background: "#FDECEA", borderRadius: 8, padding: "1px 7px", fontFamily: "monospace" }}>{r.crn}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "#8A6C68", marginTop: 2 }}>{r.incidentType} · {r.phone}</div>
                </div>
                <div className="mg-report-statusline">
                  <span className="mg-sender-chip">👤 مُرسل البلاغ: {r.reportSenderName || r.createdBy || "غير مسجل"}</span>
                  <span className="mg-badge" style={{ background: sv.bg, color: sv.color }}>{sv.emoji} {sv.label}</span>
                  <span className="mg-badge" style={{ background: st.bg, color: st.color }}>● {st.label}</span>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
                <div style={{ fontSize: 11.5, color: "#B79A96" }}>
                  {fmtTime(r.createdAt)}
                  {r.assignee && <span> · 👤 {r.assignee}</span>}
                  {r.startedAt && <span> · ⏱️ استجابة: {fmtDuration(r.startedAt - r.createdAt)}</span>}
                  {r.completedAt && <span> · إنجاز: {fmtDuration(r.completedAt - r.startedAt)}</span>}
                  {reportMapLink(r, regions) && (
                    <>
                      {" · "}
                      <a href={reportMapLink(r, regions)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "#1A73E8" }}>
                        📍 الموقع
                      </a>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="mg-room-card" onClick={(e) => e.stopPropagation()}>
              <div className="mg-room-head">
                <div className="mg-room-title"><span className="mg-room-icon">🗂️</span> بطاقة غرفة العمليات <span style={{ color: "#94a3b8", fontSize: 11 }}>FP-36-01</span></div>
                <span className="mg-badge" style={{ background: sv.bg, color: sv.color }}>{sv.emoji} {st.label}</span>
              </div>
              <div className="mg-room-grid">
                <div className="mg-room-field"><span className="mg-room-field-label">اسم مُرسل البلاغ</span><span className="mg-room-field-value">{r.reportSenderName || r.createdBy || r.opsCard?.reportSenderName || "غير مسجل"}</span></div>
                <div className="mg-room-field"><span className="mg-room-field-label">اسم العميل</span><span className="mg-room-field-value">{r.reporterName || "غير مسجل"}</span></div>
                <div className="mg-room-field"><span className="mg-room-field-label">متلقي البلاغ</span><span className="mg-room-field-value">{r.opsCard?.receivedBy || "—"}</span></div>
                <div className="mg-room-field"><span className="mg-room-field-label">مستلم الإخطار</span><span className="mg-room-field-value">{r.opsCard?.alertRecipient || "—"}</span></div>
                <div className="mg-room-field"><span className="mg-room-field-label">أمر شغل الطوارئ</span><span className="mg-room-field-value">{r.opsCard?.workOrderNo || "—"}</span></div>
                <div className="mg-room-field"><span className="mg-room-field-label">القائم بالعمل</span><span className="mg-room-field-value">{r.opsCard?.performedBy || r.assignee || "—"}</span></div>
                <div className="mg-room-field"><span className="mg-room-field-label">وقت الوصول</span><span className="mg-room-field-value">{r.opsCard?.arrivalTime ? fmtTime(new Date(r.opsCard.arrivalTime).getTime()) : "—"}</span></div>
                <div className="mg-room-field"><span className="mg-room-field-label">نهاية الحالة</span><span className="mg-room-field-value">{r.opsCard?.endTime ? fmtTime(new Date(r.opsCard.endTime).getTime()) : "—"}</span></div>
                <div className="mg-room-field"><span className="mg-room-field-label">الإجراءات المسجلة</span><span className="mg-room-field-value">{Object.values(r.opsCard?.actions || {}).filter(Boolean).length} إجراءات</span></div>
              </div>
              <div className="mg-action-bar">
                <button type="button" className="mg-action-pill primary" onClick={() => setSelected(r)}>👁️ فتح البلاغ</button>
                <button type="button" className="mg-action-pill" onClick={() => printOpsCard(r, r.opsCard || emptyOpsCard(), regions)}>🖨️ طباعة البطاقة</button>
                {canEdit && r.status === "new" && <button type="button" className="mg-action-pill primary" onClick={() => startProcessing(r)}>🚀 بدء المعالجة</button>}
                {canEdit && r.status === "processing" && <button type="button" className="mg-action-pill success" onClick={() => setCompleting(r)}>✅ إكمال الحالة</button>}
              </div>
            </div>
          </React.Fragment>
        );
      })}

      {selected && (
        <ReportDetailModal
          report={selected} regions={regions} canEdit={canEdit}
          isSuperAdmin={currentUser.role === "super_admin"}
          onClose={() => setSelected(null)}
          onDelete={(r) => setDeleteTarget(r)}
          onSave={async (updated) => {
            const withTimeline = {
              ...updated,
              reportSenderName: updated.reportSenderName || updated.createdBy || currentUser.name,
              opsCard: { ...emptyOpsCard(), ...(updated.opsCard || {}), reportSenderName: updated.reportSenderName || updated.createdBy || currentUser.name, reporterName: updated.reporterName || updated.opsCard?.reporterName || "" },
              timeline: [...(updated.timeline || []), { ts: Date.now(), event: "تعديل بيانات البلاغ", by: currentUser.name, note: "" }],
            };
            const next = reports.map((r) => (r.id === updated.id ? withTimeline : r));
            await persist(next);
            setSelected(null);
            // لو العنوان اتغيّر (بدون موقع GPS)، نعيد تحديد إحداثياته في
            // الخلفية عشان يتحرك تلقائياً على خريطة لوحة العمليات
            const original = reports.find((r) => r.id === updated.id);
            if (updated.address?.trim() && !updated.location && updated.address.trim() !== original?.address?.trim()) {
              const regionName = regions.find((rg) => rg.id === updated.region)?.name;
              geocodeAddress(updated.address.trim(), regionName).then(async (result) => {
                if (!result.ok) return;
                const latest = await loadJSON("gas_reports", []);
                const finalNext = latest.map((x) => (x.id === updated.id ? { ...x, geocoded: result.coords } : x));
                await saveJSON("gas_reports", finalNext);
                onChanged(finalNext);
              });
            }
          }}
        />
      )}

      {deleteTarget && (
        <Modal title="🗑️ تأكيد حذف البلاغ" onClose={() => setDeleteTarget(null)}>
          <div style={{ fontSize: 13.5, color: "#D93025", fontWeight: 700, marginBottom: 14 }}>
            هل أنت متأكد من حذف بلاغ <strong>{deleteTarget.crn}</strong> ({deleteTarget.reporterName})؟
            هذا الإجراء نهائي ولا يمكن التراجع عنه.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="mg-btn mg-btn-outline" style={{ flex: 1, justifyContent: "center" }} onClick={() => setDeleteTarget(null)}>إلغاء</button>
            <button className="mg-btn mg-btn-primary" style={{ flex: 1, justifyContent: "center", background: "#D93025" }} onClick={() => deleteReport(deleteTarget)}>
              🗑️ نعم، حذف نهائياً
            </button>
          </div>
        </Modal>
      )}

      {deleteAllConfirm && (
        <Modal title="🧹 تأكيد مسح كل البلاغات" onClose={() => setDeleteAllConfirm(false)}>
          <div style={{ fontSize: 13.5, color: "#D93025", fontWeight: 700, marginBottom: 14 }}>
            هل أنت متأكد من مسح <strong>كل البلاغات ({reports.length})</strong> نهائياً؟
            هذا الإجراء لا يمكن التراجع عنه إطلاقاً — يُنصح بتصدير نسخة Excel قبل المسح إذا احتجت الاحتفاظ بالبيانات.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="mg-btn mg-btn-outline" style={{ flex: 1, justifyContent: "center" }} onClick={() => setDeleteAllConfirm(false)}>إلغاء</button>
            <button className="mg-btn mg-btn-primary" style={{ flex: 1, justifyContent: "center", background: "#D93025" }} onClick={deleteAllReports}>
              🧹 نعم، مسح الكل نهائياً
            </button>
          </div>
        </Modal>
      )}

      {completing && (
        <Modal title="✅ إكمال الحالة وإرسال التقرير" onClose={() => setCompleting(null)}>
          <CompleteReportForm report={completing} onCancel={() => setCompleting(null)} onConfirm={(note) => completeReport(completing, note)} />
        </Modal>
      )}

      {safetyFor && (
        <Modal title="🚨 إجراءات التعامل مع الحالات شديدة الخطورة" onClose={() => setSafetyFor(null)}>
          <div style={{ fontSize: 13.5, color: "#D93025", fontWeight: 700, marginBottom: 12 }}>
            بلاغ <strong>{safetyFor.reporterName}</strong> ({safetyFor.crn}) — {safetyFor.incidentType} — درجة الخطورة: 🔴 أولى.
            يجب اتباع الإجراءات التالية فوراً قبل وأثناء التعامل مع الحالة:
          </div>
          {INCIDENT_SPECIFIC_PROCEDURES[safetyFor.incidentType] ? (
            <ol style={{ margin: "0 0 16px", paddingRight: 20, display: "flex", flexDirection: "column", gap: 8 }}>
              {INCIDENT_SPECIFIC_PROCEDURES[safetyFor.incidentType].map((step, i) => (
                <li key={i} style={{ fontSize: 13, color: "#6B4B47", background: "#FBF0EF", padding: "9px 12px", borderRadius: 8, listStyle: "none", display: "flex", gap: 8 }}>
                  <span style={{ fontWeight: 700, color: "#D93025" }}>{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
              {OPS_ACTIONS.map((a) => (
                <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#6B4B47", background: "#FBF0EF", padding: "9px 12px", borderRadius: 8 }}>
                  <span>⚠️</span><span>{a.label}</span>
                </div>
              ))}
            </div>
          )}
          <button className="mg-btn mg-btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => setSafetyFor(null)}>
            ✅ فهمت — بدء التنفيذ
          </button>
        </Modal>
      )}

      {exporting && (
        <ExportExcelModal reports={reports} regions={regions} onClose={() => setExporting(false)} />
      )}
    </div>
  );
}

// نافذة تصدير Excel — تسمح باختيار الفترة (يوم محدد / شهر محدد / سنة محددة / الكل)
// قبل توليد ملف .xlsx فعلي بكل بيانات البلاغات المطابقة للفترة
function ExportExcelModal({ reports, regions, onClose }) {
  const now = new Date();
  const [periodType, setPeriodType] = useState("all"); // all | day | month | year
  const [dayVal, setDayVal] = useState(now.toISOString().slice(0, 10));
  const [monthVal, setMonthVal] = useState(now.toISOString().slice(0, 7));
  const [yearVal, setYearVal] = useState(String(now.getFullYear()));

  function inPeriod(r) {
    if (periodType === "all") return true;
    const d = new Date(r.createdAt);
    if (periodType === "day") return d.toISOString().slice(0, 10) === dayVal;
    if (periodType === "month") return d.toISOString().slice(0, 7) === monthVal;
    if (periodType === "year") return String(d.getFullYear()) === yearVal;
    return true;
  }

  function doExport() {
    const rows = reports.filter(inPeriod).map((r) => ({
      "رقم البلاغ": r.crn || "",
      "اسم العميل": r.reporterName,
      "مُرسل البلاغ (المستخدم)": r.reportSenderName || r.createdBy || "",
      "الهاتف": r.phone,
      "رقم المشترك": r.subscriberNumber,
      "العنوان": r.address || "",
      "المنطقة": regions.find((rg) => rg.id === r.region)?.name || "",
      "نوع الحادثة": r.incidentType,
      "الخطورة": sevMeta(r.severity).label,
      "الحالة": statusMeta(r.status).label,
      "المسؤول": r.assignee || "",
      "تاريخ البلاغ": fmtTime(r.createdAt),
      "وقت الاستجابة": r.startedAt ? fmtDuration(r.startedAt - r.createdAt) : "",
      "وقت الإنجاز": r.completedAt && r.startedAt ? fmtDuration(r.completedAt - r.startedAt) : "",
      "رابط الموقع": reportMapLink(r, regions) || "",
      "التفاصيل": r.details || "",
      "التعليقات/التقرير النهائي": r.comments || "",
      "رقم أمر شغل الطوارئ": r.opsCard?.workOrderNo || "",
      "متلقي البلاغ": r.opsCard?.receivedBy || "",
      "القائم بالعمل": r.opsCard?.performedBy || "",
      "وصف الأعمال (بطاقة العمليات)": r.opsCard?.workDetails || "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "البلاغات");
    const label = periodType === "day" ? dayVal : periodType === "month" ? monthVal : periodType === "year" ? yearVal : "الكل";
    XLSX.writeFile(wb, `تقرير-البلاغات-${label}.xlsx`);
    onClose();
  }

  return (
    <Modal title="📊 تصدير تقرير Excel" onClose={onClose}>
      <label className="mg-label">الفترة</label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {[
          { id: "all", label: "الكل" }, { id: "day", label: "يوم محدد" },
          { id: "month", label: "شهر محدد" }, { id: "year", label: "سنة محددة" },
        ].map((p) => (
          <button
            key={p.id} type="button" className="mg-btn mg-btn-sm"
            style={{ background: periodType === p.id ? "#D93025" : "#F3E9E8", color: periodType === p.id ? "#fff" : "#6B4B47" }}
            onClick={() => setPeriodType(p.id)}
          >{p.label}</button>
        ))}
      </div>

      {periodType === "day" && (
        <>
          <label className="mg-label">اختر اليوم</label>
          <input type="date" className="mg-input" style={{ marginBottom: 14 }} value={dayVal} onChange={(e) => setDayVal(e.target.value)} />
        </>
      )}
      {periodType === "month" && (
        <>
          <label className="mg-label">اختر الشهر</label>
          <input type="month" className="mg-input" style={{ marginBottom: 14 }} value={monthVal} onChange={(e) => setMonthVal(e.target.value)} />
        </>
      )}
      {periodType === "year" && (
        <>
          <label className="mg-label">اختر السنة</label>
          <input type="number" className="mg-input" style={{ marginBottom: 14 }} value={yearVal} onChange={(e) => setYearVal(e.target.value)} />
        </>
      )}

      <button className="mg-btn mg-btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={doExport}>📥 تنزيل ملف Excel</button>
    </Modal>
  );
}

function CompleteReportForm({ report, onCancel, onConfirm }) {
  const [note, setNote] = useState("");
  return (
    <div>
      <div style={{ fontSize: 13.5, color: "#6B4B47", marginBottom: 10 }}>
        بلاغ <strong>{report.reporterName}</strong> ({report.crn}) — اكتب ملخص التقرير النهائي قبل تحويل الحالة إلى مكتمل.
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label className="mg-label" style={{ margin: 0 }}>ملخص التقرير النهائي</label>
        <VoiceInputButton onResult={(text) => setNote((n) => (n ? n + " " + text : text))} />
      </div>
      <textarea className="mg-textarea" style={{ marginBottom: 14, minHeight: 90 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="ما الذي تم تنفيذه لإغلاق البلاغ؟" />
      <div style={{ display: "flex", gap: 8 }}>
        <button className="mg-btn mg-btn-ghost" style={{ flex: 1, justifyContent: "center" }} onClick={onCancel}>إلغاء</button>
        <button className="mg-btn mg-btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => onConfirm(note)}>✅ إرسال التقرير وإكمال الحالة</button>
      </div>
    </div>
  );
}

function ReportDetailModal({ report, regions, canEdit, isSuperAdmin, onClose, onSave, onDelete }) {
  const [form, setForm] = useState({
    ...report,
    reportSenderName: report.reportSenderName || report.createdBy || "",
    opsCard: { ...emptyOpsCard(), ...(report.opsCard || {}), reportSenderName: report.reportSenderName || report.createdBy || report.opsCard?.reportSenderName || "", reporterName: report.opsCard?.reporterName || report.reporterName || "" },
  });
  const [opsOpen, setOpsOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  // اختيار نوع الحادثة يحدد درجة الخطورة تلقائياً من البرنامج نفسه — بدون تدخل يدوي
  function setIncidentType(t) { setForm((f) => ({ ...f, incidentType: t, severity: autoSeverity(t) })); }

  // تحديد يدوي لموقع البلاغ من العنوان المكتوب — بنتيجة واضحة فوراً (نجاح أو
  // سبب الفشل بالتحديد) بدل الاعتماد فقط على المحاولة الصامتة في الخلفية
  async function geocodeNow() {
    if (!form.address || !form.address.trim()) {
      alert("اكتب العنوان البريدي أولاً قبل تحديد الموقع.");
      return;
    }
    setGeocoding(true);
    const regionName = regions.find((rg) => rg.id === form.region)?.name;
    const result = await geocodeAddress(form.address.trim(), regionName);
    setGeocoding(false);
    if (result.ok) {
      set("geocoded", result.coords);
      alert(`✅ تم تحديد الموقع بنجاح (${result.coords.lat.toFixed(5)}, ${result.coords.lng.toFixed(5)}).\nاضغط "حفظ التعديلات" الآن ليظهر البلاغ على خريطة لوحة العمليات.`);
    } else {
      alert(`⚠️ تعذّر تحديد الموقع تلقائياً.\nالسبب: ${result.reason}\n\nجرّب عنوان أوضح (شارع، حي، مدينة)، أو استخدم "إرفاق موقعي الحالي" بدلاً من ذلك.`);
    }
  }
  return (
    <Modal title={`✏️ تفاصيل البلاغ — ${report.crn || ""}`} onClose={onClose}>
      <div className="mg-grid2" style={{ marginBottom: 10 }}>
        <div>
          <label className="mg-label">
            اسم العميل{" "}
            <span style={{ fontSize: 11, fontWeight: 700, color: "#D93025", background: "#FDECEA", borderRadius: 8, padding: "1px 7px", fontFamily: "monospace" }}>{form.crn}</span>
          </label>
          <input className="mg-input" disabled={!canEdit} value={form.reporterName} onChange={(e) => set("reporterName", e.target.value)} />
        </div>
        <div>
          <label className="mg-label">رقم الهاتف</label>
          <input className="mg-input" disabled={!canEdit} value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </div>
      </div>
      <label className="mg-label">رقم المشترك</label>
      <input className="mg-input" style={{ marginBottom: 10 }} disabled={!canEdit} value={form.subscriberNumber} onChange={(e) => set("subscriberNumber", e.target.value)} />

      <label className="mg-label">نوع الحادثة</label>
      <select className="mg-select" style={{ marginBottom: 10 }} disabled={!canEdit} value={form.incidentType} onChange={(e) => setIncidentType(e.target.value)}>
        {INCIDENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      <div className="mg-grid2" style={{ marginBottom: 10 }}>
        <div>
          <label className="mg-label">درجة الأولوية (تلقائي)</label>
          <div>
            <span className="mg-badge" style={{ background: sevMeta(form.severity).bg, color: sevMeta(form.severity).color, fontSize: 13.5, padding: "7px 12px" }}>
              {sevMeta(form.severity).emoji} {sevMeta(form.severity).label}
            </span>
          </div>
        </div>
        <div>
          <label className="mg-label">الحالة</label>
          <select className="mg-select" disabled={!canEdit} value={form.status} onChange={(e) => set("status", e.target.value)}>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
      </div>

      <label className="mg-label">المنطقة</label>
      <select className="mg-select" style={{ marginBottom: 10 }} disabled={!canEdit} value={form.region || ""} onChange={(e) => set("region", e.target.value)}>
        <option value="">— بدون تحديد —</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>

      <label className="mg-label">العنوان البريدي</label>
      <input className="mg-input" style={{ marginBottom: 8 }} disabled={!canEdit} value={form.address || ""} onChange={(e) => set("address", e.target.value)} />
      {canEdit && (
        <button
          type="button" className="mg-btn mg-btn-outline mg-btn-sm" disabled={geocoding}
          style={{ width: "100%", justifyContent: "center", marginBottom: 10 }}
          onClick={geocodeNow}
        >
          {geocoding ? "⏳ جارٍ التحديد…" : "📍 تحديد الموقع على لوحة العمليات من هذا العنوان"}
        </button>
      )}
      {reportMapEmbedUrl(form, regions) && (
        <div style={{ marginBottom: 6, borderRadius: 12, overflow: "hidden", border: "1px solid #F3E9E8" }}>
          <iframe
            title="موقع الحالة" width="100%" height="170" style={{ border: 0, display: "block" }}
            loading="lazy" src={reportMapEmbedUrl(form, regions)}
          />
        </div>
      )}
      {reportMapLink(form, regions) && (
        <div style={{ marginBottom: 10 }}>
          <a href={reportMapLink(form, regions)} target="_blank" rel="noreferrer" style={{ color: "#1A73E8", fontSize: 13 }}>
            🗺️ فتح الموقع في تطبيق خرائط جوجل
          </a>
          {form.location && <span style={{ fontSize: 11.5, color: "#8A6C68" }}> (بدقة ~{Math.round(form.location.accuracy || 0)} متر)</span>}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label className="mg-label" style={{ margin: 0 }}>تفاصيل</label>
        {canEdit && <VoiceInputButton onResult={(text) => set("details", form.details ? form.details + " " + text : text)} />}
      </div>
      <textarea className="mg-textarea" style={{ marginBottom: 10, minHeight: 70 }} disabled={!canEdit} value={form.details} onChange={(e) => set("details", e.target.value)} />

      <label className="mg-label">التعليقات</label>
      <textarea className="mg-textarea" style={{ marginBottom: 14, minHeight: 60 }} disabled={!canEdit} value={form.comments} onChange={(e) => set("comments", e.target.value)} />

      <div style={{ fontSize: 12, color: "#B79A96", marginBottom: 10 }}>
        سجّله: {form.createdBy} · {fmtTime(form.createdAt)}
        {form.assignee && <><br />المسؤول: {form.assignee}</>}
        {form.startedAt && <><br />⏱️ وقت الاستجابة: {fmtDuration(form.startedAt - form.createdAt)}</>}
        {form.completedAt && <><br />✅ وقت الإنجاز: {fmtDuration(form.completedAt - form.startedAt)}</>}
      </div>

      <button
        type="button" className="mg-btn mg-btn-ghost mg-btn-sm"
        style={{ width: "100%", justifyContent: "space-between", marginTop: 4, marginBottom: opsOpen ? 8 : 14 }}
        onClick={() => setOpsOpen((o) => !o)}
      >
        <span>🗂️ بطاقة غرفة عمليات (نموذج FP-36-01)</span><span>{opsOpen ? "▲" : "▼"}</span>
      </button>
      {opsOpen && (
        <div style={{ marginBottom: 14, paddingTop: 4, borderTop: "1px dashed #EBD9D6" }}>
          <button
            type="button" className="mg-btn mg-btn-outline mg-btn-sm"
            style={{ width: "100%", justifyContent: "center", marginBottom: 12 }}
            onClick={() => printOpsCard(form, form.opsCard, regions)}
          >🖨️ طباعة البطاقة</button>
          <OpsCardFields card={form.opsCard} canEdit={canEdit} onChange={(c) => set("opsCard", c)} />
        </div>
      )}

      <button
        type="button" className="mg-btn mg-btn-ghost mg-btn-sm"
        style={{ width: "100%", justifyContent: "space-between", marginBottom: timelineOpen ? 8 : 14 }}
        onClick={() => setTimelineOpen((o) => !o)}
      >
        <span>📜 السجل الزمني ({(form.timeline || []).length})</span><span>{timelineOpen ? "▲" : "▼"}</span>
      </button>
      {timelineOpen && (
        <div style={{ marginBottom: 14, paddingTop: 4, borderTop: "1px dashed #EBD9D6" }}>
          {(!form.timeline || form.timeline.length === 0) ? (
            <div style={{ fontSize: 12.5, color: "#8A6C68", textAlign: "center", padding: 10 }}>لا يوجد سجل مسجَّل لهذا البلاغ بعد</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...form.timeline].sort((a, b) => b.ts - a.ts).map((e, i) => {
                const icon = { "تسجيل البلاغ": "📝", "بدء المعالجة": "🚀", "إنجاز الحالة": "✅", "تعديل بيانات البلاغ": "✏️" }[e.event] || "•";
                return (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, background: "#FBF0EF", borderRadius: 8, padding: "8px 10px" }}>
                    <span>{icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>{e.event} — {e.by}</div>
                      <div style={{ color: "#8A6C68" }}>{fmtTime(e.ts)}{e.note ? ` · ${e.note}` : ""}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {canEdit ? (
        <button className="mg-btn mg-btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => onSave(form)}>💾 حفظ التعديلات (والبطاقة)</button>
      ) : (
        <div style={{ fontSize: 12.5, color: "#8A6C68", textAlign: "center" }}>عرض فقط — ليست لديك صلاحية التعديل</div>
      )}

      {isSuperAdmin && (
        <button
          type="button" className="mg-btn mg-btn-outline mg-btn-sm"
          style={{ width: "100%", justifyContent: "center", marginTop: 10, color: "#D93025", borderColor: "#D93025" }}
          onClick={() => onDelete(report)}
        >
          🗑️ حذف هذا البلاغ نهائياً
        </button>
      )}
    </Modal>
  );
}

/* ============================== بطاقة غرفة عمليات (FP-36-01) ============================== */

/* ============================== طباعة بطاقة غرفة العمليات ============================== */

// يبني صفحة HTML مستقلة بتنسيق قريب من نموذج FP-36-01 الورقي الأصلي، ويفتحها
// في نافذة جديدة ثم يستدعي أمر الطباعة مباشرة — لا حاجة لأي مكتبة خارجية.
function printOpsCard(report, card, regions) {
  const region = regions.find((r) => r.id === report.region);
  const sv = sevMeta(report.severity);
  const yn = (v) => (v ? escapeHtml(v) : "");
  const created = new Date(report.createdAt);
  const dayStr = created.toLocaleDateString("ar-EG", { weekday: "long" });
  const dateStr = created.toLocaleDateString("ar-EG");

  // ترتيب الإجراءات كما في النموذج الورقي الأصلي: عمود يمين لإجراءات
  // التواصل مع المُبلِّغ، وعمود يسار لإجراءات السلامة الفنية (المحابس والتهوية)
  const rightActions = OPS_ACTIONS.slice(0, 4);
  const leftActions = OPS_ACTIONS.slice(4, 8);
  const actionsRowsHtml = rightActions.map((ra, i) => {
    const la = leftActions[i];
    return `<tr>
      <td class="chkcell">${card.actions[ra.id] ? "☑" : "☐"}</td>
      <td class="chklabel">${escapeHtml(ra.label)}</td>
      <td class="chkcell">${card.actions[la.id] ? "☑" : "☐"}</td>
      <td class="chklabel">${escapeHtml(la.label)}</td>
    </tr>`;
  }).join("");

  const sevBox = (id, label) =>
    `<div class="sevbox ${report.severity === id ? "sevbox-on" : ""}">${report.severity === id ? "✓" : ""}<span>${label}</span></div>`;

  const html = `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<title>بطاقة غرفة عمليات — ${escapeHtml(report.crn || "")}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 22px; color: #111; direction: rtl; font-size: 12.5px; }
  .top { display: grid; grid-template-columns: 1fr 2fr 1fr; align-items: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 10px; }
  .top img { height: 46px; }
  .top .formid { font-size: 11px; color: #333; text-align: left; }
  .top h1 { font-size: 15px; margin: 0; text-align: center; }
  .top h2 { font-size: 11.5px; margin: 2px 0 0; text-align: center; font-weight: normal; }
  .region-line { text-align: right; font-size: 12px; margin-bottom: 8px; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  td, th { border: 1px solid #333; padding: 5px 8px; font-size: 12px; text-align: right; vertical-align: middle; }
  th { background: #f0f0f0; white-space: nowrap; font-weight: bold; width: 16%; }
  .full { width: 100%; }
  .grid-top { display: grid; grid-template-columns: 2fr 1fr; gap: 0; margin-bottom: 8px; }
  .grid-top table { margin-bottom: 0; }
  .sevwrap { border: 1px solid #333; border-right: none; padding: 6px; display: flex; flex-direction: column; gap: 6px; justify-content: center; }
  .sevbox { display: flex; align-items: center; justify-content: space-between; border: 1px solid #999; border-radius: 3px; padding: 3px 8px; font-size: 11.5px; }
  .sevbox-on { background: #ffe3e0; border-color: #D93025; font-weight: bold; }
  .section-title { background: #333; color: #fff; font-weight: bold; padding: 5px 10px; margin: 10px 0 6px; font-size: 12.5px; }
  .chkcell { width: 26px; text-align: center; font-size: 14px; }
  .chklabel { width: 40%; }
  .sig { display: flex; justify-content: space-between; margin-top: 24px; border-top: 1px solid #333; padding-top: 10px; }
  .sig div { text-align: center; font-size: 11.5px; width: 32%; }
  .sig .line { border-top: 1px solid #333; margin-top: 30px; padding-top: 4px; }
  .footer { display: flex; justify-content: space-between; font-size: 10.5px; color: #444; margin-top: 14px; border-top: 1px dashed #999; padding-top: 6px; }
  .no-print { text-align: center; margin-bottom: 14px; }
  .no-print button { padding: 10px 22px; font-size: 14px; background: #D93025; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
  @media print { .no-print { display: none; } body { padding: 8px; } }
</style>
</head>
<body>
  <div class="no-print"><button onclick="window.print()">🖨️ طباعة</button></div>

  <div class="top">
    <div class="formid">FP-36-01</div>
    <div>
      <h1>الشركة الحديثة للغاز الطبيعي</h1>
      <h2>الإدارة العامة للعمليات والطوارئ — بطاقة غرفة عمليات</h2>
    </div>
    <img src="/logo.png" alt="MODERNGAS" />
  </div>

  <div class="region-line">منطقة عمليات: ${escapeHtml(region?.name || "—")}</div>

  <table>
    <tr><th>اسم مُرسل البلاغ</th><td>${escapeHtml(report.reportSenderName || report.createdBy || "—")}</td><th>العنوان</th><td>${escapeHtml(report.address || "")}</td></tr>
    <tr><th>اسم العميل</th><td>${escapeHtml(report.reporterName)}</td><th>الرقم الكودي</th><td>${escapeHtml(report.crn || "")}</td></tr>
    <tr><th>تليفون العميل</th><td>${escapeHtml(report.phone)}</td><th>رقم البلاغ</th><td>${escapeHtml(report.crn || "")}</td></tr>
    <tr><th>موضوع البلاغ</th><td colspan="3">${escapeHtml(report.incidentType)}${report.details ? " — " + escapeHtml(report.details) : ""}</td></tr>
  </table>

  <div class="grid-top">
    <table>
      <tr><th>رقم أمر شغل الطوارئ</th><td>${yn(card.workOrderNo)}</td><th>وقت استلام البلاغ</th><td>${escapeHtml(fmtTime(report.createdAt))}</td></tr>
      <tr><th>متلقي البلاغ</th><td>${yn(card.receivedBy)}</td><th>وقت إرسال البلاغ</th><td></td></tr>
      <tr><th>مستلم الإخطار</th><td>${yn(card.alertRecipient)}</td><th>الزمن المستغرق للوصول</th><td>${report.startedAt ? escapeHtml(fmtDuration(report.startedAt - report.createdAt)) : ""}</td></tr>
      <tr><th>اليوم</th><td>${escapeHtml(dayStr)}</td><th>التاريخ</th><td>${escapeHtml(dateStr)}</td></tr>
    </table>
    <div class="sevwrap">
      ${sevBox("1", "أولى")}
      ${sevBox("2", "ثانية")}
      ${sevBox("3", "ثالثة")}
    </div>
  </div>

  <div class="section-title">ضع علامة (✓) على ما تم إنجازه</div>
  <table>${actionsRowsHtml}</table>

  <div class="section-title">تقرير الأعمال</div>
  <table>
    <tr><th>وقت الوصول</th><td>${yn(card.arrivalTime)}</td><th>وقت انتهاء الحالة</th><td>${yn(card.endTime)}</td></tr>
    <tr><th>تفاصيل الأعمال</th><td colspan="3" style="min-height:50px;">${escapeHtml(card.workDetails || "").replace(/\n/g, "<br/>")}</td></tr>
    <tr><th>القائم بالعمل / رقم الأداء</th><td colspan="3">${yn(card.performedBy)}</td></tr>
  </table>

  <div class="section-title">مراجعة الأعمال</div>
  <table>
    <tr><th>الإجراءات المتخذة للحالة</th><td>${yn(card.review.actionsMatch)}</td><th>درجة أولوية الحالة مطابقة</th><td>${yn(card.review.priorityMatch)}</td></tr>
    <tr><th>الوقت المستغرق للوصول قياسي</th><td>${yn(card.review.arrivalStandard)}</td><th>الوقت المستغرق لعلاج الحالة قياسي</th><td>${yn(card.review.resolutionStandard)}</td></tr>
    <tr><th>تعقيب</th><td colspan="3">${escapeHtml(card.review.followUp || "")}</td></tr>
  </table>

  <div class="sig">
    <div>الاسم: ${yn(card.shiftLeader)}<div class="line">رئيس الوردية</div></div>
    <div>الاسم: ${yn(card.supervisor)}<div class="line">مشرف الطوارئ</div></div>
    <div>الاسم: ${yn(card.engineer)}<div class="line">مهندس الطوارئ</div></div>
  </div>

  <div class="footer">
    <span>رقم الإصدار: 1</span>
    <span>تاريخ الإصدار: 2022/8</span>
  </div>
</body>
</html>`;

  const win = window.open("", "_blank", "width=850,height=950");
  if (!win) return alert("المتصفح منع فتح نافذة الطباعة — فعّل النوافذ المنبثقة لهذا الموقع وحاول مرة أخرى");
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => { try { win.print(); } catch (e) {} }, 400);
}

function OpsCardFields({ card, canEdit, onChange }) {
  function setField(k, v) { onChange({ ...card, [k]: v }); }
  function toggleAction(id) { onChange({ ...card, actions: { ...card.actions, [id]: !card.actions[id] } }); }
  function setReview(k, v) { onChange({ ...card, review: { ...card.review, [k]: v } }); }

  return (
    <div>
      <div className="mg-grid2" style={{ marginBottom: 10 }}>
        <div className="mg-room-field" style={{ borderColor: "#c62828", background: "#fff8f7" }}>
          <label className="mg-label" style={{ marginBottom: 5 }}>اسم مُرسل البلاغ (المستخدم المسجل)</label>
          <div className="mg-room-field-value">{card.reportSenderName || "سيظهر تلقائياً من المستخدم المسجل"}</div>
        </div>
        <div className="mg-room-field" style={{ borderColor: "#bfd2f7", background: "#f8fbff" }}>
          <label className="mg-label" style={{ marginBottom: 5 }}>اسم العميل</label>
          <div className="mg-room-field-value">{card.reporterName || "غير مسجل"}</div>
        </div>
      </div>
      <div className="mg-grid2" style={{ marginBottom: 10 }}>
        <div>
          <label className="mg-label">رقم أمر شغل الطوارئ</label>
          <input className="mg-input" disabled={!canEdit} value={card.workOrderNo} onChange={(e) => setField("workOrderNo", e.target.value)} />
        </div>
        <div>
          <label className="mg-label">متلقي البلاغ</label>
          <input className="mg-input" disabled={!canEdit} value={card.receivedBy} onChange={(e) => setField("receivedBy", e.target.value)} />
        </div>
      </div>

      <label className="mg-label">مستلم الإخطار</label>
      <input className="mg-input" style={{ marginBottom: 12 }} disabled={!canEdit} value={card.alertRecipient} onChange={(e) => setField("alertRecipient", e.target.value)} />

      <label className="mg-label" style={{ marginBottom: 8 }}>الإجراءات المتخذة قبل/عند الوصول</label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 14 }}>
        {OPS_ACTIONS.map((a) => (
          <label key={a.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: "#6B4B47" }}>
            <input type="checkbox" style={{ marginTop: 2 }} disabled={!canEdit} checked={!!card.actions[a.id]} onChange={() => toggleAction(a.id)} />
            <span>{a.label}</span>
          </label>
        ))}
      </div>

      <div style={{ fontWeight: 700, marginBottom: 8 }}>تقرير الأعمال</div>
      <div className="mg-grid2" style={{ marginBottom: 10 }}>
        <div>
          <label className="mg-label">وقت الوصول</label>
          <input type="datetime-local" className="mg-input" disabled={!canEdit} value={card.arrivalTime} onChange={(e) => setField("arrivalTime", e.target.value)} />
        </div>
        <div>
          <label className="mg-label">وقت انتهاء الحالة</label>
          <input type="datetime-local" className="mg-input" disabled={!canEdit} value={card.endTime} onChange={(e) => setField("endTime", e.target.value)} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <label className="mg-label" style={{ margin: 0 }}>وصف الأعمال المنفذة</label>
        {canEdit && <VoiceInputButton onResult={(text) => setField("workDetails", card.workDetails ? card.workDetails + " " + text : text)} />}
      </div>
      <textarea className="mg-textarea" style={{ marginBottom: 10, minHeight: 70 }} disabled={!canEdit} value={card.workDetails} onChange={(e) => setField("workDetails", e.target.value)} />

      <label className="mg-label">القائم بالعمل / رقم الأداء</label>
      <input className="mg-input" style={{ marginBottom: 16 }} disabled={!canEdit} value={card.performedBy} onChange={(e) => setField("performedBy", e.target.value)} />

      <div style={{ fontWeight: 700, marginBottom: 8 }}>مراجعة الأعمال</div>
      {[
        { k: "actionsMatch", label: "الإجراءات المتخذة مطابقة للحالة" },
        { k: "priorityMatch", label: "درجة أولوية الحالة مطابقة" },
        { k: "arrivalStandard", label: "الوقت المستغرق للوصول قياسي" },
        { k: "resolutionStandard", label: "الوقت المستغرق لعلاج الحالة قياسي" },
      ].map((q) => (
        <div key={q.k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
          <span style={{ fontSize: 12.5, color: "#6B4B47" }}>{q.label}</span>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {["نعم", "لا"].map((v) => (
              <button
                key={v} type="button" disabled={!canEdit} className="mg-btn mg-btn-sm"
                style={{ background: card.review[q.k] === v ? "#D93025" : "#F3E9E8", color: card.review[q.k] === v ? "#fff" : "#6B4B47" }}
                onClick={() => setReview(q.k, v)}
              >{v}</button>
            ))}
          </div>
        </div>
      ))}
      <label className="mg-label">تعقيب</label>
      <textarea className="mg-textarea" style={{ marginBottom: 14, minHeight: 50 }} disabled={!canEdit} value={card.review.followUp} onChange={(e) => setReview("followUp", e.target.value)} />

      <div className="mg-grid2" style={{ marginBottom: 10 }}>
        <div>
          <label className="mg-label">رئيس الوردية</label>
          <input className="mg-input" disabled={!canEdit} value={card.shiftLeader} onChange={(e) => setField("shiftLeader", e.target.value)} />
        </div>
        <div>
          <label className="mg-label">مشرف الطوارئ</label>
          <input className="mg-input" disabled={!canEdit} value={card.supervisor} onChange={(e) => setField("supervisor", e.target.value)} />
        </div>
      </div>
      <label className="mg-label">مهندس الطوارئ</label>
      <input className="mg-input" disabled={!canEdit} value={card.engineer} onChange={(e) => setField("engineer", e.target.value)} />
    </div>
  );
}

/* ============================== لوحة الإحصائيات ============================== */

// توزيع عدد البلاغات على مدار ساعات اليوم (00–23) — يساعد في تحديد أوقات الذروة
function computeHourlyDistribution(reports) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: `${String(h).padStart(2, "0")}:00`, عدد: 0 }));
  reports.forEach((r) => {
    const h = new Date(r.createdAt).getHours();
    buckets[h].عدد += 1;
  });
  return buckets;
}

function HourlyStatsChart({ reports }) {
  const data = computeHourlyDistribution(reports);
  if (reports.length === 0) {
    return <div style={{ color: "#8A6C68", fontSize: 14 }}>لا توجد بيانات كافية بعد</div>;
  }
  return (
    <div style={{ width: "100%", height: 220 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 6, right: 6, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F3E9E8" />
          <XAxis dataKey="hour" tick={{ fontSize: 10 }} interval={2} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
          <Tooltip />
          <Bar dataKey="عدد" fill="#D93025" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function StatsPanel({ reports }) {
  const total = reports.length;
  const byStatus = (id) => reports.filter((r) => r.status === id).length;
  const bySev = (id) => reports.filter((r) => r.severity === id).length;
  const done = byStatus("done");
  const pct = total ? Math.round((done / total) * 100) : 0;

  const cards = [
    { num: total, lbl: "إجمالي" },
    { num: bySev("1"), lbl: "درجة أولى" },
    { num: byStatus("processing"), lbl: "قيد المعالجة" },
    { num: done, lbl: "مكتمل" },
    { num: byStatus("new"), lbl: "جديد" },
    { num: bySev("2"), lbl: "درجة ثانية" },
    { num: bySev("3"), lbl: "درجة ثالثة" },
    { num: `${pct}%`, lbl: "نسبة الإنجاز" },
  ];

  return (
    <div className="mg-card">
      <h3 style={{ marginTop: 0 }}>📊 الإحصائيات</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {cards.map((c, i) => (
          <div key={i} className="mg-stat">
            <div className="num">{c.num}</div>
            <div className="lbl">{c.lbl}</div>
          </div>
        ))}
      </div>
      <h3 style={{ marginTop: 18, marginBottom: 6 }}>📈 عدد البلاغات حسب ساعة اليوم</h3>
      <HourlyStatsChart reports={reports} />
    </div>
  );
}

/* ============================== أداء المستخدمين (سرعة الاستجابة والإنجاز) ============================== */

// يُحسب لكل مستخدم أُسندت له بلاغات (بمجرد ضغطه "بدء المعالجة"):
// عدد البلاغات، نسبة الإنجاز، متوسط سرعة الاستجابة (من وقت البلاغ لبدء المعالجة)
// ومتوسط وقت الإنجاز (من بدء المعالجة للإكمال) — ومنها تقييم أداء مبسّط.
// عتبات التقييم (15 دقيقة / ساعة) قابلة للتعديل حسب سياسة الشركة.
const TECH_SLA_TARGETS = { "1": 15 * 60000, "2": 45 * 60000, "3": 120 * 60000 };

function performanceScore(m) {
  if (!m.assigned) return 0;
  const responseScore = m.avgResponse == null ? 60 : Math.min(100, (TECH_SLA_TARGETS[m.primarySeverity || "2"] / Math.max(m.avgResponse, 1)) * 100);
  const resolutionScore = m.avgResolution == null ? 60 : Math.min(100, (2 * 60 * 60000 / Math.max(m.avgResolution, 1)) * 100);
  const completionScore = m.completionRate;
  const slaScore = m.slaCount ? Math.round((m.slaMet / m.slaCount) * 100) : 60;
  return Math.round(responseScore * .35 + resolutionScore * .25 + completionScore * .20 + slaScore * .20);
}

function computeUserPerformance(reports) {
  const map = {};
  reports.forEach((r) => {
    if (!r.assignee) return;
    if (!map[r.assignee]) map[r.assignee] = { name:r.assignee, assigned:0, completed:0, responseSum:0, responseCount:0, resolutionSum:0, resolutionCount:0, slaCount:0, slaMet:0, severityCounts:{"1":0,"2":0,"3":0} };
    const m = map[r.assignee];
    m.assigned += 1;
    m.severityCounts[r.severity] = (m.severityCounts[r.severity] || 0) + 1;
    if (r.startedAt) {
      const response = r.startedAt - r.createdAt;
      m.responseSum += response; m.responseCount += 1;
      const target = TECH_SLA_TARGETS[r.severity] || TECH_SLA_TARGETS["2"];
      m.slaCount += 1; if (response <= target) m.slaMet += 1;
    }
    if (r.status === "done") m.completed += 1;
    if (r.completedAt && r.startedAt) { m.resolutionSum += (r.completedAt-r.startedAt); m.resolutionCount += 1; }
  });
  return Object.values(map).map((m) => {
    const avgResponse=m.responseCount?m.responseSum/m.responseCount:null;
    const avgResolution=m.resolutionCount?m.resolutionSum/m.resolutionCount:null;
    const completionRate=m.assigned?Math.round(m.completed/m.assigned*100):0;
    const primarySeverity=Object.entries(m.severityCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || "2";
    const score=performanceScore({...m,avgResponse,avgResolution,completionRate,primarySeverity});
    const rating=score>=90?"متميز":score>=80?"قوي":score>=70?"مستقر":"يحتاج متابعة";
    const ratingColor=score>=90?"#047857":score>=80?"#2563eb":score>=70?"#b45309":"#b91c1c";
    return {...m,avgResponse,avgResolution,completionRate,score,rating,ratingColor,slaRate:m.slaCount?Math.round(m.slaMet/m.slaCount*100):0};
  }).sort((a,b)=>b.score-a.score || b.assigned-a.assigned);
}

function UserPerformancePanel({ reports }) {
  const rows=computeUserPerformance(reports);
  return <div className="mg-card" style={{marginTop:14}}>
    <div className="mg-section-head"><div><h3 style={{margin:0}}>👨‍🔧 تقييم أداء فنيي الاستجابة</h3><div className="mg-page-sub">درجة تشغيلية من 100 تعتمد على سرعة الاستجابة، زمن الإنجاز، الالتزام بزمن الاستجابة، ونسبة إغلاق الحالات.</div></div></div>
    {rows.length===0 ? <div className="mg-empty">لا توجد حالات مُسندة بعد.</div> : <div style={{display:"grid",gap:10}}>{rows.map(u=><div key={u.name} style={{display:"grid",gridTemplateColumns:"70px minmax(150px,1fr) repeat(4,minmax(90px,1fr))",gap:12,alignItems:"center",padding:"13px 0",borderBottom:"1px solid #eef2f7"}}>
      <div className="mg-score" style={{color:u.ratingColor}}>{u.score}</div>
      <div><div style={{fontWeight:900}}>{u.name}</div><div style={{fontSize:11.5,color:"#64748b",marginTop:4}}>{u.rating} · {u.assigned} بلاغ</div><div className="mg-progress" style={{marginTop:7}}><span style={{width:`${u.score}%`,background:u.score>=90?"linear-gradient(90deg,#10b981,#047857)":u.score>=80?"linear-gradient(90deg,#60a5fa,#2563eb)":"linear-gradient(90deg,#f59e0b,#b91c1c)"}}/></div></div>
      <div><div style={{fontSize:11,color:"#64748b"}}>الاستجابة</div><b>{u.avgResponse!=null?fmtDuration(u.avgResponse):"—"}</b></div>
      <div><div style={{fontSize:11,color:"#64748b"}}>الإنجاز</div><b>{u.avgResolution!=null?fmtDuration(u.avgResolution):"—"}</b></div>
      <div><div style={{fontSize:11,color:"#64748b"}}>SLA</div><b>{u.slaRate}%</b></div>
      <div><div style={{fontSize:11,color:"#64748b"}}>إغلاق</div><b>{u.completionRate}%</b></div>
    </div>)}</div>}
  </div>;
}

/* ============================== إدارة المناطق ============================== */

function RegionsManager({ regions, onChanged }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [err, setErr] = useState("");

  async function create() {
    setErr("");
    if (!name.trim() || !code.trim()) return setErr("أدخل اسم المنطقة والكود");
    if ((lat && !lng) || (!lat && lng)) return setErr("أدخل خط الطول والعرض معاً أو اتركهما فارغين");
    const region = {
      id: uid(), name: name.trim(), code: code.trim().toUpperCase(),
      lat: lat ? parseFloat(lat) : null, lng: lng ? parseFloat(lng) : null,
    };
    const next = [...regions, region];
    await saveJSON("gas_regions", next);
    onChanged(next);
    setName(""); setCode(""); setLat(""); setLng(""); setOpen(false);
  }

  return (
    <div className="mg-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>🗺️ إدارة المناطق</h3>
        <button className="mg-btn mg-btn-primary mg-btn-sm" onClick={() => setOpen(true)}>➕ منطقة جديدة</button>
      </div>
      {regions.length === 0 && <div style={{ color: "#8A6C68", fontSize: 14 }}>لا توجد مناطق مضافة بعد</div>}
      {regions.map((r) => (
        <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #F3E9E8" }}>
          <span>{r.name}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <a
              href={r.lat != null && r.lng != null ? mapsLinkForCoords(r.lat, r.lng) : mapsLinkForQuery(r.name)}
              target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: "#1A73E8" }}
            >🗺️ خريطة المنطقة</a>
            <span style={{ color: "#8A6C68", fontFamily: "monospace" }}>{r.code}</span>
          </div>
        </div>
      ))}
      {open && (
        <Modal title="🗺️ إضافة منطقة جديدة" onClose={() => setOpen(false)}>
          <label className="mg-label">اسم المنطقة *</label>
          <input className="mg-input" style={{ marginBottom: 12 }} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="mg-label">كود المنطقة (بالإنجليزية) *</label>
          <input className="mg-input" style={{ marginBottom: 12 }} value={code} onChange={(e) => setCode(e.target.value)} />
          <label className="mg-label">إحداثيات مركز المنطقة (اختياري)</label>
          <div className="mg-grid2" style={{ marginBottom: 8 }}>
            <input className="mg-input" placeholder="خط العرض Lat" value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" />
            <input className="mg-input" placeholder="خط الطول Lng" value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" />
          </div>
          <div style={{ fontSize: 11.5, color: "#8A6C68", marginBottom: 12 }}>لو تُركت فارغة، سيتم البحث عن المنطقة بالاسم مباشرة على الخريطة</div>
          {err && <div style={{ color: "#D93025", fontSize: 13, marginBottom: 10 }}>⚠️ {err}</div>}
          <button className="mg-btn mg-btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={create}>✅ إنشاء المنطقة</button>
        </Modal>
      )}
    </div>
  );
}

/* ============================== إدارة المستخدمين ============================== */

function UsersManager({ users, regions, onChanged }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("response");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState("");
  const [err, setErr] = useState("");

  async function create() {
    setErr("");
    if (!name.trim()) return setErr("أدخل اسم المستخدم");
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(loginId.trim())) return setErr("اسم الدخول يجب أن يكون 3 أحرف إنجليزية أو أكثر");
    if (password.length < 12) return setErr("كلمة المرور لا تقل عن 12 حرفاً");
    if (users.some((u) => u.loginId === loginId.trim())) return setErr("اسم الدخول مستخدم بالفعل");
    try {
    const created = await apiRequest("/users", { method: "POST", body: { name: name.trim(), loginId: loginId.trim(), password, role, regionId: region || null } });
    const next = [...users, { ...created, region: created.regionId || "" }];
    onChanged(next);
    setName(""); setLoginId(""); setPassword(""); setRole("response"); setRegion(""); setOpen(false);
    } catch (error) { setErr(error.message || "تعذر إنشاء المستخدم"); }
  }

  return (
    <div className="mg-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>إدارة المستخدمين</h3>
        <button className="mg-btn mg-btn-primary mg-btn-sm" onClick={() => setOpen(true)}>➕ إضافة</button>
      </div>
      {users.map((u) => (
        <div key={u.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #F3E9E8" }}>
          <div>
            <div style={{ fontWeight: 600 }}>{ROLES[u.role]?.icon} {u.name}</div>
            <div style={{ fontSize: 12, color: "#8A6C68" }}>{ROLES[u.role]?.label}{u.region ? " · " + (regions.find((r) => r.id === u.region)?.name || "") : ""}</div>
          </div>
          <span style={{ fontFamily: "monospace", color: "#8A6C68" }}>{u.loginId}</span>
        </div>
      ))}
      {open && (
        <Modal title="➕ إضافة مستخدم" onClose={() => setOpen(false)}>
          <label className="mg-label">الاسم *</label>
          <input className="mg-input" style={{ marginBottom: 12 }} value={name} onChange={(e) => setName(e.target.value)} />

          <label className="mg-label">الدور *</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {Object.entries(ROLES).map(([id, r]) => (
              <button key={id} type="button" className="mg-btn mg-btn-sm"
                style={{ background: role === id ? "#D93025" : "#F3E9E8", color: role === id ? "#fff" : "#6B4B47" }}
                onClick={() => setRole(id)}>
                {r.icon} {r.label}
              </button>
            ))}
          </div>

          <label className="mg-label">اسم الدخول *</label>
          <input className="mg-input" style={{ marginBottom: 12 }} value={loginId} onChange={(e) => setLoginId(e.target.value)} autoComplete="off" />
          <label className="mg-label">كلمة مرور مؤقتة قوية (12 حرفاً على الأقل) *</label>
          <input type="password" className="mg-input" style={{ marginBottom: 12 }} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />

          <label className="mg-label">المنطقة</label>
          <select className="mg-select" style={{ marginBottom: 12 }} value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">— بدون تحديد —</option>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>

          {err && <div style={{ color: "#D93025", fontSize: 13, marginBottom: 10 }}>⚠️ {err}</div>}
          <button className="mg-btn mg-btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={create}>✅ إنشاء المستخدم</button>
        </Modal>
      )}
    </div>
  );
}

/* ============================== تغيير كود الدخول ============================== */

function ChangeCodeModal({ currentUser, users, onClose, onChanged }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);

  async function submit() {
    setErr("");
    if (next.length < 12) return setErr("كلمة المرور الجديدة يجب ألا تقل عن 12 حرفاً");
    if (next !== confirm) return setErr("كلمة المرور الجديدة وتأكيدها غير متطابقين");
    try {
      await authApi.changePassword(cur, next);
      onChanged(users, currentUser);
      setOk(true); setTimeout(onClose, 1200);
    } catch (error) { setErr(error.status === 401 ? "كلمة المرور الحالية غير صحيحة" : error.message || "تعذر تغيير كلمة المرور"); }
  }

  return (
    <Modal title="🔑 تغيير كلمة المرور" onClose={onClose}>
      <label className="mg-label">كلمة المرور الحالية *</label>
      <input type="password" className="mg-input" style={{ marginBottom: 12 }} value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
      <label className="mg-label">كلمة المرور الجديدة (12 حرفاً على الأقل) *</label>
      <input type="password" className="mg-input" style={{ marginBottom: 12 }} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      <label className="mg-label">تأكيد كلمة المرور الجديدة *</label>
      <input type="password" className="mg-input" style={{ marginBottom: 8 }} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      <div style={{ fontSize: 12, color: "#B76B00", marginBottom: 12 }}>⚠️ احفظه جيداً — لن تتمكن من الدخول بدونه.</div>
      {err && <div style={{ color: "#D93025", fontSize: 13, marginBottom: 10 }}>⚠️ {err}</div>}
      {ok && <div style={{ color: "#188038", fontSize: 13, marginBottom: 10 }}>✅ تم تغيير كلمة المرور</div>}
      <button className="mg-btn mg-btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={submit}>✅ تغيير كلمة المرور</button>
    </Modal>
  );
}

/* ============================== سجل التنبيهات ============================== */

function AlertsPanel({ alerts, onClear }) {
  return (
    <div className="mg-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>🔔 سجل التنبيهات</h3>
        <button className="mg-btn mg-btn-ghost mg-btn-sm" onClick={onClear}>🗑 مسح الكل</button>
      </div>
      {alerts.length === 0 && <div style={{ color: "#8A6C68" }}>لا توجد تنبيهات</div>}
      {alerts.map((a) => (
        <div key={a.id} style={{ padding: "10px 0", borderBottom: "1px solid #F3E9E8" }}>
          <div style={{ fontSize: 14 }}>{a.text}</div>
          <div style={{ fontSize: 11.5, color: "#B79A96" }}>{fmtTime(a.ts)}</div>
        </div>
      ))}
    </div>
  );
}

/* ============================== الهيدر ============================== */


function DashboardPanel({ reports, users, regions, currentUser, onOpenReports, onOpenOps, onOpenStats }) {
  const now = Date.now();
  const open = reports.filter((r) => r.status !== "done");
  const critical = open.filter((r) => r.severity === "1");
  const today = reports.filter((r) => isSameDay(r.createdAt, now));
  const doneToday = reports.filter((r) => r.status === "done" && r.completedAt && isSameDay(r.completedAt, now));
  const started = reports.filter((r) => r.startedAt);
  const avgResponse = started.length ? started.reduce((sum, r) => sum + (r.startedAt - r.createdAt), 0) / started.length : null;
  const perf = computeUserPerformance(reports).slice(0, 5);
  const hot = [...open].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.createdAt - b.createdAt).slice(0, 6);
  const regionCounts = regions.map((region) => ({ name: region.name, count: open.filter((r) => r.region === region.id).length }))
    .filter((x) => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 5);
  const maxRegionCount = regionCounts.length ? regionCounts[0].count : 1;
  const responseTeam = users.filter((u) => u.role === "response");

  return (
    <div>
      <div className="mg-section-head">
        <div>
          <h1 className="mg-page-title">مركز القيادة التشغيلية</h1>
          <div className="mg-page-sub"><span className="mg-live-dot" /> النظام يعمل لحظيًا · {currentUser?.name} · آخر قراءة {new Date(now).toLocaleTimeString("ar-EG")}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="mg-btn mg-btn-outline" onClick={onOpenReports}>📄 إدارة البلاغات</button>
          <button className="mg-btn mg-btn-primary" onClick={onOpenOps}>📺 لوحة العمليات</button>
        </div>
      </div>

      <div className="mg-kpi-grid" style={{ marginBottom: 14 }}>
        <div className="mg-stat mg-stat-danger"><div className="num">{critical.length}</div><div className="lbl">حالات حرجة مفتوحة</div></div>
        <div className="mg-stat mg-stat-amber"><div className="num">{open.length}</div><div className="lbl">إجمالي الحالات المفتوحة</div></div>
        <div className="mg-stat mg-stat-blue"><div className="num">{today.length}</div><div className="lbl">بلاغات اليوم</div></div>
        <div className="mg-stat mg-stat-success"><div className="num">{doneToday.length}</div><div className="lbl">حالات أُنجزت اليوم</div></div>
      </div>

      <div className="mg-dashboard-grid">
        <div style={{ display: "grid", gap: 14 }}>
          <div className="mg-card">
            <div className="mg-section-head">
              <div><h3 style={{ margin: 0 }}>🚨 طابور الاستجابة</h3><div className="mg-page-sub">الحالات مرتبة حسب الخطورة وعمر البلاغ</div></div>
              <span className="mg-badge" style={{ background: "#fff1f2", color: "#b91c1c" }}>{critical.length} حرجة</span>
            </div>
            {hot.length === 0 ? <div className="mg-empty">لا توجد حالات مفتوحة حاليًا.</div> : (
              hot.map((r) => {
                const sv = sevMeta(r.severity);
                const region = regions.find((x) => x.id === r.region);
                return (
                  <div key={r.id} className="mg-side-item" style={{ borderRight: `5px solid ${sv.color}`, marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><b>{sv.emoji} {r.incidentType}</b><span style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b" }}>{r.crn}</span></div>
                    <div className="mg-report-meta" style={{ marginTop: 6 }}><span>📍 {region?.name || "غير محدد"}</span><span>👤 {r.assignee || "غير مسند"}</span><span>⏱️ {fmtDuration(now - r.createdAt)}</span></div>
                  </div>
                );
              })
            )}
          </div>

          <div className="mg-card">
            <div className="mg-section-head"><div><h3 style={{ margin: 0 }}>👨‍🔧 حالة فريق الاستجابة</h3><div className="mg-page-sub">التحميل الحالي لكل فني</div></div></div>
            {responseTeam.length === 0 ? <div className="mg-empty">لا يوجد فنيو استجابة مسجلون.</div> : (
              <div className="mg-three-col">
                {responseTeam.map((u) => {
                  const active = open.filter((r) => r.assignee === u.name);
                  return <div key={u.id} className="mg-side-item"><div style={{ display: "flex", justifyContent: "space-between" }}><b>{u.name}</b><span className="mg-live-dot" style={{ background: active.length ? "#f59e0b" : "#22c55e" }} /></div><div style={{ fontSize: 11.5, color: "#64748b", marginTop: 6 }}>{active.length ? `مشغول · ${active.length} حالة` : "متاح الآن"}</div></div>;
                })}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <div className="mg-card">
            <div className="mg-section-head"><div><h3 style={{ margin: 0 }}>⚡ مؤشرات السرعة</h3><div className="mg-page-sub">قياس تشغيلي مباشر</div></div></div>
            <div className="mg-two-col">
              <div className="mg-stat"><div className="num">{avgResponse != null ? fmtDuration(avgResponse) : "—"}</div><div className="lbl">متوسط الاستجابة</div></div>
              <div className="mg-stat"><div className="num">{started.length ? Math.round(started.filter((r) => r.status === "done").length / started.length * 100) : 0}%</div><div className="lbl">نسبة الإغلاق للحالات المسندة</div></div>
            </div>
            <button className="mg-btn mg-btn-outline" style={{ width: "100%", marginTop: 12 }} onClick={onOpenStats}>📊 افتح تحليلات الأداء</button>
          </div>

          <div className="mg-card">
            <div className="mg-section-head"><div><h3 style={{ margin: 0 }}>🏙️ ضغط المناطق</h3><div className="mg-page-sub">أكثر المناطق احتياجًا للانتباه الآن</div></div></div>
            {regionCounts.length === 0 ? <div className="mg-empty">لا توجد بيانات ضغط حاليًا.</div> : regionCounts.map((x) => (
              <div key={x.name} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 800 }}><span>{x.name}</span><span>{x.count}</span></div>
                <div className="mg-progress" style={{ marginTop: 5 }}><span style={{ width: `${Math.min(100, x.count / maxRegionCount * 100)}%` }} /></div>
              </div>
            ))}
          </div>

          <div className="mg-card">
            <div className="mg-section-head"><div><h3 style={{ margin: 0 }}>🏅 مؤشرات أداء الفنيين</h3><div className="mg-page-sub">للمراجعة والتدريب وتحسين توزيع الأحمال.</div></div></div>
            {perf.length === 0 ? <div className="mg-empty">لا توجد بيانات فنيين.</div> : perf.map((u) => (
              <div key={u.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 0", borderBottom: "1px solid #eef2f7" }}>
                <div className="mg-score" style={{ width: 42, height: 42, fontSize: 13, color: u.ratingColor, borderWidth: 4 }}>{u.score}</div>
                <div style={{ flex: 1 }}><b>{u.name}</b><div style={{ fontSize: 11, color: "#64748b" }}>{u.avgResponse != null ? `استجابة ${fmtDuration(u.avgResponse)}` : "لا توجد استجابة مسجلة"} · SLA {u.slaRate}%</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({ currentUser, onLogout, onChangeCode, onRefresh, tab, setTab, appName }) {
  const tabsByRole = {
    super_admin: ["dashboard", "report", "list", "opswall", "stats", "regions", "users", "settings", "alerts"],
    manager: ["dashboard", "report", "list", "opswall", "stats", "regions", "alerts"],
    response: ["dashboard", "report", "list", "opswall"],
    observer: ["dashboard", "list", "opswall", "stats", "alerts"],
    reporter: ["dashboard", "report", "list", "alerts"],
  };
  const tabLabels = {
    dashboard: "🏠 القيادة",
    report: "📋 بلاغ جديد", list: "📄 البلاغات", opswall: "📺 لوحة العمليات", stats: "📊 إحصائيات",
    regions: "🗺️ المناطق", users: "👥 المستخدمين", settings: "⚙️ الإعدادات", alerts: "🔔 التنبيهات",
  };
  const tabs = tabsByRole[currentUser.role] || ["list"];

  return (
    <>
      <div className="mg-header">
        <div className="mg-header-inner">
          <div className="mg-brand">
            <img className="mg-brand-logo" src="/logo.png" alt="MODERNGAS" />
            <div style={{ minWidth: 0 }}>
              <div className="mg-brand-title">{appName}</div>
              <div className="mg-brand-sub">{roleIcon(currentUser.role)} {currentUser.name} · {ROLES[currentUser.role]?.label}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="mg-btn mg-btn-sm" style={{ background: "rgba(255,255,255,.2)", color: "#fff" }} onClick={onRefresh}>🔄</button>
            <button className="mg-btn mg-btn-sm" style={{ background: "rgba(255,255,255,.2)", color: "#fff" }} onClick={onChangeCode}>🔑</button>
            <button className="mg-btn mg-btn-sm" style={{ background: "rgba(255,255,255,.2)", color: "#fff" }} onClick={onLogout}>⏻</button>
          </div>
        </div>
      </div>
      <div className="mg-tabs">
        {tabs.map((t) => (
          <button key={t} className={`mg-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{tabLabels[t]}</button>
        ))}
      </div>
    </>
  );
}

/* ============================== لوحة الإعدادات (اسم البرنامج + الأيقونات) ============================== */

function SettingsPanel({ settings, onSaved }) {
  const [form, setForm] = useState({
    appName: settings.appName || "نظام طوارئ الغاز",
    roleIcons: { ...settings.roleIcons },
    severityIcons: { ...settings.severityIcons },
    whatsappNumbers: migrateWhatsappNumbers(settings.whatsappNumbers),
    zoomLink: settings.zoomLink || "",
    theme: { ...(defaultAppSettings().theme), ...(settings.theme || {}) },
  });
  const [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState(false);

  // يجمع بيانات النظام من واجهة الخادم المصرح بها في ملف JSON واحد
  // يقدر المسؤول يحمّله وينقله لأي سيرفر أو قاعدة بيانات تانية تخص الشركة لاحقاً.
  async function exportAllData() {
    setExporting(true);
    try {
      const [users, regions, reports, alerts, settingsData] = await Promise.all([
        loadJSON("gas_users", []), loadJSON("gas_regions", []),
        loadJSON("gas_reports", []), loadJSON("gas_alerts", []),
        loadJSON("gas_settings", defaultAppSettings()),
      ]);
      const payload = {
        exportedAt: new Date().toISOString(),
        source: "moderngas-emergency (PostgreSQL API)",
        users, regions, reports, alerts, settings: settingsData,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gas-emergency-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("تعذّر تصدير البيانات: " + ((e && e.message) || String(e)));
    }
    setExporting(false);
  }

  function setRoleIcon(role, val) { setForm((f) => ({ ...f, roleIcons: { ...f.roleIcons, [role]: val } })); }
  function setSevIcon(id, val) { setForm((f) => ({ ...f, severityIcons: { ...f.severityIcons, [id]: val } })); }

  // قائمة أرقام واتساب: قابلة للتعديل بالكامل — إضافة، حذف، وتعديل أي حقل
  function setWhatsappField(i, key, val) {
    setForm((f) => ({ ...f, whatsappNumbers: f.whatsappNumbers.map((n, idx) => (idx === i ? { ...n, [key]: val } : n)) }));
  }
  function addWhatsappEntry() {
    setForm((f) => ({ ...f, whatsappNumbers: [...f.whatsappNumbers, { role: "", phone: "", description: "" }] }));
  }
  function removeWhatsappEntry(i) {
    setForm((f) => ({ ...f, whatsappNumbers: f.whatsappNumbers.filter((_, idx) => idx !== i) }));
  }

  async function save() {
    applyAppSettings(form);
    await saveJSON("gas_settings", form);
    onSaved(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }
  function resetDefaults() { setForm(defaultAppSettings()); }

  return (
    <div className="mg-card">
      <h3 style={{ marginTop: 0 }}>⚙️ إعدادات البرنامج</h3>

      <label className="mg-label">اسم البرنامج (يظهر أعلى الشاشة)</label>
      <input
        className="mg-input" style={{ marginBottom: 18 }}
        value={form.appName} onChange={(e) => setForm((f) => ({ ...f, appName: e.target.value }))}
      />

      <div style={{ fontWeight: 700, marginBottom: 10 }}>أيقونات الأدوار (الرموز التعبيرية)</div>
      {Object.entries(ROLES).map(([key, r]) => (
        <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: "#6B4B47" }}>{r.label}</span>
          <input
            className="mg-input" style={{ width: 70, textAlign: "center" }}
            value={form.roleIcons[key] ?? r.icon}
            onChange={(e) => setRoleIcon(key, e.target.value)}
          />
        </div>
      ))}

      <div style={{ fontWeight: 700, margin: "18px 0 10px" }}>أيقونات درجات الخطورة</div>
      {SEVERITIES.map((s) => (
        <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: "#6B4B47" }}>{s.label}</span>
          <input
            className="mg-input" style={{ width: 70, textAlign: "center" }}
            value={form.severityIcons[s.id] ?? s.emoji}
            onChange={(e) => setSevIcon(s.id, e.target.value)}
          />
        </div>
      ))}

      <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px dashed #EBD9D6" }}>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>🎨 تخصيص شكل وألوان الواجهة</div>
        <p style={{ fontSize: 12.5, color: "#8A6C68", marginTop: 0, marginBottom: 12 }}>يمكنك تغيير لون الخلفية والألوان الرئيسية وشكل الخانات والأزرار. التغيير يطبق على البرنامج كله.</p>
        <div className="mg-grid2" style={{ marginBottom: 10 }}>
          <div><label className="mg-label">لون الواجهة الرئيسي</label><input type="color" className="mg-input" style={{ height: 44, padding: 4 }} value={form.theme.primary} onChange={(e) => setForm(f => ({ ...f, theme: { ...f.theme, primary: e.target.value } }))} /></div>
          <div><label className="mg-label">لون الخلفية</label><input type="color" className="mg-input" style={{ height: 44, padding: 4 }} value={form.theme.bg} onChange={(e) => setForm(f => ({ ...f, theme: { ...f.theme, bg: e.target.value } }))} /></div>
          <div><label className="mg-label">لون البطاقات والخانات</label><input type="color" className="mg-input" style={{ height: 44, padding: 4 }} value={form.theme.card} onChange={(e) => setForm(f => ({ ...f, theme: { ...f.theme, card: e.target.value } }))} /></div>
          <div><label className="mg-label">لون الإبراز</label><input type="color" className="mg-input" style={{ height: 44, padding: 4 }} value={form.theme.accent} onChange={(e) => setForm(f => ({ ...f, theme: { ...f.theme, accent: e.target.value } }))} /></div>
        </div>
        <label className="mg-label">شكل الخانات والأزرار</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 8 }}>
          {[
            ["square", "▣", "مربع"], ["rounded", "▢", "مستدير"], ["pill", "●", "بيضاوي"], ["hexagon", "⬢", "مسدس"]
          ].map(([id, icon, label]) => (
            <button type="button" key={id} className="mg-btn mg-btn-outline" style={{ justifyContent: "center", border: form.theme.shape === id ? "2px solid var(--mg-primary)" : undefined, background: form.theme.shape === id ? "#fff1f2" : undefined }} onClick={() => setForm(f => ({ ...f, theme: { ...f.theme, shape: id } }))}>{icon} {label}</button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px dashed #EBD9D6" }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>📱 أرقام واتساب تنبيهات الطوارئ</div>
        <p style={{ fontSize: 12.5, color: "#8A6C68", marginTop: 0, marginBottom: 10 }}>
          تُرسل لهم رسالة واتساب فورية عند تسجيل بلاغ شديد الخطورة (انفجار خط غاز 7 بار، كسر خط غاز،
          حريق، حريق منظم، حادثة محطة غاز). الرقم المختصر بجانب كل جهة يعتمد على ترتيبها في القائمة،
          ويُستخدم في نص الرسالة بدل كتابة المسمى كاملاً — مثال: "✅ تم إبلاغ: 1، 3، 5".
        </p>
        {form.whatsappNumbers.map((n, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10, background: "#FBF0EF", borderRadius: 10, padding: 10 }}>
            <span style={{ fontWeight: 700, color: "#D93025", background: "#FDECEA", borderRadius: 8, padding: "6px 10px", fontFamily: "monospace", flexShrink: 0 }}>{i + 1}</span>
            <div style={{ flex: 1 }}>
              <div className="mg-grid2" style={{ marginBottom: 6 }}>
                <input className="mg-input" placeholder="المسمّى (مثال: مدير المنطقة)" value={n.role} onChange={(e) => setWhatsappField(i, "role", e.target.value)} />
                <input className="mg-input" placeholder="رقم واتساب مع كود الدولة (2010xxxxxxxx)" value={n.phone} onChange={(e) => setWhatsappField(i, "phone", e.target.value)} />
              </div>
              <input className="mg-input" placeholder="وصف اختياري (مثال: متاح على مدار الساعة)" value={n.description} onChange={(e) => setWhatsappField(i, "description", e.target.value)} />
            </div>
            <button type="button" className="mg-btn mg-btn-outline mg-btn-sm" onClick={() => removeWhatsappEntry(i)}>🗑️</button>
          </div>
        ))}
        <button type="button" className="mg-btn mg-btn-ghost mg-btn-sm" style={{ width: "100%", justifyContent: "center" }} onClick={addWhatsappEntry}>
          ➕ إضافة جهة اتصال
        </button>
      </div>

      <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px dashed #EBD9D6" }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>🎥 رابط اجتماع الطوارئ (Zoom)</div>
        <p style={{ fontSize: 12.5, color: "#8A6C68", marginTop: 0, marginBottom: 10 }}>
          رابط ثابت لغرفة اجتماعات Zoom الخاصة بالسوبر أدمن والمهندسين — يُرفق تلقائياً في رسائل
          تنبيه الحالات شديدة الخطورة، ويظهر كزر مباشر لبدء الاجتماع عند إرسال التنبيه.
        </p>
        <input
          className="mg-input" placeholder="https://zoom.us/j/xxxxxxxxxx?pwd=..."
          value={form.zoomLink} onChange={(e) => setForm((f) => ({ ...f, zoomLink: e.target.value }))}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button className="mg-btn mg-btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={save}>💾 حفظ الإعدادات</button>
        <button className="mg-btn mg-btn-outline" onClick={resetDefaults}>↩️ استعادة الافتراضي</button>
      </div>
      {saved && <div style={{ color: "#188038", fontSize: 13, marginTop: 10, textAlign: "center" }}>✅ تم الحفظ — التغييرات ظاهرة الآن في كل الشاشات</div>}

      <div style={{ marginTop: 22, paddingTop: 14, borderTop: "1px dashed #EBD9D6" }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>📦 نسخة احتياطية / نقل البيانات</div>
        <p style={{ fontSize: 12.5, color: "#8A6C68", marginTop: 0, marginBottom: 10 }}>
          تحميل نسخة كاملة من كل البيانات (المستخدمين، البلاغات، المناطق، التنبيهات) في ملف JSON واحد،
          لحفظها أو نقلها لأي سيرفر أو قاعدة بيانات خاصة بالشركة لاحقاً.
        </p>
        <button className="mg-btn mg-btn-outline" style={{ width: "100%", justifyContent: "center" }} onClick={exportAllData} disabled={exporting}>
          {exporting ? "⏳ جاري التصدير…" : "⬇️ تحميل نسخة كاملة من البيانات (JSON)"}
        </button>
      </div>

      <div style={{ marginTop: 20, paddingTop: 14, borderTop: "1px dashed #EBD9D6", fontSize: 12.5, color: "#8A6C68" }}>
        🔑 لتغيير <b>كود الدخول الخاص بك</b>، استخدم زر المفتاح أعلى الصفحة بجانب زر تسجيل الخروج.
      </div>
    </div>
  );
}

/* ============================== التطبيق الرئيسي ============================== */

/* ============================== لوحة العمليات الحية (وضع الشاشة الكبيرة) ============================== */

function isSameDay(ts1, ts2) {
  const a = new Date(ts1), b = new Date(ts2);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// شارة عمر البلاغ: تتلوّن تدريجياً كلما طال الوقت من غير حل — بنفس منطق
// "تصعيد الأولوية بالوقت" (SLA escalation) المستخدم في أنظمة غرف عمليات
// الطوارئ الحقيقية، بدل ما يبقى كل بلاغ بلون واحد ثابت طول الوقت
function ageBadgeStyle(ms) {
  const mins = ms / 60000;
  if (mins < 15) return { bg: "#E6F4EA", color: "#188038", pulse: false };
  if (mins < 60) return { bg: "#FFF4E5", color: "#B36B00", pulse: false };
  return { bg: "#FDECEA", color: "#D93025", pulse: true };
}

// أيقونة ماركر مُلوَّنة حسب درجة خطورة البلاغ — بدون الحاجة لملفات صور خارجية
// (المشكلة المعروفة مع Leaflet داخل أدوات البناء الحديثة كـ Vite)
function sevDivIcon(color, pulse) {
  return L.divIcon({
    className: "",
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 3px ${color}55;${pulse ? "animation: mgPulse 1.6s infinite;" : ""}"></div>`,
    iconSize: [18, 18],
  });
}

// خريطة تفاعلية حية (GIS) — أهم عنصر مشترك بين كل أنظمة التحكم في غرف عمليات
// الطوارئ الحقيقية (CAD Systems): عرض موقع كل حادثة مفتوحة على خريطة فعلية
// بدل قوائم نصية فقط. تستخدم خرائط OpenStreetMap المجانية (بدون مفتاح API
// أو تكلفة)، وتتحدث تلقائياً مع كل تحديث للبلاغات.
function LiveMapPanel({ reports, regions }) {
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => {
    if (!mapRef.current) {
      mapRef.current = L.map(mapDivRef.current, { zoomControl: true, attributionControl: true }).setView([26.8, 30.8], 6);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(mapRef.current);
    }
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const bounds = [];
    reports.forEach((r) => {
      const region = regions.find((rg) => rg.id === r.region);
      const lat = r.location?.lat ?? r.geocoded?.lat ?? region?.lat;
      const lng = r.location?.lng ?? r.geocoded?.lng ?? region?.lng;
      if (lat == null || lng == null) return;
      const sv = sevMeta(r.severity);
      const marker = L.marker([lat, lng], { icon: sevDivIcon(sv.color, r.severity === "1") }).addTo(mapRef.current);
      marker.bindPopup(
        `<div style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;font-size:13px;direction:rtl;text-align:right;">` +
        `<strong>${sv.emoji} ${r.crn || ""}</strong><br/>${r.incidentType}<br/>${r.reporterName}<br/>` +
        `<span style="color:#8A6C68;">${statusMeta(r.status).label}${region ? " · " + region.name : ""}</span></div>`
      );
      markersRef.current.push(marker);
      bounds.push([lat, lng]);
    });
    if (bounds.length > 0) {
      try { mapRef.current.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 }); } catch (e) {}
    }
  }, [reports, regions]);

  useEffect(() => {
    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  return <div ref={mapDivRef} style={{ width: "100%", height: 380, borderRadius: 12, overflow: "hidden", marginBottom: 16 }} />;
}

function OpsWallPanel({ reports, users, regions }) {
  const [now, setNow] = useState(Date.now());
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
  }

  const open = reports.filter((r) => r.status !== "done");
  const critical = open.filter((r) => r.severity === "1");
  const resolvedToday = reports.filter((r) => r.status === "done" && r.completedAt && isSameDay(r.completedAt, now));
  const startedToday = reports.filter((r) => r.startedAt && isSameDay(r.startedAt, now));
  const avgResponseMs = startedToday.length
    ? startedToday.reduce((sum, r) => sum + (r.startedAt - r.createdAt), 0) / startedToday.length
    : null;

  const sorted = [...open].sort((a, b) => {
    const sevDiff = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (sevDiff !== 0) return sevDiff;
    return a.createdAt - b.createdAt;
  });

  const responseTeam = users.filter((u) => u.role === "response");
  function statusFor(u) {
    const active = open.find((r) => r.status === "processing" && r.assignee === u.name);
    return active ? { busy: true, report: active } : { busy: false };
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "monospace" }}>
          {new Date(now).toLocaleTimeString("ar-EG")}
        </div>
        <button className="mg-btn mg-btn-outline mg-btn-sm" onClick={toggleFullscreen}>
          {isFullscreen ? "⤢ إنهاء ملء الشاشة" : "⛶ ملء الشاشة"}
        </button>
      </div>

      {/* شريط المؤشرات الحية */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
        <div className="mg-card" style={{ textAlign: "center", padding: 12 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#D93025" }}>{open.length}</div>
          <div style={{ fontSize: 11.5, color: "#8A6C68" }}>بلاغ مفتوح</div>
        </div>
        <div className="mg-card" style={{ textAlign: "center", padding: 12 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#D93025" }}>{critical.length}</div>
          <div style={{ fontSize: 11.5, color: "#8A6C68" }}>شديد الخطورة 🔴</div>
        </div>
        <div className="mg-card" style={{ textAlign: "center", padding: 12 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#188038" }}>{resolvedToday.length}</div>
          <div style={{ fontSize: 11.5, color: "#8A6C68" }}>أُنجز اليوم</div>
        </div>
        <div className="mg-card" style={{ textAlign: "center", padding: 12 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#6B4B47" }}>{avgResponseMs != null ? fmtDuration(avgResponseMs) : "—"}</div>
          <div style={{ fontSize: 11.5, color: "#8A6C68" }}>متوسط زمن الاستجابة اليوم</div>
        </div>
      </div>

      {/* الخريطة التفاعلية الحية — موقع كل بلاغ مفتوح فعلياً */}
      <LiveMapPanel reports={open} regions={regions} />

      {/* حالة فريق الاستجابة */}
      {responseTeam.length > 0 && (
        <div className="mg-card" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>🚒 حالة فريق الاستجابة</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {responseTeam.map((u) => {
              const s = statusFor(u);
              return (
                <div key={u.id} style={{
                  display: "flex", alignItems: "center", gap: 6, borderRadius: 20, padding: "6px 12px",
                  background: s.busy ? "#FFF4E5" : "#E6F4EA", fontSize: 12.5,
                }}>
                  <span>{s.busy ? "🟡" : "🟢"}</span>
                  <span style={{ fontWeight: 700 }}>{u.name}</span>
                  {s.busy && <span style={{ color: "#8A6C68", fontFamily: "monospace" }}>({s.report.crn})</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* بطاقات البلاغات المفتوحة */}
      {sorted.length === 0 ? (
        <div style={{ textAlign: "center", color: "#8A6C68", padding: 30 }}>✅ لا توجد بلاغات مفتوحة حالياً</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
          {sorted.map((r) => {
            const sv = sevMeta(r.severity);
            const age = ageBadgeStyle(now - r.createdAt);
            const region = regions.find((rg) => rg.id === r.region);
            return (
              <div
                key={r.id}
                className="mg-card"
                style={{
                  borderRight: `6px solid ${sv.color}`,
                  animation: age.pulse ? "mgPulse 1.6s infinite" : "none",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontWeight: 800, fontSize: 14 }}>{sv.emoji} {r.incidentType}</span>
                  <span style={{ fontSize: 11, fontFamily: "monospace", color: "#8A6C68" }}>{r.crn}</span>
                </div>
                <div style={{ fontSize: 13, color: "#6B4B47", marginBottom: 4 }}>{r.reporterName} · {region?.name || "—"}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="mg-badge" style={{ background: statusMeta(r.status).bg, color: statusMeta(r.status).color, fontSize: 11.5 }}>
                    {statusMeta(r.status).label}
                  </span>
                  <span style={{ background: age.bg, color: age.color, fontWeight: 700, fontSize: 11.5, borderRadius: 8, padding: "2px 8px" }}>
                    ⏱️ {fmtDuration(now - r.createdAt)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [phase, setPhase] = useState("loading"); // loading | setup | login | app
  const [currentUser, setCurrentUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [regions, setRegions] = useState([]);
  const [reports, setReports] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [settings, setSettings] = useState(defaultAppSettings());
  const [tab, setTab] = useState("dashboard");
  const [showChangeCode, setShowChangeCode] = useState(false);
  const [criticalAlert, setCriticalAlert] = useState(null);
  const pollRef = useRef(null);
  const seenReportIdsRef = useRef(null);

  const loadAll = useCallback(async () => {
    const [u, r, rep, al, st] = await Promise.all([
      ["super_admin", "manager"].includes(currentUser?.role) ? loadJSON("gas_users", []) : Promise.resolve(users), loadJSON("gas_regions", []),
      loadJSON("gas_reports", []), loadJSON("gas_alerts", []),
      loadJSON("gas_settings", defaultAppSettings()),
    ]);
    setUsers(u); setRegions(r); setReports(rep); setAlerts(al);
    applyAppSettings(st); setSettings(st);
    return u;
  }, [currentUser, users]);

  useEffect(() => {
    (async () => {
      try {
        const status = await authApi.status();
        if (!status.setupComplete) { setPhase("setup"); return; }
        try {
          const session = await authApi.me();
          setCurrentUser(session.user);
          setPhase("app");
        } catch (error) {
          if (error.status === 401) setPhase("login");
          else throw error;
        }
      } catch (error) {
        setPhase("error");
      }
    })();
  }, []);

  useEffect(() => {
    if (phase === "app" && currentUser) loadAll().catch(() => setPhase("error"));
  }, [phase, currentUser]);

  useEffect(() => {
    if (phase === "app") {
      pollRef.current = setInterval(() => { loadAll(); }, 8000);
      return () => clearInterval(pollRef.current);
    }
  }, [phase, loadAll]);

  // إنذار حي: عند وصول بلاغ جديد شديد الخطورة (أثناء وجودك في التطبيق فعلاً)،
  // تُشغَّل صفارة إنذار ويظهر بانر تنبيه فوري — بنفس أسلوب غرف عمليات الطوارئ
  useEffect(() => {
    if (phase !== "app") return;
    const currentIds = new Set(reports.map((r) => r.id));
    if (seenReportIdsRef.current) {
      const fresh = reports.find(
        (r) => r.severity === "1" && r.status === "new" && !seenReportIdsRef.current.has(r.id)
      );
      if (fresh && ["super_admin", "manager", "response"].includes(currentUser?.role)) {
        setCriticalAlert(fresh);
        playAlertSiren();
      }
    }
    seenReportIdsRef.current = currentIds;
  }, [reports, phase, currentUser]);

  // تصعيد تلقائي: أي بلاغ "أولى" (شديد الخطورة) يفضل بحالة "جديد" من غير ما
  // حد يبدأ معالجته لأكتر من 10 دقايق، يُصعَّد تلقائياً — تنبيه داخلي + صفارة
  // + محاولة إعادة إرسال واتساب صامتة عبر سيرفر الشركة (لو متاح) — بنفس مبدأ
  // "تصعيد الأولوية بالوقت" (SLA escalation) في أنظمة غرف عمليات الطوارئ.
  // كل بلاغ يُصعَّد مرة واحدة بس (يُعلَّم بـ escalatedAt) لتفادي التكرار.
  useEffect(() => {
    if (phase !== "app") return;
    const ESCALATION_MS = 10 * 60 * 1000;
    const toEscalate = reports.filter(
      (r) => r.severity === "1" && r.status === "new" && !r.escalatedAt && (Date.now() - r.createdAt) > ESCALATION_MS
    );
    if (toEscalate.length === 0) return;
    (async () => {
      const updatedAll = reports.map((r) => (toEscalate.find((e) => e.id === r.id) ? { ...r, escalatedAt: Date.now() } : r));
      await saveJSON("gas_reports", updatedAll);
      setReports(updatedAll);
      const currentAlerts = await loadJSON("gas_alerts", []);
      const newAlertEntries = [];
      for (const r of toEscalate) {
        const mins = Math.round((Date.now() - r.createdAt) / 60000);
        newAlertEntries.push({ id: uid(), text: `⏰ تصعيد تلقائي: بلاغ ${r.crn} (${r.incidentType}) شديد الخطورة لم تبدأ معالجته منذ ${mins} دقيقة!`, ts: Date.now() });
        if (["super_admin", "manager", "response"].includes(currentUser?.role)) {
          setCriticalAlert({ ...r, incidentType: `⏰ تصعيد — ${r.incidentType}` });
          playAlertSiren();
        }
        trySelfHostedWhatsApp(r, regions); // محاولة صامتة عبر سيرفر الشركة لو متاح، من غير انتظار النتيجة
      }
      await saveJSON("gas_alerts", [...newAlertEntries, ...currentAlerts].slice(0, 100));
    })();
  }, [reports, phase, currentUser, regions]);

  if (phase === "loading") {
    return (
      <div className="mg-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <GlobalStyle />
        <div style={{ color: "#8A6C68" }}>جاري الاتصال…</div>
      </div>
    );
  }

  if (phase === "error") return (
    <div className="mg-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 20 }}>
      <GlobalStyle /><div className="mg-card" style={{ maxWidth: 480, textAlign: "center" }}>
        <h2>تعذر الاتصال بخادم التطبيق</h2><p style={{ color: "#6B4B47" }}>الخادم أو قاعدة البيانات غير مهيأة بعد، أو لا يوجد اتصال بالإنترنت. لا تُدخل بيانات العملاء قبل اكتمال إعداد الخادم.</p>
        <button className="mg-btn mg-btn-primary" onClick={() => { setPhase("loading"); authApi.status().then(() => window.location.reload()).catch(() => setPhase("error")); }}>إعادة المحاولة</button>
      </div>
    </div>
  );

  if (phase === "setup") {
    return <SetupScreen onDone={(u) => { setCurrentUser(u); setPhase("app"); setTab("dashboard"); }} />;
  }

  if (phase === "login") {
    return <LoginScreen onLogin={(u) => { setCurrentUser(u); setPhase("app"); setTab("dashboard"); }} />;
  }

  const canEdit = ["super_admin", "manager", "response"].includes(currentUser.role);

  return (
    <div className={`mg-root mg-theme-${settings.theme?.shape || "rounded"}`} style={themeCss(settings.theme)}>
      <GlobalStyle />
      {criticalAlert && (
        <div
          style={{
            position: "sticky", top: 0, zIndex: 500, color: "#fff", padding: "12px 16px",
            display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
            animation: "mgBannerFlash 1s infinite", flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 800, fontSize: 13.5 }}>
            🚨 بلاغ جديد شديد الخطورة: {criticalAlert.incidentType} — {criticalAlert.crn} ({criticalAlert.reporterName})
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="mg-btn mg-btn-sm" style={{ background: "#fff", color: "#D93025" }}
              onClick={() => { setTab("list"); setCriticalAlert(null); }}
            >عرض التفاصيل</button>
            <button className="mg-btn mg-btn-sm" style={{ background: "rgba(255,255,255,0.25)", color: "#fff" }} onClick={() => setCriticalAlert(null)}>✕</button>
          </div>
        </div>
      )}
      <Header
        currentUser={currentUser}
        tab={tab} setTab={setTab}
        appName={settings.appName || currentAppName()}
        onRefresh={loadAll}
        onChangeCode={() => setShowChangeCode(true)}
        onLogout={async () => { try { await authApi.logout(); } finally { setCurrentUser(null); setUsers([]); setPhase("login"); } }}
      />
      <div className="mg-shell">
        {tab === "dashboard" && <DashboardPanel reports={reports} users={users} regions={regions} currentUser={currentUser} onOpenReports={() => setTab("list")} onOpenOps={() => setTab("opswall")} onOpenStats={() => setTab("stats")} />}
        {tab === "report" && <IncidentForm currentUser={currentUser} regions={regions} onSubmitted={(rep) => { setReports(rep); loadAll(); }} />}
        {tab === "list" && (
          <ReportsList
            reports={reports} regions={regions} currentUser={currentUser}
            canEdit={canEdit}
            onChanged={(rep) => setReports(rep)}
          />
        )}
        {tab === "opswall" && <OpsWallPanel reports={reports} users={users} regions={regions} />}
        {tab === "stats" && (
          <>
            <StatsPanel reports={reports} />
            <UserPerformancePanel reports={reports} />
          </>
        )}
        {tab === "regions" && <RegionsManager regions={regions} onChanged={setRegions} />}
        {tab === "users" && currentUser.role === "super_admin" && <UsersManager users={users} regions={regions} onChanged={setUsers} />}
        {tab === "settings" && currentUser.role === "super_admin" && (
          <SettingsPanel settings={settings} onSaved={(s) => setSettings(s)} />
        )}
        {tab === "alerts" && (
          <AlertsPanel
            alerts={alerts}
            onClear={async () => { await saveJSON("gas_alerts", []); setAlerts([]); }}
          />
        )}
      </div>

      {showChangeCode && (
        <ChangeCodeModal
          currentUser={currentUser} users={users}
          onClose={() => setShowChangeCode(false)}
          onChanged={(u, updatedMe) => { setUsers(u); setCurrentUser(updatedMe); }}
        />
      )}
    </div>
  );
}
