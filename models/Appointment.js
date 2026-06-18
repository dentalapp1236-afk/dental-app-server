import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema(
  {
    dentist: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: Date, required: true },
    reason: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["scheduled", "completed", "cancelled"],
      default: "scheduled",
    },
    notes: { type: String },
    reminderSent: { type: Boolean, default: false }, // 24h reminder dispatched
  },
  { timestamps: true }
);

export default mongoose.model("Appointment", appointmentSchema);
