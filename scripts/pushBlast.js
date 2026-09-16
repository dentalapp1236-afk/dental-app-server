// One final push notification to every device still subscribed to
// MyDentalBooking, telling them the platform has moved to MyMedIn.
//
// These subscriptions are about to become worthless anyway — they're bound to
// this origin and VAPID key, and can't be migrated — so this spends them on
// the one message that matters. This is the only channel that reaches someone
// who installed the PWA and hasn't opened it recently.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
// Usage (from dental-app-server, with .env.production in place):
//   node scripts/pushBlast.js                    # dry run — counts only
//   node scripts/pushBlast.js --apply            # actually send
//   node scripts/pushBlast.js --apply --only=<userId>   # send to one user (test first!)
//
import "dotenv/config";
import webpush from "web-push";
import { connectDB } from "../config/db.js";
import mongoose from "mongoose";
import PushSubscription from "../models/PushSubscription.js";
import User from "../models/User.js";

const APPLY = process.argv.includes("--apply");
const onlyUser = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];

const MYMEDIN_URL = process.env.MYMEDIN_URL || "https://mymedin.com";

const PAYLOAD = {
  title: "MyDentalBooking is now MyMedIn",
  body: "Your account and records have moved. Tap to open the new app and sign in with the same details.",
  url: MYMEDIN_URL,
};

async function main() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.error("VAPID keys not configured — cannot send push.");
    process.exit(1);
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@mydentalbooking.app",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  await connectDB();

  const filter = onlyUser ? { user: onlyUser } : {};
  const subs = await PushSubscription.find(filter);

  // Group by user so the summary is meaningful (people have several devices).
  const userIds = [...new Set(subs.map((s) => String(s.user)))];
  const users = await User.find({ _id: { $in: userIds } }).select("name role");
  const byId = new Map(users.map((u) => [String(u._id), u]));

  console.log(`${subs.length} subscription(s) across ${userIds.length} user(s).`);
  console.log(`Message: "${PAYLOAD.title}" -> ${PAYLOAD.url}\n`);

  if (!APPLY) {
    const roleCounts = userIds.reduce((acc, id) => {
      const r = byId.get(id)?.role || "unknown";
      acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {});
    console.log("Recipients by role:", roleCounts);
    console.log("\nDry run only. Re-run with --apply to actually send.");
    await mongoose.connection.close();
    return;
  }

  let sent = 0;
  let pruned = 0;
  let failed = 0;
  const body = JSON.stringify(PAYLOAD);

  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
      sent++;
    } catch (err) {
      // 404/410 = the browser dropped this subscription long ago.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await PushSubscription.deleteOne({ _id: sub._id });
        pruned++;
      } else {
        failed++;
        console.error(`  send failed (${err.statusCode || "?"}): ${err.message}`);
      }
    }
  }

  console.log(`\nSent ${sent}, pruned ${pruned} dead subscription(s), ${failed} failure(s).`);
  await mongoose.connection.close();
}

main().catch((e) => {
  console.error("Push blast failed:", e);
  process.exit(1);
});
