import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import { notifyUser } from "../utils/notify.js";
import { sendWhatsApp } from "../utils/whatsapp/index.js";

const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Karachi";
const CHECK_MS = 6 * 60 * 60 * 1000; // re-check a few times a day

// Standard monthly fee (Rs). Discounted clinics override via billing.monthlyFee
// (e.g. Dr Ahmad is billed Rs 3,000). Overridable globally with MONTHLY_FEE.
export const DEFAULT_MONTHLY_FEE = Number(process.env.MONTHLY_FEE || 3000);

const ISSUE_DAY = 5; // invoices go out on the 5th
const DUE_DAY = 15; // payment due on the 15th
const DUE_SOON_DAYS = 3; // remind this many days before the due date
const OVERDUE_RENOTIFY_DAYS = 7; // re-nudge this often while still unpaid past due

const money = (n, currency) => `${currency || "PKR"} ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: CLINIC_TZ });
// "2026-09" -> "September 2026". Built in UTC so the label can't slip a month.
const monthLabel = (ym) => {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return String(ym);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
};

// Today's date parts in the clinic timezone (the server runs in UTC).
function clinicToday(d = new Date()) {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // "YYYY-MM-DD"
  const [y, m, day] = s.split("-").map(Number);
  return { y, m, day, ym: `${y}-${String(m).padStart(2, "0")}` };
}

// A fixed instant (noon clinic time ≈ 07:00 UTC) on the given day of a "YYYY-MM"
// month, so the stored date lands on the intended calendar day everywhere.
function dateForDay(ym, day) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day, 7, 0, 0));
}

// Every "YYYY-MM" from startYM through endYM inclusive.
function monthsBetween(startYM, endYM) {
  const [sy, sm] = startYM.split("-").map(Number);
  const [ey, em] = endYM.split("-").map(Number);
  if (!sy || !sm) return [];
  const out = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 240) break; // safety
  }
  return out;
}

// `whatsapp` is opt-in per call, not the default. This helper serves all three
// invoice notices — issued, due soon, and the overdue nudge that repeats every
// seven days — and only ONE of them is worth a WhatsApp. Sending on every one
// would put a recurring message on the dentist's phone every week about an
// invoice they already know about.
async function notifyInvoice(inv, { title, body, whatsapp }) {
  const dentist = await User.findById(inv.dentist)
    .select("name email phoneE164 whatsappOptIn")
    .catch(() => null);
  await notifyUser(inv.dentist, {
    type: "invoice_issued",
    title,
    body,
    url: "/invoices",
    email: dentist?.email ? { to: dentist.email, greeting: `Hi Dr. ${dentist.name || ""},\n\n` } : null,
  });

  if (whatsapp && dentist) {
    await sendWhatsApp({
      user: dentist,
      template: "invoice_due",
      values: {
        dentistName: `Dr. ${dentist.name}`,
        amount: money(inv.amount, inv.currency),
        month: monthLabel(inv.month),
        dueDate: fmtDate(inv.dueDate),
      },
      // One per invoice, so the weekly overdue nudge can never duplicate it
      // even if someone later turns WhatsApp on for that path too.
      dedupeKey: `invoice_due:${inv._id}`,
      invoice: inv._id,
    });
  }
}

// Create any invoices that are due but missing, for every clinic with a billing
// start month. Idempotent (unique dentist+month index), so it can run often and
// safely backfills months the server may have missed.
export async function generateInvoicesOnce() {
  const today = clinicToday();
  const dentists = await User.find({
    role: "dentist",
    "billing.startMonth": { $nin: [null, ""] },
  }).select("_id billing");

  let created = 0;
  for (const d of dentists) {
    const start = d.billing?.startMonth;
    if (!start) continue;
    const fee = Number(d.billing?.monthlyFee) || DEFAULT_MONTHLY_FEE;

    for (const month of monthsBetween(start, today.ym)) {
      // Don't issue the current month before the 5th; past months always issue.
      if (month === today.ym && today.day < ISSUE_DAY) continue;
      if (await Invoice.exists({ dentist: d._id, month })) continue;
      try {
        const inv = await Invoice.create({
          dentist: d._id,
          month,
          amount: fee,
          issueDate: dateForDay(month, ISSUE_DAY),
          dueDate: dateForDay(month, DUE_DAY),
          status: "unpaid",
        });
        created += 1;
        notifyInvoice(inv, {
          title: "New invoice issued",
          body: `Your invoice for ${month} (${money(inv.amount, inv.currency)}) is ready. Due by ${fmtDate(inv.dueDate)}.`,
        }).catch((e) => console.error("[invoice] issue notify:", e?.message));
      } catch (e) {
        if (e?.code !== 11000) console.error("[invoice] create:", e?.message);
      }
    }
  }
  if (created) console.log(`[invoice] generated ${created} invoice(s)`);
  return created;
}

// Nudge dentists about an unpaid invoice as it approaches its due date, and
// periodically while it sits overdue — nothing watched this before, so an
// invoice could go unpaid indefinitely with no reminder at all.
export async function sendInvoiceRemindersOnce() {
  const now = new Date();
  const dueSoonCutoff = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);

  let dueSoonSent = 0;
  const dueSoon = await Invoice.find({
    status: "unpaid",
    dueSoonNotifiedAt: { $exists: false },
    dueDate: { $gt: now, $lte: dueSoonCutoff },
  });
  for (const inv of dueSoon) {
    try {
      await notifyInvoice(inv, {
        title: "Invoice due soon",
        body: `Your ${inv.month} invoice (${money(inv.amount, inv.currency)}) is due on ${fmtDate(inv.dueDate)}.`,
        whatsapp: true,
      });
      inv.dueSoonNotifiedAt = now;
      await inv.save();
      dueSoonSent += 1;
    } catch (e) {
      console.error("[invoice] due-soon notify:", e?.message);
    }
  }

  let overdueSent = 0;
  const renotifyCutoff = new Date(now.getTime() - OVERDUE_RENOTIFY_DAYS * 24 * 60 * 60 * 1000);
  const overdue = await Invoice.find({
    status: "unpaid",
    dueDate: { $lt: now },
    $or: [{ lastOverdueNotifiedAt: { $exists: false } }, { lastOverdueNotifiedAt: { $lt: renotifyCutoff } }],
  });
  for (const inv of overdue) {
    try {
      await notifyInvoice(inv, {
        title: "Invoice overdue",
        body: `Your ${inv.month} invoice (${money(inv.amount, inv.currency)}) was due on ${fmtDate(inv.dueDate)} and is still unpaid.`,
      });
      inv.lastOverdueNotifiedAt = now;
      await inv.save();
      overdueSent += 1;
    } catch (e) {
      console.error("[invoice] overdue notify:", e?.message);
    }
  }

  return { dueSoonSent, overdueSent };
}

// In-process timer plus a run at startup (a managed cron hitting
// /api/cron/generate-invoices covers free-tier instances that sleep).
export function startInvoiceJob() {
  const run = () => {
    generateInvoicesOnce().catch((e) => console.error("[invoice] error:", e?.message));
    sendInvoiceRemindersOnce().catch((e) => console.error("[invoice] reminder error:", e?.message));
  };
  run();
  setInterval(run, CHECK_MS);
}
