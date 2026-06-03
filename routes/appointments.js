import express from "express";
import Appointment from "../models/Appointment.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();
router.use(protect);

// GET /api/appointments
// Dentist: appointments where they are the dentist
// Client: appointments where they are the client
router.get("/", async (req, res) => {
  const filter =
    req.user.role === "dentist"
      ? { dentist: req.user._id }
      : { client: req.user._id };
  const appts = await Appointment.find(filter)
    .populate("client", "name email phone")
    .populate("dentist", "name email")
    .sort({ date: -1 });
  res.json(appts);
});

// POST /api/appointments (dentist creates)
router.post("/", async (req, res) => {
  try {
    if (req.user.role !== "dentist") {
      return res.status(403).json({ message: "Only dentists can create appointments" });
    }
    const { client, date, reason, notes } = req.body;
    if (!client || !date || !reason) {
      return res.status(400).json({ message: "client, date, reason required" });
    }
    const appt = await Appointment.create({
      dentist: req.user._id,
      client,
      date,
      reason,
      notes,
    });
    const populated = await appt.populate([
      { path: "client", select: "name email phone" },
      { path: "dentist", select: "name email" },
    ]);
    res.status(201).json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/appointments/:id  (dentist updates)
router.put("/:id", async (req, res) => {
  if (req.user.role !== "dentist") {
    return res.status(403).json({ message: "Only dentists can update appointments" });
  }
  const { date, reason, notes, status } = req.body;
  const appt = await Appointment.findOneAndUpdate(
    { _id: req.params.id, dentist: req.user._id },
    { date, reason, notes, status },
    { new: true }
  )
    .populate("client", "name email phone")
    .populate("dentist", "name email");
  if (!appt) return res.status(404).json({ message: "Appointment not found" });
  res.json(appt);
});

// DELETE /api/appointments/:id
router.delete("/:id", async (req, res) => {
  if (req.user.role !== "dentist") {
    return res.status(403).json({ message: "Only dentists can delete appointments" });
  }
  const appt = await Appointment.findOneAndDelete({
    _id: req.params.id,
    dentist: req.user._id,
  });
  if (!appt) return res.status(404).json({ message: "Appointment not found" });
  res.json({ message: "Deleted" });
});

export default router;
