import mongoose from "mongoose";

// Extract the database name from a Mongo connection string
// (mongodb+srv://user:pass@host/<dbname>?params) — returns "" if absent.
const dbNameFromUri = (uri) => {
  const afterHost = uri.replace(/^mongodb(\+srv)?:\/\/[^/]+\//i, "");
  return afterHost.split("?")[0].split("/")[0] || "";
};

export const connectDB = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");

  const isProd = process.env.NODE_ENV === "production";

  // Pick the database to use. Priority:
  //   1. MONGO_DB env var (explicit override for any environment)
  //   2. In production: the database named in MONGO_URI (unchanged)
  //   3. Otherwise (local/dev): a separate "<name>-dev" database, so local
  //      work never touches production data even if MONGO_URI is the same.
  let dbName = process.env.MONGO_DB;
  if (!dbName) {
    const base = dbNameFromUri(uri) || "dental-clinic";
    dbName = isProd ? base : `${base}-dev`;
  }

  await mongoose.connect(uri, dbName ? { dbName } : {});
  console.log(
    `MongoDB connected — db "${dbName}" (${process.env.NODE_ENV || "development"})`
  );
};
