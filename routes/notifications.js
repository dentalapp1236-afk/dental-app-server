import express from "express";
import Notification from "../models/Notification.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();
router.use(protect);

// GET /api/notifications?limit=50 -> notifications + unread count + total.
// `limit` lets the client page back through older notifications ("Load older").
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const [items, unreadCount, total] = await Promise.all([
      Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(limit),
      Notification.countDocuments({ user: req.user._id, read: false }),
      Notification.countDocuments({ user: req.user._id }),
    ]);
    res.json({ items, unreadCount, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/notifications/read-all -> mark all as read
router.post("/read-all", async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
  res.json({ message: "ok" });
});

// POST /api/notifications/:id/read -> mark one as read
router.post("/:id/read", async (req, res) => {
  await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { read: true }
  );
  res.json({ message: "ok" });
});

// POST /api/notifications/:id/unread -> mark one as unread
router.post("/:id/unread", async (req, res) => {
  await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { read: false }
  );
  res.json({ message: "ok" });
});

// DELETE /api/notifications -> clear all of the user's notifications
router.delete("/", async (req, res) => {
  await Notification.deleteMany({ user: req.user._id });
  res.json({ message: "cleared" });
});

// DELETE /api/notifications/:id -> dismiss one
router.delete("/:id", async (req, res) => {
  await Notification.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  res.json({ message: "deleted" });
});

export default router;
