import express from "express";
import Invoice from "../models/Invoice.js";
import { protect, requireRole } from "../middleware/auth.js";
import { getPaymentDetails } from "../config/paymentDetails.js";

const router = express.Router();

// The clinic's own subscription invoices. Owner (dentist) only — assistants
// never see billing, same as Finances/Expenses.
router.use(protect, requireRole("dentist"));

router.get("/", async (req, res) => {
  try {
    const invoices = await Invoice.find({ dentist: req.user._id })
      .select("month amount currency issueDate dueDate status paidAt note")
      .sort({ month: -1 });
    res.json(invoices);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/invoices/unpaid-count -> how many of this clinic's invoices are
// still unpaid. Cheap poll target for the Invoices nav-badge.
router.get("/unpaid-count", async (req, res) => {
  try {
    const count = await Invoice.countDocuments({ dentist: req.user._id, status: { $ne: "paid" } });
    res.json({ count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/invoices/payment-details -> the platform's bank account, so the
// dentist can pay without needing to open the PDF.
router.get("/payment-details", (req, res) => {
  res.json(getPaymentDetails());
});

export default router;
