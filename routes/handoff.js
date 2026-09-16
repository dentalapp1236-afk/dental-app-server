import express from "express";
import jwt from "jsonwebtoken";
import { protect } from "../middleware/auth.js";
import { MYMEDIN_URL } from "../middleware/retired.js";

const router = express.Router();

// One-time handoff to MyMedIn.
//
// The user is already authenticated here, so instead of making them re-type
// their password on the new platform we mint a short-lived token that MyMedIn
// verifies with a SHARED secret and exchanges for its own session.
//
// This works because the migration preserved every user's _id — the id in this
// token is the same id MyMedIn knows them by.
//
// Signed with HANDOFF_SECRET, deliberately NOT JWT_SECRET: a leaked handoff
// token must not be usable as a session token, and vice versa. The `purpose`
// claim is checked on the receiving end for the same reason.
const TTL_SECONDS = 5 * 60;

router.post("/token", protect, (req, res) => {
  if (!process.env.HANDOFF_SECRET) {
    return res.status(503).json({ message: "Handoff is not configured." });
  }

  const token = jwt.sign(
    { sub: String(req.user._id), purpose: "handoff" },
    process.env.HANDOFF_SECRET,
    { expiresIn: TTL_SECONDS }
  );

  res.json({
    token,
    expiresIn: TTL_SECONDS,
    url: `${MYMEDIN_URL}/handoff?token=${encodeURIComponent(token)}`,
  });
});

export default router;
