import express from "express";
import mongoose from "mongoose";
import Expense from "../models/Expense.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

router.use(protect, requireRole("dentist"));

// GET /api/expenses -> dentist's maintenance expenses (newest first)
router.get("/", async (req, res) => {
  try {
    const expenses = await Expense.find({ dentist: req.user._id }).sort({ date: -1 });
    res.json(expenses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/expenses -> record a maintenance expense
router.post("/", async (req, res) => {
  try {
    const { title, category, amount, date, notes } = req.body;
    if (!title || amount == null) {
      return res.status(400).json({ message: "title and amount are required" });
    }
    if (Number(amount) < 0) {
      return res.status(400).json({ message: "amount cannot be negative" });
    }
    const expense = await Expense.create({
      dentist: req.user._id,
      title,
      category,
      amount: Number(amount),
      date,
      notes,
    });
    res.status(201).json(expense);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/expenses/:id
router.delete("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Expense not found" });
  }
  const expense = await Expense.findOneAndDelete({
    _id: req.params.id,
    dentist: req.user._id,
  });
  if (!expense) return res.status(404).json({ message: "Expense not found" });
  res.json({ message: "Deleted" });
});

export default router;
