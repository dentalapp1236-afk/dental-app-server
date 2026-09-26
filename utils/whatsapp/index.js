import WhatsAppMessage from "../../models/WhatsAppMessage.js";
import { renderTemplate, isUrgent } from "./templates.js";
import { driver } from "./driver.js";

// The one door every WhatsApp goes through — and it only ever ENQUEUES.
//
// Nothing is sent from here. sendWhatsApp writes a row and returns
// immediately; jobs/whatsappQueue.js picks it up, paces it and sends it. That
// split is deliberate:
//
//   - The queue survives a restart. It used to live in memory, so a deploy
//     mid-drain silently lost every pending reminder while the appointment
//     flags were already marked sent.
//   - Callers never wait. At 30-60 seconds a send, an in-process queue meant a
//     booking request could have been held open for half an hour.
//   - Every message has a row from the moment it is asked for, so "who was
//     messaged, when, and what happened to it" is answerable for the whole
//     lifecycle rather than only after a successful send.
//
// Off unless WHATSAPP_ENABLED=true, so the feature ships dark and is switched
// on (or killed) with an environment variable and no deploy.

const ENABLED = process.env.WHATSAPP_ENABLED === "true";

export const whatsappConfigured = ENABLED && driver.configured;

console.log(
  `[whatsapp] enabled=${ENABLED} driver=${driver.driverName} configured=${driver.configured}` +
    (process.env.WHATSAPP_TEST_TO ? ` TEST MODE -> ${process.env.WHATSAPP_TEST_TO}` : "")
);

// Mongoose builds indexes in the background, so on a cold start there is a
// window where the unique dedupeKey index does not exist yet and two
// enqueues of the same message would BOTH be accepted. The whole
// no-double-sending guarantee rests on that index, so wait for it once
// before the first enqueue rather than assume it is there.
const indexesReady = WhatsAppMessage.init().catch((e) =>
  console.error("[whatsapp] index build failed — dedupe is NOT guaranteed:", e?.message)
);

// A record of a message we chose not to send at all. No dedupeKey: these are
// evidence, not claims on the idempotency slot.
function logSkip(fields, reason) {
  return WhatsAppMessage.create({ ...fields, status: "skipped", skipReason: reason }).catch((e) =>
    console.error("[whatsapp] skip log:", e?.message)
  );
}

/**
 * Queue one templated WhatsApp message. Returns as soon as the row is written.
 *
 * @param {object}   o
 * @param {object}   o.user        recipient — needs _id and phoneE164
 * @param {string}   o.template    key in templates.js
 * @param {object}   o.values      template parameters
 * @param {string}  [o.dedupeKey]  uniquely indexed, so a retry or a restart
 *                                 cannot produce a second message
 * @param {Date}    [o.expiresAt]  don't send after this — a reminder that
 *                                 lands past the appointment is worse than none
 * @returns {Promise<{queued: boolean, reason?: string}>} never rejects
 */
export async function sendWhatsApp({
  user,
  template,
  values,
  dedupeKey,
  appointment,
  invoice,
  expiresAt,
}) {
  try {
    if (!ENABLED) return { queued: false, reason: "disabled" };
    await indexesReady;

    let body;
    try {
      body = renderTemplate(template, values);
    } catch (e) {
      // A missing parameter is our bug, not the patient's problem — fail loudly
      // rather than posting "undefined" to someone.
      console.error("[whatsapp] template:", e?.message);
      return { queued: false, reason: "template_error" };
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
      console.warn(`[whatsapp] driver not configured — NOT queued for ${base.to}: ${body}`);
      return { queued: false, reason: "not_configured" };
    }
    if (!user?.phoneE164) {
      await logSkip(base, "no_number");
      return { queued: false, reason: "no_number" };
    }

    // Claim the idempotency slot at enqueue time. If another run already holds
    // this dedupeKey the unique index rejects the insert and we stop here —
    // that is the whole guarantee against double-sending.
    try {
      await WhatsAppMessage.create({
        ...base,
        status: "queued",
        urgent: isUrgent(template),
        expiresAt,
        dedupeKey,
      });
    } catch (e) {
      if (e?.code === 11000) return { queued: false, reason: "already_queued" };
      throw e;
    }
    return { queued: true };
  } catch (err) {
    // Belt and braces: nothing in here may ever reach the caller.
    console.error("[whatsapp] unexpected:", err?.message || err);
    return { queued: false, reason: "error" };
  }
}

// Is the session still alive? The way this fails in practice is silently.
export const whatsappSessionStatus = () => driver.sessionStatus();
