import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import clientsRoutes from "./routes/clients.js";
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

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*", credentials: true }));


app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/clients", clientsRoutes);
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || "Server error" });
});

const PORT = process.env.PORT || 5000;
connectDB()
  .then(() => app.listen(PORT, () => console.log(`API listening on :${PORT}`)))
  .catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });
