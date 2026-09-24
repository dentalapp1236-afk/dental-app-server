// End-to-end check of the WAHA connection, before any of it is pointed at a
// patient. Talks to the driver directly, so it deliberately bypasses the
// opt-in and rate-limit guards in utils/whatsapp/index.js — this is you,
// messaging your own number, to prove the plumbing works.
//
// Usage (from dental-app-server, with WAHA_URL / WAHA_API_KEY set):
//   node scripts/whatsappTest.mjs                      # session status only
//   node scripts/whatsappTest.mjs +923001234567        # status, then one message
//
import "dotenv/config";
import { sendText, sessionStatus, configured } from "../utils/whatsapp/waha.js";
import { toE164, toChatId } from "../utils/phone.js";
import { renderTemplate } from "../utils/whatsapp/templates.js";

const target = process.argv[2];

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

  // A real template, so this exercises the same path production will.
  const body = renderTemplate("appointment_reminder", {
    patientName: "there",
    clinicName: "Bright Smile Dental (TEST)",
    when: "tomorrow at 4:00 PM",
    clinicPhone: "0319 0041011",
  });

  console.log(`\nSending to ${e164} (${toChatId(e164)}):\n\n${body}\n`);
  const result = await sendText(toChatId(e164), body);
  console.log(result.ok ? `Sent. id=${result.id}\n` : `FAILED: ${result.error}\n`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
