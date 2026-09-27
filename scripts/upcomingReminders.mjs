// READ-ONLY view of who is due a reminder, and what each of them will actually
// receive. No writes, no sends.
//
// Worth being clear about which channel is which, because the three windows do
// NOT behave the same:
//
//   24h  in-app + push + email + WHATSAPP
//   12h  in-app + push + email        (no WhatsApp)
//    1h  in-app + push + email        (no WhatsApp)
//
// WhatsApp is on the 24-hour window alone, deliberately: three messages per
// appointment from one shared number reads as spam and burns the daily cap
// three times over.
//
// Usage (from dental-app-server):
//   node scripts/upcomingReminders.mjs          # next 24 hours
//   node scripts/upcomingReminders.mjs 48       # next 48 hours
//
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Appointment from "../models/Appointment.js";
// Imported for its side effect: populate("client"/"dentist") resolves the User
// model by name, so the schema has to be registered even though this file
// never references User directly.
import "../models/User.js";
import WhatsAppMessage from "../models/WhatsAppMessage.js";

const HOURS = Number(process.argv[2] || 24);
const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Karachi";

const fmt = (d) =>
  new Date(d).toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    hour12: true, timeZone: CLINIC_TZ,
  });

async function main() {
  await connectDB();
  const now = new Date();
  const until = new Date(now.getTime() + HOURS * 3600 * 1000);

  const due = await Appointment.find({
    status: "scheduled",
    date: { $gt: now, $lte: until },
  })
    .sort({ date: 1 })
    .populate("client", "name managed guardianName phoneE164")
    .populate("dentist", "name")
    .lean();

  console.log(`\nScheduled appointments in the next ${HOURS}h  (now ${fmt(now)}, ${CLINIC_TZ})\n`);
  if (!due.length) {
    console.log("  none — so no reminders are pending.\n");
    return;
  }

  // One query for every WhatsApp reminder already accounted for.
  const rows = await WhatsAppMessage.find({
    dedupeKey: { $in: due.map((a) => `appointment_reminder:${a._id}`) },
  })
    .select("dedupeKey status skipReason")
    .lean();
  const seen = new Map(rows.map((r) => [r.dedupeKey, r]));

  console.log(
    "  when".padEnd(18) + "in".padEnd(8) + "patient".padEnd(22) +
    "number".padEnd(16) + "dentist".padEnd(18) + "whatsapp"
  );
  console.log("  " + "-".repeat(100));

  let willSend = 0;
  for (const a of due) {
    const c = a.client;
    const hrs = (new Date(a.date) - now) / 3600000;
    const inCol = hrs < 1 ? "<1h" : `${hrs.toFixed(1)}h`;
    const who = c ? (c.managed ? `${c.name} (via guardian)` : c.name) : "(no client)";

    const row = seen.get(`appointment_reminder:${a._id}`);
    let wa;
    if (row) {
      wa = row.status === "skipped" ? `skipped: ${row.skipReason}` : row.status;
    } else if (!c?.phoneE164) {
      wa = "NO — no usable number";
    } else if (hrs > 24) {
      wa = "not yet (outside 24h)";
    } else {
      wa = "will send";
      willSend += 1;
    }

    console.log(
      "  " + fmt(a.date).padEnd(16) + inCol.padEnd(8) +
      who.slice(0, 21).padEnd(22) +
      (c?.phoneE164 || "—").padEnd(16) +
      `Dr. ${a.dentist?.name || "?"}`.slice(0, 17).padEnd(18) + wa
    );
  }

  const numbers = due
    .filter((a) => {
      const hrs = (new Date(a.date) - now) / 3600000;
      return a.client?.phoneE164 && hrs <= 24 && !seen.has(`appointment_reminder:${a._id}`);
    })
    .map((a) => a.client.phoneE164);
  if (numbers.length) {
    console.log("\n  numbers due a WhatsApp reminder:");
    for (const n of numbers) console.log(`    ${n}`);
  }

  console.log(`\n  ${due.length} appointment(s); ${willSend} WhatsApp reminder(s) still to queue.`);
  console.log("  All of them also get in-app, push and email at 24h, 12h and 1h;");
  console.log("  WhatsApp is the 24-hour window only.\n");
}

main()
  .catch((e) => { console.error("Failed:", e); process.exitCode = 1; })
  .finally(() => mongoose.connection.close().catch(() => {}));
