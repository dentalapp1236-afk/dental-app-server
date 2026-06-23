import express from "express";
import Treatment from "../models/Treatment.js";
import { protect, clinicId } from "../middleware/auth.js";

const router = express.Router();
router.use(protect);

const isStaff = (user) => user.role === "dentist" || user.role === "assistant";

// Map Mongoose optimistic-concurrency failures to a 409 so the client can refresh.
const handleErr = (res, err) => {
  if (err.name === "VersionError") {
    return res.status(409).json({
      message: "This record was just changed by someone else. Refresh and try again.",
      code: "STALE",
    });
  }
  console.error(err);
  res.status(500).json({ message: "Server error" });
};

// GET /api/treatments?client=<id>
// Clinic staff: all treatments for their clinic (optionally filter by client)
// Client: their own treatment history
router.get("/", async (req, res) => {
  const { client } = req.query;
  const filter = isStaff(req.user)
    ? { dentist: clinicId(req.user), ...(client ? { client } : {}) }
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
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can add treatments" });
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
      upfrontMethod,
      date,
    } = req.body;
    if (!client || !procedure) {
      return res.status(400).json({ message: "client and procedure are required" });
    }
    const total = Number(cost) || 0;
    const deposit = Number(upfront) || 0;
    if (deposit > 0 && !["cash", "online"].includes(upfrontMethod)) {
      return res.status(400).json({ message: "Select how the upfront payment was collected (cash or online)." });
    }
    const payments =
      deposit > 0 ? [{ amount: deposit, note: "Upfront", method: upfrontMethod }] : [];

    const tr = await Treatment.create({
      dentist: clinicId(req.user),
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
    handleErr(res, err);
  }
});

// PUT /api/treatments/:id  (edit fields; paid:true settles the remaining balance)
router.put("/:id", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can update treatments" });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, dentist: clinicId(req.user) });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });
    if (req.body.version !== undefined && Number(req.body.version) !== tr.__v) {
      return res.status(409).json({
        message: "This treatment was just changed by someone else. Refresh and try again.",
        code: "STALE",
      });
    }

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
    if (err.name === "VersionError") {
      return res.status(409).json({
        message: "This treatment was just changed by someone else. Refresh and try again.",
        code: "STALE",
      });
    }
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/treatments/:id/payments  (record a per-visit payment)
router.post("/:id/payments", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can record payments" });
    }
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "A positive amount is required" });
    }
    const { method } = req.body;
    if (!["cash", "online"].includes(method)) {
      return res.status(400).json({ message: "Select how the payment was collected (cash or online)." });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, dentist: clinicId(req.user) });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });

    if (amount > tr.balance) {
      return res
        .status(400)
        .json({ message: `Amount cannot exceed the remaining balance (${tr.balance}).` });
    }

    tr.payments.push({ amount, note: req.body.note, method, date: req.body.date || new Date() });
    tr.paid = tr.paidAmount >= tr.cost && tr.cost > 0;
    await tr.save();
    res.status(201).json(tr);
  } catch (err) {
    handleErr(res, err);
  }
});

// PUT /api/treatments/:id/payments/:paymentId  (edit a recorded payment)
router.put("/:id/payments/:paymentId", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can edit payments" });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, dentist: clinicId(req.user) });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });
    const pay = tr.payments.id(req.params.paymentId);
    if (!pay) return res.status(404).json({ message: "Payment not found" });

    if (req.body.amount !== undefined) {
      const amount = Number(req.body.amount);
      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "A positive amount is required" });
      }
      // The other payments plus this new amount must not exceed the treatment cost.
      const others = tr.paidAmount - pay.amount;
      if (tr.cost > 0 && others + amount > tr.cost) {
        return res
          .status(400)
          .json({ message: `Amount cannot exceed the remaining balance (${tr.cost - others}).` });
      }
      pay.amount = amount;
    }
    if (req.body.note !== undefined) pay.note = req.body.note;
    if (req.body.date !== undefined) pay.date = req.body.date;
    if (req.body.method !== undefined) {
      if (!["cash", "online"].includes(req.body.method)) {
        return res.status(400).json({ message: "Method must be cash or online." });
      }
      pay.method = req.body.method;
    }

    tr.paid = tr.paidAmount >= tr.cost && tr.cost > 0;
    await tr.save();
    res.json(tr);
  } catch (err) {
    handleErr(res, err);
  }
});

// DELETE /api/treatments/:id/payments/:paymentId  (remove a recorded payment)
router.delete("/:id/payments/:paymentId", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can delete payments" });
    }
    const tr = await Treatment.findOne({ _id: req.params.id, dentist: clinicId(req.user) });
    if (!tr) return res.status(404).json({ message: "Treatment not found" });
    const pay = tr.payments.id(req.params.paymentId);
    if (!pay) return res.status(404).json({ message: "Payment not found" });

    pay.deleteOne();
    tr.paid = tr.paidAmount >= tr.cost && tr.cost > 0;
    await tr.save();
    res.json(tr);
  } catch (err) {
    handleErr(res, err);
  }
});

// DELETE /api/treatments/:id
router.delete("/:id", async (req, res) => {
  if (!isStaff(req.user)) {
    return res.status(403).json({ message: "Only clinic staff can delete treatments" });
  }
  const tr = await Treatment.findOneAndDelete({
    _id: req.params.id,
    dentist: clinicId(req.user),
  });
  if (!tr) return res.status(404).json({ message: "Treatment not found" });
  res.json({ message: "Deleted" });
});

export default router;
