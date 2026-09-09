// Backfill Engagement rows for assistants created under the old model (where the
// assistant had a single `dentist` field). Each becomes one ACTIVE engagement so
// their login and data access continue seamlessly. Idempotent.
//
// Usage: DOTENV_CONFIG_PATH=.env.production node scripts/migrateAssistants.js
import "dotenv/config";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import Engagement from "../models/Engagement.js";

await connectDB();

const assistants = await User.find({ role: "assistant", dentist: { $ne: null } }).select("_id name dentist createdAt");
console.log(`Found ${assistants.length} assistant(s) with a legacy dentist link.`);

let created = 0;
for (const a of assistants) {
  const exists = await Engagement.findOne({
    assistant: a._id,
    dentist: a.dentist,
    status: { $in: ["pending", "active"] },
  });
  if (exists) {
    console.log(`  ${a.name}: already has an engagement — skipped`);
    continue;
  }
  await Engagement.create({
    assistant: a._id,
    dentist: a.dentist,
    status: "active",
    initiatedBy: "dentist",
    startedAt: a.createdAt || new Date(),
  });
  created += 1;
  console.log(`  ${a.name}: created active engagement`);
}
console.log(`Done. Created ${created} engagement(s).`);
process.exit(0);
