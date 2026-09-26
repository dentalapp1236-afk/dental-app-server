// READ-ONLY preview of the four WhatsApp messages, rendered with real data.
//
// No writes, no sends, no calls to WAHA — it only reads and prints, so it is
// safe to point at production. Use it to check the wording before go-live, and
// afterwards whenever a template changes.
//
// Patients are told the DENTIST's name, not the clinic's — an appointment is
// with a person. Nothing here depends on a profile field the dentist might
// have left blank.
//
// Usage (from dental-app-server):
//   node scripts/previewWhatsapp.mjs                 # first dentist found
//   node scripts/previewWhatsapp.mjs "ahmad shamim"  # match a dentist by name
//
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import { renderTemplate } from "../utils/whatsapp/templates.js";

const nameArg = process.argv[2];
const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Karachi";

const fmtWhen = (d) =>
  new Date(d).toLocaleString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: CLINIC_TZ,
  });
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: CLINIC_TZ,
  });
const monthLabel = (ym) => {
  const [y, m] = String(ym).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
};

async function main() {
  await connectDB();

  const filter = { role: "dentist" };
  if (nameArg) filter.name = new RegExp(nameArg.replace(/\s+/g, "\\s*"), "i");
  const dentist = await User.findOne(filter).select("name").lean();
  if (!dentist) {
    console.log(`\nNo dentist${nameArg ? ` matching "${nameArg}"` : ""} found.\n`);
    return;
  }

  console.log(`\nDentist    : Dr. ${dentist.name}`);

  // Prefer a real upcoming appointment so the date is genuine.
  const appt = await Appointment.findOne({
    dentist: dentist._id, status: "scheduled", date: { $gt: new Date() },
  })
    .sort({ date: 1 })
    .populate("client", "name managed guardianName phoneE164")
    .lean();

  let patient = appt?.client;
  let when = appt ? fmtWhen(appt.date) : fmtWhen(new Date(Date.now() + 86400000));
  if (!patient) {
    patient = await User.findOne({ role: "client", dentist: dentist._id })
      .select("name managed guardianName phoneE164")
      .lean();
  }
  if (!patient) {
    console.log("\nThis dentist has no patients yet.\n");
    return;
  }

  console.log(
    `Patient    : ${patient.name}${patient.managed ? " (dependent — the guardian is messaged)" : ""}`
  );
  console.log(
    `reachable  : ${patient.phoneE164 ? `yes (${patient.phoneE164})` : "NO — phoneE164 unset, this patient would be skipped"}`
  );
  console.log(`appointment: ${appt ? `real, ${when}` : "none upcoming — using tomorrow for the preview"}`);

  const v = {
    patientName: patient.managed ? patient.guardianName || patient.name : patient.name,
    dentistName: `Dr. ${dentist.name}`,
    when,
  };

  const show = (title, template, values) => {
    const body = renderTemplate(template, values);
    console.log(`\n${"=".repeat(64)}\n${title}   (${body.length} chars)\n${"=".repeat(64)}\n${body}`);
  };

  show("1. ON BOOKING", "appointment_confirmed", v);
  show("2. 24 HOURS BEFORE", "appointment_reminder", v);
  show("3. WHEN THE TIME CHANGES", "appointment_rescheduled", v);
  show("4. INVOICE DUE (to the dentist, not a patient)", "invoice_due", {
    dentistName: `Dr. ${dentist.name}`,
    amount: "PKR 3,000",
    month: monthLabel(new Date().toISOString().slice(0, 7)),
    dueDate: fmtDate(new Date()),
  });

  console.log(`\n${"=".repeat(64)}\nNothing was written or sent.\n`);
}

main()
  .catch((e) => { console.error("Preview failed:", e); process.exitCode = 1; })
  .finally(() => mongoose.connection.close().catch(() => {}));
