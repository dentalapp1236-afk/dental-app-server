import express from "express";
import { runRemindersOnce } from "../jobs/reminders.js";
import { runBalanceRemindersOnce } from "../jobs/balanceReminders.js";

const router = express.Router();

// POST/GET /api/cron/run-reminders  -> triggered by an external scheduler.
// Authenticated with a shared secret (header x-cron-secret or ?secret=...),
// NOT the user JWT — so a cron service can call it.
const handler = async (req, res) => {
  const provided = req.headers["x-cron-secret"] || req.query.secret;
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    // Appointment reminders + 15-day outstanding-balance reminders on the same
    // external schedule (each is self-gated so it only sends when actually due).
    const sent = await runRemindersOnce();
    const balanceRemindersSent = await runBalanceRemindersOnce();
    res.json({ ok: true, sent, balanceRemindersSent });
  } catch (err) {
    console.error("[cron] reminder run failed:", err?.message);
    res.status(500).json({ message: "Server error" });
  }
};

router.get("/run-reminders", handler);
router.post("/run-reminders", handler);

export default router;
