import express from "express";
import Treatment from "../models/Treatment.js";
import Order from "../models/Order.js";
import Expense from "../models/Expense.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

router.use(protect, requireRole("dentist"));

// GET /api/finances/summary -> income (treatments), expenses (supply orders), trends, outstanding
router.get("/summary", async (req, res) => {
  try {
    const dentistId = req.user._id;

    // --- Income from treatments ---
    const [income] = await Treatment.aggregate([
      { $match: { dentist: dentistId } },
      {
        $group: {
          _id: null,
          totalBilled: { $sum: "$cost" },
          totalCollected: { $sum: { $cond: ["$paid", "$cost", 0] } },
          treatmentCount: { $sum: 1 },
          paidCount: { $sum: { $cond: ["$paid", 1, 0] } },
        },
      },
    ]);

    // --- Expenses from supply orders (cancelled excluded) ---
    const [expense] = await Order.aggregate([
      { $match: { dentist: dentistId, status: { $ne: "cancelled" } } },
      { $group: { _id: null, totalSpent: { $sum: "$total" }, orderCount: { $sum: 1 } } },
    ]);

    // --- Maintenance expenses ---
    const [maintenance] = await Expense.aggregate([
      { $match: { dentist: dentistId } },
      { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]);

    const totalBilled = income?.totalBilled || 0;
    const totalCollected = income?.totalCollected || 0;
    const totalSpent = expense?.totalSpent || 0;
    const totalMaintenance = maintenance?.total || 0;
    const totalExpenses = totalSpent + totalMaintenance;

    // --- Monthly trend (last 6 months): collected income vs supply spend ---
    const incomeByMonth = await Treatment.aggregate([
      { $match: { dentist: dentistId, paid: true } },
      {
        $group: {
          _id: { y: { $year: "$date" }, m: { $month: "$date" } },
          amount: { $sum: "$cost" },
        },
      },
    ]);
    const orderByMonth = await Order.aggregate([
      { $match: { dentist: dentistId, status: { $ne: "cancelled" } } },
      {
        $group: {
          _id: { y: { $year: "$createdAt" }, m: { $month: "$createdAt" } },
          amount: { $sum: "$total" },
        },
      },
    ]);
    const maintByMonth = await Expense.aggregate([
      { $match: { dentist: dentistId } },
      {
        $group: {
          _id: { y: { $year: "$date" }, m: { $month: "$date" } },
          amount: { $sum: "$amount" },
        },
      },
    ]);
    // Combined expense series = supply orders + maintenance, summed per month
    const expenseByMonth = mergeMonthly(orderByMonth, maintByMonth);

    const monthly = buildMonthlySeries(incomeByMonth, expenseByMonth, 6);

    // --- Outstanding (unpaid) treatments ---
    const unpaid = await Treatment.find({ dentist: dentistId, paid: false })
      .populate("client", "name")
      .sort({ date: -1 })
      .limit(50);

    res.json({
      totals: {
        totalBilled,
        totalCollected,
        outstanding: totalBilled - totalCollected,
        totalSpent,
        totalMaintenance,
        totalExpenses,
        net: totalCollected - totalExpenses,
        treatmentCount: income?.treatmentCount || 0,
        paidCount: income?.paidCount || 0,
        unpaidCount: (income?.treatmentCount || 0) - (income?.paidCount || 0),
        orderCount: expense?.orderCount || 0,
        maintenanceCount: maintenance?.count || 0,
      },
      monthly,
      unpaid,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// Sum two month-bucketed aggregates ([{_id:{y,m}, amount}]) into one
function mergeMonthly(a, b) {
  const map = new Map();
  for (const r of [...a, ...b]) {
    const k = `${r._id.y}-${r._id.m}`;
    const existing = map.get(k);
    if (existing) existing.amount += r.amount;
    else map.set(k, { _id: { y: r._id.y, m: r._id.m }, amount: r.amount });
  }
  return [...map.values()];
}

// Merge income/expense aggregates into the last `count` calendar months (oldest first)
function buildMonthlySeries(incomeAgg, expenseAgg, count) {
  const key = (y, m) => `${y}-${m}`;
  const incomeMap = new Map(incomeAgg.map((r) => [key(r._id.y, r._id.m), r.amount]));
  const expenseMap = new Map(expenseAgg.map((r) => [key(r._id.y, r._id.m), r.amount]));
  const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Anchor on the most recent month present in the data (avoids needing Date.now())
  const allKeys = [...incomeAgg, ...expenseAgg].map((r) => r._id.y * 12 + (r._id.m - 1));
  if (allKeys.length === 0) return [];
  const endIdx = Math.max(...allKeys); // months since year 0

  const series = [];
  for (let i = count - 1; i >= 0; i--) {
    const idx = endIdx - i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    const k = key(y, m);
    series.push({
      label: `${labels[m - 1]} ${y}`,
      income: incomeMap.get(k) || 0,
      expense: expenseMap.get(k) || 0,
    });
  }
  return series;
}

export default router;
