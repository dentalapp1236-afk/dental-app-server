import express from "express";
import User from "../models/User.js";
import LoginEvent from "../models/LoginEvent.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Admin-only across the board.
router.use(protect, requireRole("admin"));

// GET /api/admin/logins?hours=24&success=all|true|false&limit=500
// Recent login activity, newest first.
router.get("/logins", async (req, res) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720);
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const filter = { createdAt: { $gte: since } };
    if (req.query.success === "true") filter.success = true;
    else if (req.query.success === "false") filter.success = false;

    const events = await LoginEvent.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ since, hours, count: events.length, events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/admin/summary?hours=24 -> headline numbers for the dashboard.
router.get("/summary", async (req, res) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const [successes, failures, uniqueUsers, byRoleAgg, totalUsers, usersByRoleAgg] =
      await Promise.all([
        LoginEvent.countDocuments({ createdAt: { $gte: since }, success: true }),
        LoginEvent.countDocuments({ createdAt: { $gte: since }, success: false }),
        LoginEvent.distinct("user", { createdAt: { $gte: since }, success: true }),
        LoginEvent.aggregate([
          { $match: { createdAt: { $gte: since }, success: true } },
          { $group: { _id: "$role", count: { $sum: 1 } } },
        ]),
        User.countDocuments({}),
        User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
      ]);

    const toMap = (arr) => arr.reduce((m, r) => ({ ...m, [r._id || "unknown"]: r.count }), {});
    res.json({
      hours,
      since,
      logins: { success: successes, failed: failures, uniqueUsers: uniqueUsers.length },
      loginsByRole: toMap(byRoleAgg),
      totalUsers,
      usersByRole: toMap(usersByRoleAgg),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/admin/users?role=&search=&limit= -> user directory.
router.get("/users", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.search) {
      const rx = new RegExp(req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { clinicName: rx }];
    }
    const users = await User.find(filter)
      .select("name email phone role clinicName managed createdAt")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ count: users.length, users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
