// READ-ONLY survey of what is actually stored in User.phone and
// User.guardianPhone, so we know the real size of the normalisation problem
// BEFORE changing anything. This script opens the database read-only in spirit
// and in fact: there is not a single write, update or delete in it.
//
// It answers four questions:
//   1. How many patients can we actually reach on WhatsApp?
//   2. Which stored numbers don't normalise, so someone can go and fix them?
//   3. Do any two DIFFERENT stored numbers normalise to the SAME number?
//      (That means duplicate patient records, which matters well beyond WhatsApp.)
//   4. How does that break down by role?
//
// Usage (from dental-app-server, with the right .env in place):
//   node scripts/auditPhones.mjs              # summary + 20 sample failures
//   node scripts/auditPhones.mjs --full       # list every failure
//
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import { toE164 } from "../utils/phone.js";

const FULL = process.argv.includes("--full");
const SAMPLE = 20;

const pct = (n, total) => (total ? `${((n / total) * 100).toFixed(1)}%` : "—");

async function main() {
  await connectDB();

  // .lean() — plain objects, no documents that could accidentally be saved.
  const users = await User.find({})
    .select("name role phone guardianPhone managed clinicName")
    .lean();

  console.log(`\n${users.length} user(s) in the database.\n`);

  const stats = {};
  const failures = [];
  const byNormalised = new Map(); // e164 -> [{ name, role, raw }]

  const bump = (role, key) => {
    stats[role] ??= { total: 0, hasNumber: 0, ok: 0, bad: 0, missing: 0 };
    stats[role][key] += 1;
  };

  for (const u of users) {
    const role = u.managed ? "managed (dependent)" : u.role || "unknown";
    bump(role, "total");

    // A managed dependent has no phone of their own — the guardian's is the
    // one we would actually message, so that is the one we audit.
    const raw = u.managed ? u.guardianPhone : u.phone;
    const field = u.managed ? "guardianPhone" : "phone";

    if (!raw) {
      bump(role, "missing");
      continue;
    }
    bump(role, "hasNumber");

    const e164 = toE164(raw);
    if (!e164) {
      bump(role, "bad");
      failures.push({ name: u.name, role, field, raw, clinic: u.clinicName });
      continue;
    }
    bump(role, "ok");
    if (!byNormalised.has(e164)) byNormalised.set(e164, []);
    byNormalised.get(e164).push({ name: u.name, role, raw });
  }

  // ---- by role ----
  console.log("BY ROLE");
  console.log("  role                    total   has #    valid    invalid   no number");
  for (const [role, s] of Object.entries(stats).sort()) {
    console.log(
      `  ${role.padEnd(22)} ${String(s.total).padStart(5)}` +
        `${String(s.hasNumber).padStart(8)}${String(s.ok).padStart(9)}` +
        `${String(s.bad).padStart(10)}${String(s.missing).padStart(12)}`
    );
  }

  const totals = Object.values(stats).reduce(
    (a, s) => ({
      total: a.total + s.total,
      hasNumber: a.hasNumber + s.hasNumber,
      ok: a.ok + s.ok,
      bad: a.bad + s.bad,
      missing: a.missing + s.missing,
    }),
    { total: 0, hasNumber: 0, ok: 0, bad: 0, missing: 0 }
  );

  console.log("\nREACHABLE ON WHATSAPP");
  console.log(`  valid mobile numbers : ${totals.ok} (${pct(totals.ok, totals.total)} of all users)`);
  console.log(`  stored but unusable  : ${totals.bad}`);
  console.log(`  no number at all     : ${totals.missing}`);

  // ---- collisions: different raw strings, same real number ----
  const collisions = [...byNormalised.entries()].filter(([, list]) => list.length > 1);
  console.log(`\nDUPLICATE NUMBERS: ${collisions.length}`);
  if (collisions.length) {
    console.log("  Two or more records share a real phone number. Worth a look — it");
    console.log("  usually means the same patient was entered twice.\n");
    for (const [e164, list] of collisions.slice(0, FULL ? collisions.length : SAMPLE)) {
      console.log(`  ${e164}`);
      for (const r of list) console.log(`      ${r.role.padEnd(20)} ${r.name}  (stored as "${r.raw}")`);
    }
    if (!FULL && collisions.length > SAMPLE) {
      console.log(`  … and ${collisions.length - SAMPLE} more. Re-run with --full to see them all.`);
    }
  }

  // ---- unusable numbers ----
  console.log(`\nUNUSABLE NUMBERS: ${failures.length}`);
  if (failures.length) {
    console.log("  Not a Pakistani mobile, so WhatsApp can never reach them.");
    console.log("  Landlines and typos both land here.\n");
    for (const f of failures.slice(0, FULL ? failures.length : SAMPLE)) {
      console.log(
        `  ${f.role.padEnd(20)} ${String(f.name).padEnd(28)} ${f.field}="${f.raw}"` +
          (f.clinic ? `  [${f.clinic}]` : "")
      );
    }
    if (!FULL && failures.length > SAMPLE) {
      console.log(`  … and ${failures.length - SAMPLE} more. Re-run with --full to see them all.`);
    }
  }

  console.log("\nNothing was modified — this script only reads.\n");
  await mongoose.connection.close();
}

main().catch(async (e) => {
  console.error("Audit failed:", e);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
