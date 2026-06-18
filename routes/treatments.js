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
      upfront,
      date,
    } = req.body;
    if (!client || !procedure) {
      return res.status(400).json({ message: "client and procedure are required" });
    }
    const total = Number(cost) || 0;
    const deposit = Number(upfront) || 0;
    const payments = deposit > 0 ? [{ amount: deposit, note: "Upfront" }] : [];

    const tr = await Treatment.create({
      dentist: req.user._id,
      client,
      appointment,
      procedure,
      toothNumber,
      diagnosis,
      description,
      cost: total,
      payments,
      paid: deposit >= total && total > 0,
      date,
    });
    res.status(201).json(tr);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/treatments/:id  (edit fields; paid:true settles the remaining balance)
router.put("/:id", async (req, res) => {
  try {
    if (req.user.role !== "dentist") {
      return res.status(403).json({ message: "Only dentists can update treatments" });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, dentist: req.user._id });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });

    const editable = ["procedure", "toothNumber", "diagnosis", "description", "date"];
    for (const f of editable) if (req.body[f] !== undefined) tr[f] = req.body[f];
    if (req.body.cost !== undefined) tr.cost = Number(req.body.cost) || 0;

    // paid:true -> record a settlement payment for whatever balance remains
    if (req.body.paid === true && tr.balance > 0) {
      tr.payments.push({ amount: tr.balance, note: "Settled" });
    }
    tr.paid = tr.paidAmount >= tr.cost && tr.cost > 0;

    await tr.save();
    res.json(tr);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/treatments/:id/payments  (record a per-visit payment)
router.post("/:id/payments", async (req, res) => {
  try {
    if (req.user.role !== "dentist") {
      return res.status(403).json({ message: "Only dentists can record payments" });
    }
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "A positive amount is required" });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, dentist: req.user._id });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });

    tr.payments.push({ amount, note: req.body.note, date: req.body.date || new Date() });
    tr.paid = tr.paidAmount >= tr.cost && tr.cost > 0;
    await tr.save();
    res.status(201).json(tr);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
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
