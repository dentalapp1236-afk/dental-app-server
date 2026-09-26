// End-to-end check of the WAHA connection, before any of it is pointed at a
// patient. Talks to the driver directly, so it deliberately bypasses the
// opt-in and rate-limit guards in utils/whatsapp/index.js — this is you,
// messaging your own number, to prove the plumbing works.
//
// Usage (from dental-app-server, with WAHA_URL / WAHA_API_KEY set):
//   node scripts/whatsappTest.mjs                              # session status only
//   node scripts/whatsappTest.mjs +923001234567                # reminder (default)
//   node scripts/whatsappTest.mjs +923001234567 <template>     # any template
//
// Templates: appointment_confirmed, appointment_reminder,
//            appointment_rescheduled, invoice_due
//
import "dotenv/config";
import { sendText, sessionStatus, configured } from "../utils/whatsapp/waha.js";
import { toE164, toChatId } from "../utils/phone.js";
import { renderTemplate } from "../utils/whatsapp/templates.js";

const target = process.argv[2];
const template = process.argv[3] || "appointment_reminder";

// Dates formatted exactly as the jobs and routes format them, so what arrives
// on your phone is the wording a patient would actually get — not an
// approximation of it.
const fmtWhen = (d) =>
  new Date(d).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: process.env.CLINIC_TZ || "Asia/Karachi",
  });
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: process.env.CLINIC_TZ || "Asia/Karachi",
  });

const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

const SAMPLES = {
  appointment_confirmed: {
    patientName: "there",
    clinicName: "Bright Smile Dental (TEST)",
    when: fmtWhen(tomorrow),
  },
  appointment_reminder: {
    patientName: "there",
    clinicName: "Bright Smile Dental (TEST)",
    when: fmtWhen(tomorrow),
  },
  appointment_rescheduled: {
    patientName: "there",
    clinicName: "Bright Smile Dental (TEST)",
    when: fmtWhen(tomorrow),
  },
  invoice_due: {
    dentistName: "Dr Ahmad Shamim",
    amount: "PKR 3,000",
    month: "September 2026",
    dueDate: fmtDate(tomorrow),
  },
};

async function main() {
  console.log(`\nWAHA_URL     : ${process.env.WAHA_URL || "(not set)"}`);
  console.log(`WAHA_SESSION : ${process.env.WAHA_SESSION || "default"}`);
  console.log(`API key      : ${process.env.WAHA_API_KEY ? "set" : "NOT SET"}`);
  if (!configured) {
    console.error("\nWAHA_URL and WAHA_API_KEY must both be set. Nothing to test.\n");
    process.exit(1);
  }

  const status = await sessionStatus();
  console.log(`\nSession      : ${status.status}${status.engine ? ` (engine ${status.engine})` : ""}`);
  if (status.error) console.log(`               ${status.error}`);
  if (status.status !== "WORKING") {
    console.error(
      "\nThe session isn't WORKING. Open the WAHA dashboard and pair the number" +
        "\n(SCAN_QR_CODE means it needs a scan; STOPPED means it needs starting).\n"
    );
    process.exit(1);
  }

  if (!target) {
    console.log("\nSession is healthy. Pass a phone number to send a test message.\n");
    return;
  }

  const e164 = toE164(target);
  if (!e164) {
    console.error(`\n"${target}" isn't a reachable Pakistani mobile. Nothing sent.\n`);
    process.exit(1);
  }

  const values = SAMPLES[template];
  if (!values) {
    console.error(
      `\nUnknown template "${template}". Available: ${Object.keys(SAMPLES).join(", ")}\n`
    );
    process.exit(1);
  }
  const body = renderTemplate(template, values);

  console.log(`\nTemplate    : ${template}`);
  console.log(`\nSending to ${e164} (${toChatId(e164)}):\n\n${body}\n`);
  const result = await sendText(toChatId(e164), body);
  console.log(result.ok ? `Sent. id=${result.id}\n` : `FAILED: ${result.error}\n`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
