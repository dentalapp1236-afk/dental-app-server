import express from "express";
import User from "../models/User.js";
import Engagement from "../models/Engagement.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();
router.use(protect, requireRole("dentist"));

// GET /api/assistants/:id -> an assistant's professional profile + work history,
// so a dentist can see who they're working with / considering hiring.
router.get("/:id", async (req, res) => {
  try {
    const a = await User.findOne({ _id: req.params.id, role: "assistant" }).select(
      "name image specialization about yearsOfExperience address skills createdAt"
    );
    if (!a) return res.status(404).json({ message: "Assistant not found" });

    const history = await Engagement.find({ assistant: a._id, status: { $in: ["active", "ended"] } })
      .populate("dentist", "name clinicName")
      .sort({ startedAt: -1 });

    res.json({
      assistant: {
        _id: a._id,
        name: a.name,
        image: a.image || "",
        title: a.specialization || "",
        about: a.about || "",
        yearsOfExperience: a.yearsOfExperience ?? null,
        location: a.address || "",
        skills: a.skills || [],
        memberSince: a.createdAt,
      },
      history: history.map((e) => ({
        clinic: e.dentist?.clinicName || e.dentist?.name || "A clinic",
        status: e.status,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
