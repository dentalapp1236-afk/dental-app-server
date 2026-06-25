import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import clientsRoutes from "./routes/clients.js";
import staffRoutes from "./routes/staff.js";
import familyRoutes from "./routes/family.js";
import appointmentsRoutes from "./routes/appointments.js";
import treatmentsRoutes from "./routes/treatments.js";
import dentistsRoutes from "./routes/dentists.js";
import productsRoutes from "./routes/products.js";
import ordersRoutes from "./routes/orders.js";
import financesRoutes from "./routes/finances.js";
import expensesRoutes from "./routes/expenses.js";
import associationsRoutes from "./routes/associations.js";
import notificationsRoutes from "./routes/notifications.js";
import pushRoutes from "./routes/push.js";
import cronRoutes from "./routes/cron.js";
import { startAppointmentReminders } from "./jobs/reminders.js";
import User from "./models/User.js";

const app = express();

// Allowed origins: comma-separated CLIENT_ORIGIN, trailing slashes stripped.
// Empty -> allow all (dev). Tolerates www/non-www and trailing-slash mismatches.
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // non-browser / same-origin requests
      const normalized = origin.replace(/\/+$/, "");
      if (allowedOrigins.length === 0 || allowedOrigins.includes(normalized)) {
        return cb(null, true);
      }
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  })
);

app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/family", familyRoutes);
app.use("/api/appointments", appointmentsRoutes);
app.use("/api/treatments", treatmentsRoutes);
app.use("/api/dentists", dentistsRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/finances", financesRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/associations", associationsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/cron", cronRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || "Server error" });
});

const PORT = process.env.PORT || 5000;
connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`API listening on :${PORT}`));
    startAppointmentReminders();
    // Reconcile indexes so the email unique index becomes sparse (lets multiple
    // patients exist without an email). Safe + idempotent on a small collection.
    User.syncIndexes().catch((e) => console.error("User.syncIndexes failed:", e.message));
  })
  .catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });
