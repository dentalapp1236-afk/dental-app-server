import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema(
  {
    dentist: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: Date, required: true },
    reason: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["pending", "scheduled", "completed", "cancelled", "no_show"],
      default: "scheduled",
    },
    notes: { type: String },
    // Patient travel status on the day (notifies the dentist).
    arrivalStatus: {
      type: String,
      enum: ["none", "on_the_way", "arrived"],
      default: "none",
    },
    // One-time reminder flags, reset whenever the appointment is (re)scheduled.
    remind24hSent: { type: Boolean, default: false }, // ~24h-before reminder sent
    remind12hSent: { type: Boolean, default: false }, // ~12h-before reminder sent
    remind1hSent: { type: Boolean, default: false }, // ~1h-before reminder sent
  },
  { timestamps: true }
);

export default mongoose.model("Appointment", appointmentSchema);
