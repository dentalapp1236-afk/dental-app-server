import mongoose from "mongoose";
import zlib from "zlib";
import { promisify } from "util";
import cloudinary, { cloudinaryReady } from "../config/cloudinary.js";

// The free (M0) Atlas tier has NO built-in backup of any kind — not even
// periodic snapshots, let alone point-in-time recovery. This job is the
// substitute: once a day, dump every collection as EJSON (preserves
// ObjectId/Date/etc., unlike plain JSON), gzip it, and upload it to the same
// Cloudinary account already used for image uploads (raw file storage, its
// free tier is plenty for a dump this size). Old backups are pruned after
// BACKUP_RETENTION_DAYS so storage doesn't grow forever.

const { EJSON } = mongoose.mongo.BSON;
const gzip = promisify(zlib.gzip);

const CHECK_MS = 24 * 60 * 60 * 1000; // once a day
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 14;
const BACKUP_PREFIX = "db-backups";

export async function runBackupOnce() {
  if (!cloudinaryReady()) {
    console.warn("[backup] Cloudinary not configured — skipping.");
    return { skipped: true };
  }

  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();

  const dump = {};
  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    dump[name] = await db.collection(name).find({}).toArray();
  }

  const json = EJSON.stringify(dump);
  const gzipped = await gzip(Buffer.from(json, "utf8"));

  // Keyed by the actual connected database name (not NODE_ENV, which could be
  // misconfigured) — so production and staging, sharing one Cloudinary
  // account, never mix their backups together under the same prefix.
  const dbName = db.databaseName;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const publicId = `${BACKUP_PREFIX}/${dbName}/backup-${stamp}`;

  // type: "authenticated" — this dump contains full patient PII (names,
  // phone numbers, medical notes), so it must NOT be reachable via a public
  // Cloudinary delivery URL. Only a signed URL (generated in restoreBackup.js)
  // can fetch it back.
  await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "raw", type: "authenticated", public_id: publicId },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(gzipped);
  });

  console.log(`[backup] uploaded ${publicId} (${(gzipped.length / 1024).toFixed(0)} KB)`);
  const pruned = await pruneOldBackups(dbName);
  return { ok: true, publicId, bytes: gzipped.length, pruned };
}

async function pruneOldBackups(dbName) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const toDelete = [];
  let cursor;
  do {
    const res = await cloudinary.api.resources({
      type: "authenticated",
      resource_type: "raw",
      prefix: `${BACKUP_PREFIX}/${dbName}/`,
      max_results: 100,
      next_cursor: cursor,
    });
    for (const r of res.resources) {
      if (new Date(r.created_at).getTime() < cutoff) toDelete.push(r.public_id);
    }
    cursor = res.next_cursor;
  } while (cursor);

  if (toDelete.length) {
    await cloudinary.api.delete_resources(toDelete, { resource_type: "raw", type: "authenticated" });
    console.log(`[backup] pruned ${toDelete.length} backup(s) older than ${RETENTION_DAYS}d`);
  }
  return toDelete.length;
}

// In-process timer plus a run at startup (a managed external cron hitting
// /api/cron/run-backup covers free-tier instances that sleep, same as the
// reminder/invoice jobs).
export function startBackupJob() {
  runBackupOnce().catch((e) => console.error("[backup] error:", e?.message));
  setInterval(() => runBackupOnce().catch((e) => console.error("[backup] error:", e?.message)), CHECK_MS);
}
