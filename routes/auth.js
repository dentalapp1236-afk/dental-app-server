import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import { sendMail } from "../utils/mailer.js";

const router = express.Router();

const signToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// The UI shows "Dr. <name>", so strip a leading "Dr"/"Dr." the dentist may have typed.
const stripDrPrefix = (name = "") => name.replace(/^\s*dr\b\.?\s*/i, "").trim();

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role,
      phone,
      dateOfBirth,
      address,
      // Dentist profile fields
      clinicName,
      about,
      specialization,
      yearsOfExperience,
      availability,
      latitude,
      longitude,
    } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "name, email, password, role are required" });
    }
    if (!["dentist", "client", "vendor"].includes(role)) {
      return res.status(400).json({ message: "role must be dentist, client, or vendor" });
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

    // Build dentist-only profile data (incl. GeoJSON location from lat/lng) when registering as a dentist
    const dentistFields = {};
    if (role === "dentist") {
      if (clinicName) dentistFields.clinicName = clinicName;
      if (about) dentistFields.about = about;
      if (specialization) dentistFields.specialization = specialization;
      if (yearsOfExperience != null && yearsOfExperience !== "") {
        dentistFields.yearsOfExperience = Number(yearsOfExperience);
      }
      if (Array.isArray(availability)) dentistFields.availability = availability;
      if (latitude != null && longitude != null && latitude !== "" && longitude !== "") {
        dentistFields.location = {
          type: "Point",
          coordinates: [Number(longitude), Number(latitude)],
        };
      }
    }

    const user = await User.create({
      name: role === "dentist" ? stripDrPrefix(name) : name,
      email,
      password,
      role,
      phone: trimmedPhone || undefined,
      dateOfBirth,
      address,
      ...dentistFields,
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

// POST /api/auth/forgot-password  -> email a time-limited reset link
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    // If the user exists, generate a token, store its hash, and email the link.
    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      user.resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
      user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await user.save();

      const base = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
        .split(",")[0]
        .trim()
        .replace(/\/+$/, "");
      const link = `${base}/reset-password?token=${token}`;
      const result = await sendMail({
        to: user.email,
        subject: "Reset your MyDentalBooking password",
        text: `We received a request to reset your password.\n\nUse this link within 1 hour:\n${link}\n\nIf you didn't request this, you can ignore this email.`,
        html: `<p>We received a request to reset your password.</p>
               <p>Use this link within 1 hour:</p>
               <p><a href="${link}">${link}</a></p>
               <p>If you didn't request this, you can ignore this email.</p>`,
      });
      if (!result.delivered) {
        console.error(
          `[forgot-password] reset email to ${user.email} was NOT delivered: ${result.reason}`
        );
      }
      // Opt-in diagnostics: set MAIL_DEBUG=true to learn whether the email
      // actually went out (and why not). Off by default so we don't leak which
      // addresses are registered.
      if (process.env.MAIL_DEBUG === "true") {
        return res.json({
          message: "If that email is registered, a reset link has been sent.",
          debug: { found: true, delivered: result.delivered, reason: result.reason || null },
        });
      }
    } else if (process.env.MAIL_DEBUG === "true") {
      return res.json({
        message: "If that email is registered, a reset link has been sent.",
        debug: { found: false },
      });
    }

    // Always return a generic response so we don't reveal which emails exist
    res.json({
      message: "If that email is registered, a reset link has been sent.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/auth/reset-password  -> set a new password using a valid token
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: "Token and new password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      resetTokenHash: hash,
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset link" });
    }

    user.password = password; // re-hashed by the pre-save hook
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    await user.save();

    res.json({ message: "Password updated. You can now sign in." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/auth/me
router.get("/me", protect, async (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password -> change own password (verifies current one)
router.post("/change-password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required" });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }
    const user = await User.findById(req.user._id);
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(400).json({ message: "Current password is incorrect" });
    user.password = newPassword; // re-hashed by the pre-save hook
    await user.save();
    res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/auth/me -> update own profile (role-aware fields)
router.put("/me", protect, async (req, res) => {
  try {
    const u = req.user;
    const b = req.body;

    if (b.name != null) u.name = u.role === "dentist" ? stripDrPrefix(b.name) : b.name;

    if (b.email !== undefined) {
      const cleanEmail = b.email.trim().toLowerCase() || undefined;
      if (cleanEmail) {
        const exists = await User.findOne({ email: cleanEmail, _id: { $ne: u._id } });
        if (exists) return res.status(409).json({ message: "Email already in use" });
      }
      u.email = cleanEmail;
    }

    if (b.phone != null) {
      const trimmed = b.phone.trim();
      if (trimmed) {
        if (!/^\d{11}$/.test(trimmed)) {
          return res.status(400).json({ message: "Phone number must be exactly 11 digits." });
        }
        const exists = await User.findOne({ phone: trimmed, _id: { $ne: u._id } });
        if (exists) return res.status(409).json({ message: "Phone already in use" });
        u.phone = trimmed;
      } else {
        u.phone = undefined;
      }
    }

    if (u.role === "client") {
      if (b.dateOfBirth !== undefined) u.dateOfBirth = b.dateOfBirth || undefined;
      if (b.address !== undefined) u.address = b.address;
    }

    if (u.role === "vendor") {
      if (b.companyName !== undefined) u.companyName = b.companyName;
    }

    if (u.role === "dentist") {
      if (b.clinicName !== undefined) u.clinicName = b.clinicName;
      if (b.specialization !== undefined) u.specialization = b.specialization;
      if (b.about !== undefined) u.about = b.about;
      if (b.address !== undefined) u.address = b.address;
      if (b.yearsOfExperience !== undefined && b.yearsOfExperience !== "") {
        u.yearsOfExperience = Number(b.yearsOfExperience);
      }
      if (Array.isArray(b.availability)) u.availability = b.availability;
      if (
        b.latitude != null &&
        b.longitude != null &&
        b.latitude !== "" &&
        b.longitude !== ""
      ) {
        u.location = {
          type: "Point",
          coordinates: [Number(b.longitude), Number(b.latitude)],
        };
      }
    }

    await u.save();
    res.json({ user: u });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
