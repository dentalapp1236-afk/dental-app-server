// Populate User.phoneE164 for records that predate the field.
//
// New and edited users get it automatically from the pre-save hook in
// models/User.js; this is only for history.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
// It touches exactly ONE field, via a targeted $set/$unset — never .save() on a
// whole document, so nothing else on the record can be disturbed. `phone`
// itself is never written: it carries a unique index and is a login credential,
// and phoneE164 is the derived, disposable copy.
//
// Usage (from dental-app-server, with the right .env in place):
//   node scripts/backfillPhoneE164.mjs           # dry run — counts only
//   node scripts/backfillPhoneE164.mjs --apply   # write
//
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import { toE164 } from "../utils/phone.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  await connectDB();

  const users = await User.find({})
    .select("name role phone guardianPhone managed phoneE164")
    .lean();

  const ops = [];
  let unchanged = 0;
  let willSet = 0;
  let willClear = 0;

  for (const u of users) {
    const next = toE164(u.managed ? u.guardianPhone : u.phone) || null;
    const current = u.phoneE164 || null;
    if (next === current) {
      unchanged += 1;
      continue;
    }
    if (next) willSet += 1;
    else willClear += 1;
    ops.push({
      updateOne: {
        filter: { _id: u._id },
        update: next ? { $set: { phoneE164: next } } : { $unset: { phoneE164: "" } },
      },
    });
  }

  console.log(`\n${users.length} user(s) examined.`);
  console.log(`  already correct : ${unchanged}`);
  console.log(`  would set       : ${willSet}`);
  console.log(`  would clear     : ${willClear}  (stored number isn't a reachable mobile)`);

  if (!ops.length) {
    console.log("\nNothing to do.\n");
    await mongoose.connection.close();
    return;
  }

  if (!APPLY) {
    console.log("\nDry run only — nothing was written. Re-run with --apply to write.\n");
    await mongoose.connection.close();
    return;
  }

  const result = await User.bulkWrite(ops, { ordered: false });
  console.log(`\nModified ${result.modifiedCount} record(s).\n`);
  await mongoose.connection.close();
}

main().catch(async (e) => {
  console.error("Backfill failed:", e);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
