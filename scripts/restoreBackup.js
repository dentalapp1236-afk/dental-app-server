// Disaster-recovery counterpart to jobs/backup.js. Downloads a backup made by
// that job and, by default, only shows what it WOULD restore — nothing is
// written to the database unless you pass --apply, and --apply still asks for
// a typed confirmation before touching anything.
//
// IMPORTANT: this has not been exercised against a real restore. Before you
// ever need this for real, run it once against a throwaway/dev database
// (a different MONGO_URI) to make sure it behaves the way you expect.
//
// Usage (run from the dental-app-server folder, with your normal .env in place):
//   node scripts/restoreBackup.js --list                     # list available backups
//   node scripts/restoreBackup.js --latest                   # dry run: preview the newest backup
//   node scripts/restoreBackup.js --public-id=db-backups/backup-2026-09-12T03-00-00-000Z
//   node scripts/restoreBackup.js --latest --apply            # ACTUALLY restore (asks to confirm)
import "dotenv/config";
import zlib from "zlib";
import { promisify } from "util";
import readline from "readline";
import { connectDB } from "../config/db.js";
import mongoose from "mongoose";
import cloudinary, { cloudinaryReady } from "../config/cloudinary.js";

const { EJSON } = mongoose.mongo.BSON;
const gunzip = promisify(zlib.gunzip);

const APPLY = process.argv.includes("--apply");
const LIST = process.argv.includes("--list");
const LATEST = process.argv.includes("--latest");
const publicIdArg = process.argv.find((a) => a.startsWith("--public-id="))?.split("=")[1];

const BACKUP_PREFIX = "db-backups";

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function listBackups() {
  const out = [];
  let cursor;
  do {
    const res = await cloudinary.api.resources({
      type: "authenticated",
      resource_type: "raw",
      prefix: `${BACKUP_PREFIX}/`,
      max_results: 100,
      next_cursor: cursor,
    });
    out.push(...res.resources);
    cursor = res.next_cursor;
  } while (cursor);
  return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function downloadBackup(publicId) {
  // Backups are uploaded as type: "authenticated" (not publicly reachable,
  // since they contain patient PII), so fetching one back requires a signed URL.
  const url = cloudinary.url(publicId, { resource_type: "raw", type: "authenticated", sign_url: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const gzipped = Buffer.from(await res.arrayBuffer());
  const json = (await gunzip(gzipped)).toString("utf8");
  return EJSON.parse(json);
}

async function main() {
  if (!cloudinaryReady()) {
    console.error("Cloudinary is not configured (CLOUDINARY_* env vars missing).");
    process.exit(1);
  }

  if (LIST) {
    const backups = await listBackups();
    if (!backups.length) return console.log("No backups found.");
    for (const b of backups) {
      console.log(`${b.public_id}  ${(b.bytes / 1024).toFixed(0)} KB  ${b.created_at}`);
    }
    return;
  }

  let publicId = publicIdArg;
  if (LATEST || !publicId) {
    const backups = await listBackups();
    if (!backups.length) {
      console.error("No backups found to restore.");
      process.exit(1);
    }
    publicId = backups[0].public_id;
    console.log(`Using latest backup: ${publicId} (${backups[0].created_at})`);
  }

  console.log(`Downloading ${publicId} ...`);
  const dump = await downloadBackup(publicId);
  const collections = Object.keys(dump);

  console.log("\nThis backup contains:");
  for (const name of collections) {
    console.log(`  ${name}: ${dump[name].length} document(s)`);
  }

  if (!APPLY) {
    console.log("\nDry run only — nothing was changed. Re-run with --apply to actually restore.");
    return;
  }

  console.log(
    "\n⚠️  --apply will REPLACE every collection listed above in the CURRENT database " +
      "with the contents of this backup (existing documents in those collections are deleted first)."
  );
  const answer = await prompt('Type "RESTORE" to confirm, anything else to cancel: ');
  if (answer.trim() !== "RESTORE") {
    console.log("Cancelled — no changes made.");
    return;
  }

  await connectDB();
  const db = mongoose.connection.db;
  for (const name of collections) {
    const docs = dump[name];
    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
    console.log(`  restored ${name}: ${docs.length} document(s)`);
  }
  console.log("\nRestore complete.");
  await mongoose.connection.close();
}

main().catch((err) => {
  console.error("Restore failed:", err?.message || err);
  process.exit(1);
});
