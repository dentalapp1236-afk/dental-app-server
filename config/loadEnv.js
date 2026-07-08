import dotenv from "dotenv";

// Load environment variables for the current NODE_ENV.
//
// Precedence (highest first):
//   1. Variables already in the real environment (e.g. Vercel/Render dashboard) —
//      dotenv never overrides these, so deployed secrets always win.
//   2. .env.<NODE_ENV>   e.g. NODE_ENV=staging -> .env.staging
//   3. .env              shared fallback for anything not set above
//
// This lets you run locally against any environment:
//   npm run dev                    -> NODE_ENV=development -> .env.development
//   NODE_ENV=staging npm start     -> .env.staging
//   NODE_ENV=production npm start  -> .env.production
const nodeEnv = process.env.NODE_ENV || "development";

dotenv.config({ path: `.env.${nodeEnv}` });
dotenv.config(); // fill any gaps from a plain .env
