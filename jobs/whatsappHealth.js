import User from "../models/User.js";
import WhatsAppMessage from "../models/WhatsAppMessage.js";
import { notifyUser } from "../utils/notify.js";
import { whatsappSessionStatus } from "../utils/whatsapp/index.js";

// Watches the WhatsApp session and tells us when it dies.
//
// This failure is silent by nature, which is the whole reason the job exists.
// The session logs out — the linked phone stayed offline past WhatsApp's
// ~14-day limit, or the number got banned — and from the outside everything
// looks normal: the API is up, appointments save, push and email still go.
// Only WhatsApp stops, and the first anyone hears of it is a dentist asking
// why patients aren't getting reminders.
//
// Two signals, because they fail differently:
//   1. The session isn't WORKING. The obvious case.
//   2. The session SAYS it's working but sends keep failing. Seen when WAHA is
//      reachable while the socket underneath it is not.

const CHECK_MS = Number(process.env.WHATSAPP_HEALTH_CHECK_MS || 10 * 60 * 1000);
// While it stays broken, nag this often rather than once and never again.
const RENOTIFY_MS = Number(process.env.WHATSAPP_HEALTH_RENOTIFY_MS || 6 * 60 * 60 * 1000);
// Signal 2: this many failures in the recent window with nothing getting
// through means the session is sick whatever it claims.
const FAIL_WINDOW_MS = 60 * 60 * 1000;
const FAIL_THRESHOLD = Number(process.env.WHATSAPP_HEALTH_FAIL_THRESHOLD || 5);

// In memory on purpose: a restart re-checking and re-alerting once is the
// right behaviour, not a bug worth persisting state to avoid.
let lastState = null; // "healthy" | "broken"
let lastNotifiedAt = 0;

async function alertAdmins(title, body) {
  const admins = await User.find({ role: "admin" }).select("_id name email");
  if (!admins.length) {
    console.error(`[whatsapp-health] ${title} — ${body} (no admin users to notify)`);
    return;
  }
  for (const a of admins) {
    await notifyUser(a._id, {
      type: "system_alert",
      title,
      body,
      url: "/admin",
      email: a.email ? { to: a.email, greeting: `Hi ${a.name || "there"},\n\n` } : null,
    }).catch((e) => console.error("[whatsapp-health] notify:", e?.message));
  }
}

async function recentFailures() {
  const since = new Date(Date.now() - FAIL_WINDOW_MS);
  const [failed, sent] = await Promise.all([
    WhatsAppMessage.countDocuments({ status: "failed", lastAttemptAt: { $gte: since } }),
    WhatsAppMessage.countDocuments({ status: "sent", sentAt: { $gte: since } }),
  ]);
  return { failed, sent };
}

export async function runWhatsappHealthOnce() {
  const session = await whatsappSessionStatus();
  const { failed, sent } = await recentFailures();

  // Failures only count against us when nothing at all is getting through;
  // a few bad numbers among successful sends is normal.
  const failingBlind = failed >= FAIL_THRESHOLD && sent === 0;
  const broken = !session.ok || session.status !== "WORKING" || failingBlind;
  const state = broken ? "broken" : "healthy";

  const reason = !session.ok
    ? `WAHA is unreachable (${session.error || session.status}).`
    : session.status !== "WORKING"
    ? `The WhatsApp session is "${session.status}" instead of WORKING.` +
      (session.status === "SCAN_QR_CODE"
        ? " It needs the QR code scanning again — most likely the linked phone stayed offline too long."
        : "")
    : failingBlind
    ? `The session reports WORKING but ${failed} message(s) failed in the last hour and none succeeded.`
    : "";

  const changed = state !== lastState;
  const stale = broken && Date.now() - lastNotifiedAt >= RENOTIFY_MS;

  if (broken && (changed || stale)) {
    await alertAdmins(
      "WhatsApp is not sending",
      `${reason} Reminders and booking confirmations are not going out. Push and email are unaffected.`
    );
    lastNotifiedAt = Date.now();
    console.error(`[whatsapp-health] BROKEN — ${reason}`);
  } else if (!broken && changed && lastState !== null) {
    // Only on recovery from a known-broken state, not on the first ever check.
    await alertAdmins(
      "WhatsApp is sending again",
      "The session is back to WORKING. Anything still queued will go out on its own."
    );
    console.log("[whatsapp-health] recovered");
  }

  lastState = state;
  return { state, status: session.status, failed, sent };
}

export function startWhatsappHealth() {
  if (process.env.WHATSAPP_ENABLED !== "true") return;
  const tick = () =>
    runWhatsappHealthOnce().catch((e) => console.error("[whatsapp-health] error:", e?.message));
  // Give the queue worker a moment to settle before the first check.
  setTimeout(tick, 60 * 1000);
  setInterval(tick, CHECK_MS);
  console.log(`[whatsapp-health] watching session every ${CHECK_MS / 60000} min`);
}
