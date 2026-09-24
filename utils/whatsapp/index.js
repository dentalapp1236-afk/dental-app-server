import WhatsAppMessage from "../../models/WhatsAppMessage.js";
import { toChatId } from "../phone.js";
import { renderTemplate } from "./templates.js";
import * as waha from "./waha.js";

// The one door every WhatsApp goes through. Callers never touch a driver.
//
// Shaped after utils/mailer.js: configured from the environment, announced at
// boot, and it NEVER throws — a WhatsApp failure must not take down the
// appointment that triggered it.
//
// Off unless WHATSAPP_ENABLED=true, so this whole feature ships dark and is
// switched on (or killed) with an environment variable and no deploy.

const driver = waha; // swap for a cloud.js driver once Meta approves us
const ENABLED = process.env.WHATSAPP_ENABLED === "true";

// Sends everything to one number instead of the real recipient. Staging must
// set this, or a test run messages real patients.
const TEST_TO = (process.env.WHATSAPP_TEST_TO || "").trim();

// Pacing. An unofficial session on a fresh number is fragile: a burst of 80
// reminders at 08:00 is close to a guaranteed ban. Sends are serialised with a
// randomised gap — randomised because a perfectly regular interval is itself a
// bot signature — and capped over a rolling 24 hours so a warm-up can be run by
// raising the cap gradually rather than by editing code.
const MIN_GAP_MS = Number(process.env.WHATSAPP_MIN_GAP_MS || 4000);
const JITTER_MS = Number(process.env.WHATSAPP_JITTER_MS || 4000);
const DAILY_CAP = Number(process.env.WHATSAPP_DAILY_CAP || 50);

export const whatsappConfigured = ENABLED && driver.configured;

console.log(
  `[whatsapp] enabled=${ENABLED} driver=${driver.driverName} configured=${driver.configured}` +
    (TEST_TO ? ` TEST MODE -> all messages go to ${TEST_TO}` : "") +
    (whatsappConfigured ? ` cap=${DAILY_CAP}/24h gap=${MIN_GAP_MS}-${MIN_GAP_MS + JITTER_MS}ms` : "")
);

// ---- serial queue with jittered pacing ----
let queue = Promise.resolve();
let lastSentAt = 0;

function schedule(fn) {
  const run = async () => {
    const gap = MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS);
    const wait = Math.max(0, lastSentAt + gap - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastSentAt = Date.now();
    return fn();
  };
  // Both handlers are `run`, so one failed send can't stall the queue behind it.
  queue = queue.then(run, run);
  return queue;
}

async function underDailyCap() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used = await WhatsAppMessage.countDocuments({
    status: { $in: ["sent", "delivered", "read"] },
    sentAt: { $gte: since },
  });
  return { ok: used < DAILY_CAP, used };
}

// A record of a message we chose NOT to send. No dedupeKey: these are evidence,
// not claims on the idempotency slot, so a patient who opts in later isn't
// permanently blocked by the row we wrote while they hadn't.
function logSkip(fields, reason) {
  return WhatsAppMessage.create({ ...fields, status: "skipped", skipReason: reason }).catch((e) =>
    console.error("[whatsapp] skip log:", e?.message)
  );
}

/**
 * Send one templated WhatsApp message.
 *
 * @param {object}  o
 * @param {object}  o.user       recipient — needs _id, phoneE164, whatsappOptIn
 * @param {string}  o.template   key in templates.js
 * @param {object}  o.values     template parameters
 * @param {string} [o.dedupeKey] e.g. "appointment_reminder:<apptId>" — uniquely
 *                               indexed, so a retry or a restart mid-send
 *                               cannot produce a second message
 * @param {string} [o.appointment] / @param {string} [o.invoice] for tracing
 * @returns {Promise<{sent: boolean, reason?: string}>} never rejects
 */
export async function sendWhatsApp({ user, template, values, dedupeKey, appointment, invoice }) {
  try {
    if (!ENABLED) return { sent: false, reason: "disabled" };

    let body;
    try {
      body = renderTemplate(template, values);
    } catch (e) {
      // A missing parameter is our bug, not the patient's problem — record it
      // loudly rather than posting "undefined" to someone.
      console.error("[whatsapp] template:", e?.message);
      return { sent: false, reason: "template_error" };
    }

    const base = {
      user: user?._id,
      template,
      params: values,
      body,
      appointment,
      invoice,
      to: user?.phoneE164 || "unknown",
    };

    if (!driver.configured) {
      console.warn(`[whatsapp] driver not configured — NOT sent to ${base.to}: ${body}`);
      return { sent: false, reason: "not_configured" };
    }
    if (!user?.phoneE164) {
      await logSkip(base, "no_number");
      return { sent: false, reason: "no_number" };
    }
    if (!user?.whatsappOptIn) {
      await logSkip(base, "not_opted_in");
      return { sent: false, reason: "not_opted_in" };
    }

    const cap = await underDailyCap();
    if (!cap.ok) {
      console.warn(`[whatsapp] 24h cap reached (${cap.used}/${DAILY_CAP}) — holding back ${template}`);
      await logSkip(base, "rate_limited");
      return { sent: false, reason: "rate_limited" };
    }

    // In test mode everything goes to one number, and the body says so, so a
    // redirected message can never be mistaken for a real one.
    const realTo = user.phoneE164;
    const to = TEST_TO || realTo;
    const text = TEST_TO ? `[TEST — intended for ${realTo}]\n\n${body}` : body;

    // Claim the idempotency slot BEFORE sending. If another run already holds
    // this dedupeKey the unique index rejects the insert and we stop here —
    // that is the whole guarantee against double-sending.
    let row;
    try {
      row = await WhatsAppMessage.create({ ...base, to, body: text, dedupeKey });
    } catch (e) {
      if (e?.code === 11000) return { sent: false, reason: "already_sent" };
      throw e;
    }

    const result = await schedule(() => driver.sendText(toChatId(to), text));

    if (result.ok) {
      await WhatsAppMessage.updateOne(
        { _id: row._id },
        { $set: { status: "sent", sentAt: new Date(), providerId: result.id } }
      );
      return { sent: true };
    }

    console.error(`[whatsapp] send failed to ${to}: ${result.error}`);
    await WhatsAppMessage.updateOne(
      { _id: row._id },
      { $set: { status: "failed", error: String(result.error).slice(0, 500) } }
    );
    return { sent: false, reason: "send_failed" };
  } catch (err) {
    // Belt and braces: nothing in here may ever reach the caller.
    console.error("[whatsapp] unexpected:", err?.message || err);
    return { sent: false, reason: "error" };
  }
}

// Is the session still alive? The way this fails in practice is silently.
export const whatsappSessionStatus = () => driver.sessionStatus();
