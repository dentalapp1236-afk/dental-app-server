import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

const signToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, role, phone, dateOfBirth, address } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "name, email, password, role are required" });
    }
    if (!["dentist", "client"].includes(role)) {
      return res.status(400).json({ message: "role must be dentist or client" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ message: "Email already registered" });

    const trimmedPhone = phone?.trim();
    if (trimmedPhone) {
      const phoneExists = await User.findOne({ phone: trimmedPhone });
      if (phoneExists) return res.status(409).json({ message: "Phone already registered" });
    }

    const user = await User.create({
      name,
      email,
      password,
      role,
      phone: trimmedPhone || undefined,
      dateOfBirth,
      address,
    });
    const token = signToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    // Accept an email OR phone number under `identifier` (falls back to `email`)
    const { identifier, email, password } = req.body;
    const id = (identifier ?? email ?? "").trim();
    if (!id || !password) {
      return res.status(400).json({ message: "Email/phone and password required" });
    }
    // An identifier containing "@" is treated as an email, otherwise as a phone
    const query = id.includes("@")
      ? { email: id.toLowerCase() }
      : { phone: id };
    const user = await User.findOne(query);
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/auth/me
router.get("/me", protect, async (req, res) => {
  res.json({ user: req.user });
});

export default router;
