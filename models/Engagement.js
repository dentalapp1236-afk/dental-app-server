import mongoose from "mongoose";

// An employment link between a (self-owned) assistant and a dentist's clinic.
// An assistant can hold several `active` engagements at once (working for two
// dentists) and switch between them without logging out; `ended` engagements
// form their work history. Mirrors the client<->dentist Association pattern.
const engagementSchema = new mongoose.Schema(
  {
    assistant: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    dentist: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "active", "ended"],
      default: "pending",
    },
    initiatedBy: { type: String, enum: ["assistant", "dentist"], required: true },
    startedAt: { type: Date }, // set when it becomes active
    endedAt: { type: Date }, // set when it ends
    title: { type: String, trim: true }, // optional role label, e.g. "Dental assistant"
  },
  { timestamps: true }
);

engagementSchema.index({ assistant: 1, status: 1 });
engagementSchema.index({ dentist: 1, status: 1 });
// At most one live (pending or active) engagement per assistant+dentist pair.
engagementSchema.index(
  { assistant: 1, dentist: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["pending", "active"] } } }
);

export default mongoose.model("Engagement", engagementSchema);
