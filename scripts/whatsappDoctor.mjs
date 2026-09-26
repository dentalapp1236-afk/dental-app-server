// READ-ONLY diagnosis of "why didn't that WhatsApp go out?".
//
// Checks, in the order things actually fail:
//   1. Is the feature switched on and pointed at a WAHA instance?
//   2. Is the WhatsApp session alive?
//   3. What does the send log say — was a row even created?
//   4. For a named patient: is their number in a form we can send to?
//
// No writes, no sends. Safe against production.
//
// Usage (from dental-app-server):
//   node scripts/whatsappDoctor.mjs
//   node scripts/whatsappDoctor.mjs "haseeb"     # also check one patient
//
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import WhatsAppMessage from "../models/WhatsAppMessage.js";
import { whatsappSessionStatus } from "../utils/whatsapp/index.js";
import { toE164 } from "../utils/phone.js";

const who = process.argv[2];
const yn = (b) => (b ? "yes" : "NO");

async function main() {
  await connectDB();

  console.log("\n1. CONFIGURATION (of THIS shell, not the Render service)");
  const enabled = process.env.WHATSAPP_ENABLED === "true";
  console.log(`   WHATSAPP_ENABLED=true : ${yn(enabled)}`);
  console.log(`   WAHA_URL set          : ${yn(!!process.env.WAHA_URL)}  ${process.env.WAHA_URL || ""}`);
  console.log(`   WAHA_API_KEY set      : ${yn(!!process.env.WAHA_API_KEY)}`);
  console.log(`   WAHA_SESSION          : ${process.env.WAHA_SESSION || "default (not set)"}`);
  console.log(`   WHATSAPP_TEST_TO      : ${process.env.WHATSAPP_TEST_TO || "(none — sends to real numbers)"}`);
  if (!enabled) {
    console.log(
      "\n   >> These are the variables in YOUR shell. Run locally they will read" +
        "\n      NO even when Render has them set, because they live in the Render" +
        "\n      dashboard and not in .env.production. Section 3 is what tells you" +
        "\n      whether the deployed service is actually sending."
    );
  }

  console.log("\n2. SESSION");
  if (process.env.WAHA_URL && process.env.WAHA_API_KEY) {
    const s = await whatsappSessionStatus();
    console.log(`   status: ${s.status}${s.error ? ` — ${s.error}` : ""}`);
    if (s.status !== "WORKING") {
      console.log("   >> Not WORKING. SCAN_QR_CODE means it needs re-pairing in the WAHA dashboard.");
    }
  } else {
    console.log("   skipped — WAHA is not configured");
  }

  console.log("\n3. SEND LOG");
  const total = await WhatsAppMessage.countDocuments();
  if (!total) {
    console.log("   No rows at all. Nothing has even been QUEUED, which means either the");
    console.log("   feature is off, or no event that sends WhatsApp has happened since deploy.");
    console.log("   (Note: cancelling an appointment sends nothing — there is no template for it.)");
  } else {
    const byStatus = await WhatsAppMessage.aggregate([
      { $group: { _id: { s: "$status", r: "$skipReason" }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    for (const g of byStatus) {
      console.log(`   ${String(g._id.s).padEnd(9)} ${String(g._id.r || "").padEnd(14)} ${g.n}`);
    }
    console.log("\n   most recent 10:");
    const recent = await WhatsAppMessage.find().sort({ createdAt: -1 }).limit(10).lean();
    for (const m of recent) {
      console.log(
        `   ${new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ")}  ` +
          `${m.template.padEnd(24)} ${m.status.padEnd(9)} ${m.skipReason || m.error?.slice(0, 40) || ""}`
      );
    }
  }

  if (who) {
    console.log(`\n4. PATIENT MATCHING "${who}"`);
    const users = await User.find({ name: new RegExp(who.replace(/\s+/g, "\\s*"), "i") })
      .select("name role phone guardianPhone managed phoneE164")
      .limit(5)
      .lean();
    if (!users.length) console.log("   no match");
    for (const u of users) {
      const raw = u.managed ? u.guardianPhone : u.phone;
      const would = toE164(raw);
      console.log(`   ${u.name} (${u.managed ? "dependent" : u.role})`);
      console.log(`     stored number : ${raw || "(none)"}`);
      console.log(`     phoneE164     : ${u.phoneE164 || "NOT SET — this patient is skipped as no_number"}`);
      if (!u.phoneE164 && would) {
        console.log(`     >> would normalise to ${would}. Run scripts/backfillPhoneE164.mjs --apply`);
      } else if (!would && raw) {
        console.log(`     >> "${raw}" is not a reachable Pakistani mobile — cannot be messaged`);
      }
    }
  }
  console.log("\nNothing was written or sent.\n");
}

main()
  .catch((e) => { console.error("Doctor failed:", e); process.exitCode = 1; })
  .finally(() => mongoose.connection.close().catch(() => {}));
