import mongoose from "mongoose";

// Every WhatsApp we attempt, successful or not. This is not a nice-to-have:
//
//  - It is the idempotency guard. `dedupeKey` is uniquely indexed, so a retry,
//    a concurrent job run or a server restart mid-send cannot produce a second
//    message to the same patient. The database refuses it.
//  - It is how we notice the session has quietly died — a run of failures with
//    nothing delivered.
//  - It answers "what exactly did the system send this patient, and when?",
//    which is the same question the audit trail exists to answer for deletions.
//
// `body` stores the rendered text rather than only the parameters, because when
// a patient disputes what they were told, the template may since have changed.
const whatsappMessageSchema = new mongoose.Schema(
  {
    // Recipient. `user` may be absent for a one-off/system send.
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    to: { type: String, required: true }, // E.164, e.g. "+923001234567"

    // Which template, and what was substituted into it.
    template: { type: String, required: true, index: true },
    params: { type: Object },
    body: { type: String, required: true }, // exactly what was sent

    // Idempotency. Composed by the caller, e.g. "appointment_reminder:<apptId>".
    // Sparse so ad-hoc sends without one are still allowed.
    dedupeKey: { type: String, unique: true, sparse: true },

    // Lifecycle: queued -> sending -> sent -> delivered -> read, or failed.
    // "sending" exists so a row can be claimed atomically by the worker; two
    // ticks can never pick up the same message.
    status: {
      type: String,
      enum: ["queued", "sending", "sent", "delivered", "read", "failed", "skipped"],
      default: "queued",
      index: true,
    },

    // Someone is actively waiting on this one (a booking confirmation), so it
    // goes ahead of the batch traffic. At 30-60s a send, a reminder run owns
    // the queue for half an hour.
    urgent: { type: Boolean, default: false },

    // Retry accounting. A WAHA hiccup or a dropped socket should not cost a
    // patient their reminder, but nor should a permanently bad number be
    // retried forever.
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date },
    // Set when the worker claims the row; used to reclaim rows abandoned by a
    // process that died mid-send.
    claimedAt: { type: Date },

    // Past this, sending does more harm than good — a reminder that lands
    // after the appointment is worse than no reminder. Left unset for
    // messages that never go stale.
    expiresAt: { type: Date },
    // Why we chose not to send: "no_number", "disabled", "rate_limited".
    // Recorded rather than silently dropped, so a dentist
    // asking "why didn't my patient get it?" has an answer.
    skipReason: { type: String },
    error: { type: String },

    providerId: { type: String, index: true }, // WAHA/WhatsApp message id
    sentAt: { type: Date },
    deliveredAt: { type: Date },

    // What this message was about, for tracing back from the send log.
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment" },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" },
  },
  { timestamps: true }
);

// The dashboard reads newest-first, usually filtered by how it went.
whatsappMessageSchema.index({ createdAt: -1 });
whatsappMessageSchema.index({ status: 1, createdAt: -1 });
// The worker's claim query: pending work, urgent first, then oldest.
whatsappMessageSchema.index({ status: 1, urgent: -1, createdAt: 1 });

export default mongoose.model("WhatsAppMessage", whatsappMessageSchema);
