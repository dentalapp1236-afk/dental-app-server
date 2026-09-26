import WhatsAppMessage from "../../models/WhatsAppMessage.js";
import { toChatId } from "../phone.js";
import { renderTemplate, isUrgent } from "./templates.js";
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
// bot signature, arguably more incriminating than speed — and capped over a
// rolling 24 hours so a warm-up is run by raising the cap rather than editing
// code.
//
// 30-60 seconds is WAHA's own guidance and is the floor, not a tuning knob.
// Lower it and you are betting the number.
const MIN_GAP_MS = Number(process.env.WHATSAPP_MIN_GAP_MS || 30000);
const JITTER_MS = Number(process.env.WHATSAPP_JITTER_MS || 30000);
const DAILY_CAP = Number(process.env.WHATSAPP_DAILY_CAP || 50);

export const whatsappConfigured = ENABLED && driver.configured;

console.log(
  `[whatsapp] enabled=${ENABLED} driver=${driver.driverName} configured=${driver.configured}` +
    (TEST_TO ? ` TEST MODE -> all messages go to ${TEST_TO}` : "") +
    (whatsappConfigured
      ? ` cap=${DAILY_CAP}/24h gap=${MIN_GAP_MS / 1000}-${(MIN_GAP_MS + JITTER_MS) / 1000}s`
      : "")
);

// ---- serial queue with jittered pacing and two priorities ----
//
// At 30-60s a send, a batch of reminders owns the queue for a long time. A
// booking confirmation behind them would arrive after the patient has left the
// clinic, so anything a person is actively waiting on goes in the urgent lane
// and is taken first. Both lanes share the same pacing: jumping the queue
// never means sending faster.
const lanes = { urgent: [], normal: [] };
let draining = false;
let lastSentAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function schedule(fn, urgent) {
  return new Promise((resolve) => {
    lanes[urgent ? "urgent" : "normal"].push({ fn, resolve });
    drain();
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const task = lanes.urgent.shift() || lanes.normal.shift();
      if (!task) break;
      const gap = MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS);
      const wait = Math.max(0, lastSentAt + gap - Date.now());
      if (wait) await sleep(wait);
      lastSentAt = Date.now();
      let result;
      try {
        result = await task.fn();
      } catch (err) {
        // One failed send must not stall everything queued behind it.
        result = { ok: false, error: err?.message || String(err) };
      }
      task.resolve(result);
    }
  } finally {
    draining = false;
  }
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
 * @param {object}  o.user       recipient — needs _id and phoneE164
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

    const result = await schedule(() => driver.sendText(toChatId(to), text), isUrgent(template));

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
