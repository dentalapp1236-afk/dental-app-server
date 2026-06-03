import express from "express";
import Treatment from "../models/Treatment.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();
router.use(protect);

// GET /api/treatments?client=<id>
// Dentist: all treatments they recorded (optionally filter by client)
// Client: their own treatment history
router.get("/", async (req, res) => {
  const { client } = req.query;
  const filter =
    req.user.role === "dentist"
      ? { dentist: req.user._id, ...(client ? { client } : {}) }
      : { client: req.user._id };

  const treatments = await Treatment.find(filter)
    .populate("client", "name email")
    .populate("dentist", "name email")
    .sort({ date: -1 });
  res.json(treatments);
});

// POST /api/treatments (dentist)
router.post("/", async (req, res) => {
  try {
    if (req.user.role !== "dentist") {
      return res.status(403).json({ message: "Only dentists can add treatments" });
    }
    const {
      client,
      appointment,
      procedure,
      toothNumber,
      diagnosis,
      description,
      cost,
      paid,
      date,
    } = req.body;
    if (!client || !procedure) {
      return res.status(400).json({ message: "client and procedure are required" });
    }
    const tr = await Treatment.create({
      dentist: req.user._id,
      client,
      appointment,
      procedure,
      toothNumber,
      diagnosis,
      description,
      cost,
      paid,
      date,
    });
    res.status(201).json(tr);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/treatments/:id
router.put("/:id", async (req, res) => {
  if (req.user.role !== "dentist") {
    return res.status(403).json({ message: "Only dentists can update treatments" });
  }
  const tr = await Treatment.findOneAndUpdate(
    { _id: req.params.id, dentist: req.user._id },
    req.body,
    { new: true }
  );
  if (!tr) return res.status(404).json({ message: "Treatment not found" });
  res.json(tr);
});

// DELETE /api/treatments/:id
router.delete("/:id", async (req, res) => {
  if (req.user.role !== "dentist") {
    return res.status(403).json({ message: "Only dentists can delete treatments" });
  }
  const tr = await Treatment.findOneAndDelete({
    _id: req.params.id,
    dentist: req.user._id,
  });
  if (!tr) return res.status(404).json({ message: "Treatment not found" });
  res.json({ message: "Deleted" });
});

export default router;
