import express from "express";
import User from "../models/User.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

// All routes here require an authenticated dentist
router.use(protect, requireRole("dentist"));

// GET /api/clients  -> list clients linked to this dentist (or all clients if not linked yet)
router.get("/", async (req, res) => {
  const { search } = req.query;
  const filter = { role: "client" };
  if (search) {
    filter.$or = [
      { name: new RegExp(search, "i") },
      { email: new RegExp(search, "i") },
      { phone: new RegExp(search, "i") },
    ];
  }
  const clients = await User.find(filter).sort({ createdAt: -1 });
  res.json(clients);
});

// POST /api/clients -> create a new client record (dentist creating on behalf of client)
router.post("/", async (req, res) => {
  try {
    const { name, email, password, phone, dateOfBirth, address, medicalNotes } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email, password required" });
    }
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ message: "Email already in use" });

    const trimmedPhone = phone?.trim();
    if (trimmedPhone) {
      const phoneExists = await User.findOne({ phone: trimmedPhone });
      if (phoneExists) return res.status(409).json({ message: "Phone already in use" });
    }

    const client = await User.create({
      name,
      email,
      password,
      role: "client",
      phone: trimmedPhone || undefined,
      dateOfBirth,
      address,
      medicalNotes,
      dentist: req.user._id,
    });
    res.status(201).json(client);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/clients/:id
router.get("/:id", async (req, res) => {
  const client = await User.findOne({ _id: req.params.id, role: "client" });
  if (!client) return res.status(404).json({ message: "Client not found" });
  res.json(client);
});

// PUT /api/clients/:id
router.put("/:id", async (req, res) => {
  try {
    const { name, phone, dateOfBirth, address, medicalNotes } = req.body;
    const trimmedPhone = phone?.trim();

    if (trimmedPhone) {
      const phoneExists = await User.findOne({
        phone: trimmedPhone,
        _id: { $ne: req.params.id },
      });
      if (phoneExists) return res.status(409).json({ message: "Phone already in use" });
    }

    // findOneAndUpdate bypasses the save hook, so clear empty phones explicitly
    const update = { name, dateOfBirth, address, medicalNotes };
    const ops = trimmedPhone
      ? { $set: { ...update, phone: trimmedPhone } }
      : { $set: update, $unset: { phone: "" } };

    const client = await User.findOneAndUpdate(
      { _id: req.params.id, role: "client" },
      ops,
      { new: true }
    );
    if (!client) return res.status(404).json({ message: "Client not found" });
    res.json(client);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/clients/:id
router.delete("/:id", async (req, res) => {
  const client = await User.findOneAndDelete({ _id: req.params.id, role: "client" });
  if (!client) return res.status(404).json({ message: "Client not found" });
  res.json({ message: "Deleted" });
});

export default router;
