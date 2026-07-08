/**
 * Seeds a realistic DEMO dentist practice for screenshots / pitch material.
 * Safe & idempotent: wipes only its own demo data (dentist + @patient.demo clients)
 * then recreates it. Run against STAGING only:
 *
 *   NODE_ENV=staging node seed/seedDemo.js
 *
 * Writes a manifest (ids + login) to seed/demo-manifest.json for the screenshot bot.
 */
import "../config/loadEnv.js";
import mongoose from "mongoose";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import Treatment from "../models/Treatment.js";
import Expense from "../models/Expense.js";
import Association from "../models/Association.js";
import Review from "../models/Review.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DENTIST_EMAIL = "dr.sarah.demo@dentalapp.test";
const DENTIST_PASSWORD = "DemoPass123";
const PATIENT_DOMAIN = "@patient.demo";
const STAFF_DOMAIN = "@staff.demo";

const day = 24 * 60 * 60 * 1000;
const at = (base, h, m = 0) => {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
};
const now = new Date();
const todayNoon = at(now, 12);

async function run() {
  await connectDB();
  console.log("Seeding demo practice…");

  // ---- Clean prior demo data --------------------------------------------
  const priorDentist = await User.findOne({ email: DENTIST_EMAIL });
  const priorPatients = await User.find({
    email: new RegExp(`(${PATIENT_DOMAIN}|${STAFF_DOMAIN})$`),
  }).select("_id");
  const priorPatientIds = priorPatients.map((p) => p._id);
  const cleanupDentistId = priorDentist?._id;
  if (cleanupDentistId) {
    await Promise.all([
      Appointment.deleteMany({ dentist: cleanupDentistId }),
      Treatment.deleteMany({ dentist: cleanupDentistId }),
      Expense.deleteMany({ dentist: cleanupDentistId }),
      Association.deleteMany({ dentist: cleanupDentistId }),
      Review.deleteMany({ dentist: cleanupDentistId }),
    ]);
  }
  if (priorPatientIds.length) await User.deleteMany({ _id: { $in: priorPatientIds } });

  // ---- Dentist -----------------------------------------------------------
  let dentist = priorDentist;
  if (!dentist) dentist = new User({ email: DENTIST_EMAIL, role: "dentist", password: DENTIST_PASSWORD });
  dentist.name = "Sarah Ahmed";
  dentist.password = DENTIST_PASSWORD; // re-hashed by pre-save
  dentist.role = "dentist";
  dentist.phone = "03001234567";
  dentist.clinicName = "Bright Smile Dental Studio";
  dentist.specialization = "Cosmetic & General Dentistry";
  dentist.yearsOfExperience = 12;
  dentist.about =
    "Bright Smile Dental Studio offers gentle, modern dental care — from routine check-ups and cleanings to cosmetic makeovers, root canals and crowns. We focus on painless treatment and clear, honest pricing.";
  dentist.location = { type: "Point", coordinates: [67.0299, 24.8615] }; // Karachi
  dentist.availability = [
    { day: "Mon", start: "09:00", end: "17:00" },
    { day: "Tue", start: "09:00", end: "17:00" },
    { day: "Wed", start: "09:00", end: "17:00" },
    { day: "Thu", start: "09:00", end: "17:00" },
    { day: "Fri", start: "09:00", end: "13:00" },
    { day: "Sat", start: "10:00", end: "15:00" },
  ];
  await dentist.save();

  // ---- Patients ----------------------------------------------------------
  const patientDefs = [
    { name: "Ayesha Khan", phone: "03111000001", dob: "1991-04-12", notes: "Sensitive to cold. Mild dental anxiety." },
    { name: "Bilal Siddiqui", phone: "03111000002", dob: "1985-09-30", notes: "Grinds teeth at night (bruxism)." },
    { name: "Fatima Noor", phone: "03111000003", dob: "1997-01-22", notes: "Ortho candidate — mild crowding." },
    { name: "Hamza Sheikh", phone: "03111000004", dob: "1979-11-05", notes: "Hypertension — check before adrenaline." },
    { name: "Zara Malik", phone: "03111000005", dob: "2002-07-18", notes: "" },
    { name: "Usman Tariq", phone: "03111000006", dob: "1968-03-02", notes: "Partial denture, upper left." },
    { name: "Sana Javed", phone: "03111000007", dob: "1994-12-11", notes: "" },
  ];
  const patients = [];
  for (let i = 0; i < patientDefs.length; i++) {
    const p = patientDefs[i];
    const u = new User({
      name: p.name,
      email: `patient${i + 1}${PATIENT_DOMAIN}`,
      phone: p.phone,
      password: "Patient123",
      role: "client",
      dateOfBirth: new Date(p.dob),
      medicalNotes: p.notes,
      dentist: dentist._id,
    });
    await u.save();
    patients.push(u);
    await Association.create({
      client: u._id,
      dentist: dentist._id,
      status: "approved",
      initiatedBy: "dentist",
      respondedAt: new Date(),
    });
  }

  // ---- Staff (assistants) ------------------------------------------------
  const staffDefs = [
    { name: "Nadia Aslam", phone: "03221000001" },
    { name: "Imran Baig", phone: "03221000002" },
  ];
  for (let i = 0; i < staffDefs.length; i++) {
    const s = staffDefs[i];
    await new User({
      name: s.name,
      email: `staff${i + 1}${STAFF_DOMAIN}`,
      phone: s.phone,
      password: "Staff123!",
      role: "assistant",
      dentist: dentist._id,
    }).save();
  }

  // ---- Appointments ------------------------------------------------------
  const appts = [];
  const mk = (client, date, reason, status) => appts.push({ dentist: dentist._id, client, date, reason, status });
  // Today's schedule
  mk(patients[0]._id, at(now, 9, 30), "Routine check-up & cleaning", "scheduled");
  mk(patients[1]._id, at(now, 10, 30), "Night-guard fitting", "scheduled");
  mk(patients[2]._id, at(now, 12, 0), "Consultation — braces", "scheduled");
  mk(patients[4]._id, at(now, 14, 0), "Filling — upper right", "scheduled");
  mk(patients[6]._id, at(now, 15, 30), "Whitening session", "pending");
  // Upcoming
  mk(patients[3]._id, at(new Date(now.getTime() + day), 11, 0), "Crown fitting", "scheduled");
  mk(patients[5]._id, at(new Date(now.getTime() + 2 * day), 13, 0), "Denture adjustment", "scheduled");
  // Past (completed) — will get treatments
  mk(patients[0]._id, at(new Date(now.getTime() - 6 * day), 10, 0), "Root canal — molar", "completed");
  mk(patients[1]._id, at(new Date(now.getTime() - 9 * day), 11, 30), "Scaling & polishing", "completed");
  mk(patients[3]._id, at(new Date(now.getTime() - 14 * day), 15, 0), "Composite filling", "completed");
  mk(patients[5]._id, at(new Date(now.getTime() - 20 * day), 12, 0), "Extraction — wisdom tooth", "completed");
  mk(patients[2]._id, at(new Date(now.getTime() - 3 * day), 16, 0), "Missed appointment", "no_show");
  const createdAppts = await Appointment.insertMany(appts);
  const completed = createdAppts.filter((a) => a.status === "completed");

  // ---- Treatments (with payments -> ledger) ------------------------------
  const treatmentDefs = [
    { appt: completed[0], procedure: "Root Canal Treatment", tooth: "36", cost: 25000, pay: [{ amount: 10000, method: "cash" }, { amount: 8000, method: "online" }], diagnosis: "Irreversible pulpitis", followUp: true },
    { appt: completed[1], procedure: "Scaling & Polishing", tooth: "Full mouth", cost: 6000, pay: [{ amount: 6000, method: "cash" }], diagnosis: "Generalized calculus" },
    { appt: completed[2], procedure: "Composite Filling", tooth: "16", cost: 4500, pay: [{ amount: 2000, method: "online" }], diagnosis: "Class II caries" },
    { appt: completed[3], procedure: "Surgical Extraction", tooth: "48", cost: 12000, pay: [{ amount: 12000, method: "cash" }], diagnosis: "Impacted wisdom tooth" },
  ];
  for (const t of treatmentDefs) {
    const payments = t.pay.map((p, idx) => ({
      amount: p.amount,
      method: p.method,
      date: new Date(t.appt.date.getTime() + idx * day),
      note: idx === 0 ? "Deposit" : "Visit payment",
    }));
    const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
    await Treatment.create({
      dentist: dentist._id,
      client: t.appt.client,
      appointment: t.appt._id,
      procedure: t.procedure,
      toothNumber: t.tooth,
      diagnosis: t.diagnosis,
      description: `${t.procedure} completed. Post-op instructions given.`,
      cost: t.cost,
      payments,
      paid: paidTotal >= t.cost,
      date: t.appt.date,
      followUps: t.followUp ? [{ message: "Slight sensitivity when chewing — is that normal?", status: "open" }] : [],
    });
  }

  // ---- Expenses ----------------------------------------------------------
  await Expense.insertMany([
    { dentist: dentist._id, title: "Autoclave annual servicing", category: "Equipment", amount: 15000, date: new Date(now.getTime() - 5 * day), notes: "Sterilizer maintenance + gasket replacement" },
    { dentist: dentist._id, title: "Dental consumables restock", category: "Supplies", amount: 22000, date: new Date(now.getTime() - 8 * day), notes: "Gloves, masks, composite, anaesthetic" },
    { dentist: dentist._id, title: "Air compressor repair", category: "Maintenance", amount: 9500, date: new Date(now.getTime() - 12 * day) },
    { dentist: dentist._id, title: "Electricity bill", category: "Utilities", amount: 18000, date: new Date(now.getTime() - 15 * day) },
    { dentist: dentist._id, title: "X-ray sensor calibration", category: "Equipment", amount: 7000, date: new Date(now.getTime() - 25 * day) },
  ]);

  // ---- Reviews -----------------------------------------------------------
  const reviewDefs = [
    { client: patients[0], rating: 5, comment: "Painless root canal and very reassuring. Highly recommend!" },
    { client: patients[1], rating: 5, comment: "Clean clinic, on-time, and clear about costs." },
    { client: patients[3], rating: 4, comment: "Great extraction experience, minimal swelling after." },
    { client: patients[5], rating: 5, comment: "Dr. Sarah is gentle and thorough. Booking on the app is so easy." },
  ];
  for (const r of reviewDefs) {
    await Review.create({ dentist: dentist._id, client: r.client._id, rating: r.rating, comment: r.comment });
  }
  const avg = reviewDefs.reduce((s, r) => s + r.rating, 0) / reviewDefs.length;
  dentist.rating = Math.round(avg * 10) / 10;
  dentist.reviewCount = reviewDefs.length;
  await dentist.save();

  // ---- Manifest for the screenshot bot -----------------------------------
  const manifest = {
    login: { identifier: DENTIST_EMAIL, password: DENTIST_PASSWORD },
    dentistId: String(dentist._id),
    sampleClientId: String(patients[0]._id),
    counts: { patients: patients.length, appointments: createdAppts.length, treatments: treatmentDefs.length, expenses: 5, reviews: reviewDefs.length },
  };
  writeFileSync(resolve(__dirname, "demo-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("Demo seed complete:", manifest.counts);
  console.log("Login:", DENTIST_EMAIL, "/", DENTIST_PASSWORD);
  await mongoose.connection.close();
}

run().catch(async (e) => {
  console.error("Seed failed:", e);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});
