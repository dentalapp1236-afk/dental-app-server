import mongoose from "mongoose";

// One monthly subscription invoice for a clinic (dentist). Generated on the 5th
// of each billing month, due on the 15th. Admin marks it paid once the dentist
// settles; the dentist sees the status in their Invoices tab.
const invoiceSchema = new mongoose.Schema(
  {
    dentist: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    month: { type: String, required: true }, // billing month, "YYYY-MM" (e.g. "2026-08")
    amount: { type: Number, required: true },
    currency: { type: String, default: "PKR" },
    issueDate: { type: Date, required: true }, // 5th of the month
    dueDate: { type: Date, required: true }, // 15th of the month
    status: { type: String, enum: ["unpaid", "paid"], default: "unpaid" },
    paidAt: { type: Date },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // admin who marked it paid
    note: { type: String, trim: true },

    // Reminder gating, mirroring the pattern used for appointment reminders
    // (remind24hSent etc.) — so the due-date watcher never re-sends the same
    // nudge on every run.
    dueSoonNotifiedAt: { type: Date }, // "due in a few days" reminder, sent once
    lastOverdueNotifiedAt: { type: Date }, // last "still unpaid, past due" nudge
  },
  { timestamps: true }
);

// One invoice per clinic per month — makes generation safely idempotent.
invoiceSchema.index({ dentist: 1, month: 1 }, { unique: true });

export default mongoose.model("Invoice", invoiceSchema);
