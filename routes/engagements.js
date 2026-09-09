import express from "express";
import Engagement from "../models/Engagement.js";
import { protect, requireRole } from "../middleware/auth.js";
import { notifyUser } from "../utils/notify.js";

const router = express.Router();
router.use(protect, requireRole("assistant"));

const shape = (e) => ({
  _id: e._id,
  status: e.status,
  initiatedBy: e.initiatedBy,
  startedAt: e.startedAt,
  dentist: e.dentist
    ? { _id: e.dentist._id, name: e.dentist.name, clinicName: e.dentist.clinicName || "" }
    : null,
});

// GET /api/engagements/me -> the assistant's active clinics + pending invites.
router.get("/me", async (req, res) => {
  try {
    const list = await Engagement.find({ assistant: req.user._id, status: { $in: ["active", "pending"] } })
      .populate("dentist", "name clinicName")
      .sort({ createdAt: -1 });
    res.json({
      active: list.filter((e) => e.status === "active").map(shape),
      pending: list.filter((e) => e.status === "pending").map(shape),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/engagements/:id/accept -> accept a pending invite from a dentist.
router.post("/:id/accept", async (req, res) => {
  try {
    const e = await Engagement.findOne({ _id: req.params.id, assistant: req.user._id, status: "pending" });
    if (!e) return res.status(404).json({ message: "Invite not found" });
    e.status = "active";
    e.startedAt = new Date();
    await e.save();
    notifyUser(e.dentist, {
      type: "engagement_accepted",
      title: "Assistant joined",
      body: `${req.user.name} accepted your invite and joined your clinic.`,
      url: "/staff",
    });
    res.json(shape(await e.populate("dentist", "name clinicName")));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/engagements/:id/decline -> decline a pending invite.
router.post("/:id/decline", async (req, res) => {
  try {
    const e = await Engagement.findOne({ _id: req.params.id, assistant: req.user._id, status: "pending" });
    if (!e) return res.status(404).json({ message: "Invite not found" });
    e.status = "ended";
    e.endedAt = new Date();
    await e.save();
    notifyUser(e.dentist, {
      type: "engagement_declined",
      title: "Invite declined",
      body: `${req.user.name} declined your assistant invite.`,
      url: "/staff",
    });
    res.json({ message: "Declined" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/engagements/:id/leave -> end an active engagement (assistant leaves).
router.post("/:id/leave", async (req, res) => {
  try {
    const e = await Engagement.findOne({ _id: req.params.id, assistant: req.user._id, status: "active" });
    if (!e) return res.status(404).json({ message: "Engagement not found" });
    e.status = "ended";
    e.endedAt = new Date();
    await e.save();
    notifyUser(e.dentist, {
      type: "engagement_ended",
      title: "Assistant left",
      body: `${req.user.name} ended their engagement with your clinic.`,
      url: "/staff",
    });
    res.json({ message: "Ended" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
