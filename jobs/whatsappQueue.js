import WhatsAppMessage from "../models/WhatsAppMessage.js";
import { driver } from "../utils/whatsapp/driver.js";
import { toChatId } from "../utils/phone.js";

// Drains the WhatsApp queue: one message at a time, slowly, forever.
//
// Everything about the pace here is about not getting the number banned.
// 30-60 seconds between sends is WAHA's own guidance — a floor, not a tuning
// knob — and it is randomised because a perfectly regular interval is itself a
// bot signature, arguably more incriminating than speed.

const MIN_GAP_MS = Number(process.env.WHATSAPP_MIN_GAP_MS || 30000);
const JITTER_MS = Number(process.env.WHATSAPP_JITTER_MS || 30000);
const DAILY_CAP = Number(process.env.WHATSAPP_DAILY_CAP || 50);
const IDLE_MS = Number(process.env.WHATSAPP_IDLE_MS || 15000); // nothing to do
const MAX_ATTEMPTS = Number(process.env.WHATSAPP_MAX_ATTEMPTS || 3);
// A row claimed longer ago than this belongs to a process that died mid-send.
const STUCK_MS = Number(process.env.WHATSAPP_STUCK_MS || 5 * 60 * 1000);

// Sends everything to one number instead of the real recipient. Staging must
// set this, or a test run messages real patients.
const TEST_TO = (process.env.WHATSAPP_TEST_TO || "").trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Put rows abandoned by a dead process back in the queue. Without this a
// restart mid-send leaves a message stuck in "sending" forever.
async function reclaimStuck() {
  const cutoff = new Date(Date.now() - STUCK_MS);
  const res = await WhatsAppMessage.updateMany(
    { status: "sending", claimedAt: { $lt: cutoff } },
    { $set: { status: "queued" }, $unset: { claimedAt: "" } }
  );
  if (res.modifiedCount) {
    console.warn(`[whatsapp] reclaimed ${res.modifiedCount} message(s) stuck mid-send`);
  }
}

// Take the next message atomically. Urgent first, then oldest — and the
// status flip to "sending" is what stops two ticks claiming the same row.
function claimNext() {
  return WhatsAppMessage.findOneAndUpdate(
    { status: "queued" },
    { $set: { status: "sending", claimedAt: new Date() }, $inc: { attempts: 1 } },
    { sort: { urgent: -1, createdAt: 1 }, new: true }
  );
}

async function usedInLast24h() {
  return WhatsAppMessage.countDocuments({
    status: { $in: ["sent", "delivered", "read"] },
    sentAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
}

let lastSentAt = 0;

async function processOne(row) {
  // Too late to be useful. A reminder that arrives after the appointment is
  // worse than no reminder at all.
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    await WhatsAppMessage.updateOne(
      { _id: row._id },
      { $set: { status: "skipped", skipReason: "expired" }, $unset: { claimedAt: "" } }
    );
    return false;
  }

  const cap = await usedInLast24h();
  if (cap >= DAILY_CAP) {
    // Back in the queue, not failed — the cap is a pause, not a rejection.
    await WhatsAppMessage.updateOne(
      { _id: row._id },
      { $set: { status: "queued" }, $inc: { attempts: -1 }, $unset: { claimedAt: "" } }
    );
    console.warn(`[whatsapp] 24h cap reached (${cap}/${DAILY_CAP}) — holding`);
    await sleep(60000);
    return false;
  }

  // Pace. Both urgent and normal traffic wait the same interval: jumping the
  // queue means going sooner, never faster.
  const gap = MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS);
  const wait = Math.max(0, lastSentAt + gap - Date.now());
  if (wait) await sleep(wait);
  lastSentAt = Date.now();

  // In test mode everything goes to one number and the body says so, so a
  // redirected message can never be mistaken for a real one.
  const to = TEST_TO || row.to;
  const text = TEST_TO ? `[TEST — intended for ${row.to}]\n\n${row.body}` : row.body;

  const result = await driver.sendText(toChatId(to), text);

  if (result.ok) {
    await WhatsAppMessage.updateOne(
      { _id: row._id },
      {
        $set: { status: "sent", sentAt: new Date(), providerId: result.id, lastAttemptAt: new Date() },
        $unset: { claimedAt: "", error: "" },
      }
    );
    return true;
  }

  // Out of attempts, or try again on a later tick.
  const giveUp = row.attempts >= MAX_ATTEMPTS;
  await WhatsAppMessage.updateOne(
    { _id: row._id },
    {
      $set: {
        status: giveUp ? "failed" : "queued",
        error: String(result.error).slice(0, 500),
        lastAttemptAt: new Date(),
      },
      $unset: { claimedAt: "" },
    }
  );
  console.error(
    `[whatsapp] send failed to ${to} (attempt ${row.attempts}/${MAX_ATTEMPTS})` +
      `${giveUp ? " — giving up" : " — will retry"}: ${result.error}`
  );
  return false;
}

// The worker loop. Runs for the life of the process.
async function loop() {
  await reclaimStuck().catch((e) => console.error("[whatsapp] reclaim:", e?.message));
  let sinceReclaim = 0;

  for (;;) {
    try {
      const row = await claimNext();
      if (!row) {
        await sleep(IDLE_MS);
        // Periodically sweep for rows a previous process abandoned.
        if ((sinceReclaim += IDLE_MS) >= STUCK_MS) {
          sinceReclaim = 0;
          await reclaimStuck().catch((e) => console.error("[whatsapp] reclaim:", e?.message));
        }
        continue;
      }
      await processOne(row);
    } catch (err) {
      // The loop must never die — a WhatsApp problem cannot be allowed to end
      // the only thing that will ever send the backlog.
      console.error("[whatsapp] worker:", err?.message || err);
      await sleep(IDLE_MS);
    }
  }
}

export function startWhatsappQueue() {
  if (process.env.WHATSAPP_ENABLED !== "true") {
    console.log("[whatsapp] queue worker not started (WHATSAPP_ENABLED is not true)");
    return;
  }
  console.log(
    `[whatsapp] queue worker started — gap ${MIN_GAP_MS / 1000}-${(MIN_GAP_MS + JITTER_MS) / 1000}s, ` +
      `cap ${DAILY_CAP}/24h, up to ${MAX_ATTEMPTS} attempts`
  );
  loop();
}
