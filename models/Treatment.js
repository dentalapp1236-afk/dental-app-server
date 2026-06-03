import mongoose from "mongoose";

const treatmentSchema = new mongoose.Schema(
  {
    dentist: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment" },
    procedure: { type: String, required: true, trim: true },
    toothNumber: { type: String },
    diagnosis: { type: String },
    description: { type: String },
    cost: { type: Number, default: 0 },
    paid: { type: Boolean, default: false },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model("Treatment", treatmentSchema);
