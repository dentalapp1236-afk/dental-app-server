import express from "express";
import User from "../models/User.js";
import Engagement from "../models/Engagement.js";
import { sendMail } from "../utils/mailer.js";
import { notifyUser } from "../utils/notify.js";
import { protect, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Only the dentist (clinic owner) manages their own staff engagements.
router.use(protect, requireRole("dentist"));

// GET /api/staff -> assistants actively engaged with this clinic.
router.get("/", async (req, res) => {
  const engs = await Engagement.find({ dentist: req.user._id, status: "active" })
    .populate("assistant", "name email phone createdAt")
    .sort({ createdAt: -1 });
  res.json(
    engs
      .filter((e) => e.assistant)
      .map((e) => ({
        engagementId: e._id,
        _id: e.assistant._id,
        name: e.assistant.name,
        email: e.assistant.email || "",
        phone: e.assistant.phone || "",
        startedAt: e.startedAt,
      }))
  );
});

// GET /api/staff/pending -> invites this clinic has sent that aren't answered yet.
router.get("/pending", async (req, res) => {
  const engs = await Engagement.find({ dentist: req.user._id, status: "pending" })
    .populate("assistant", "name email phone")
    .sort({ createdAt: -1 });
  res.json(
    engs
      .filter((e) => e.assistant)
      .map((e) => ({
        engagementId: e._id,
        _id: e.assistant._id,
        name: e.assistant.name,
        email: e.assistant.email || "",
        phone: e.assistant.phone || "",
      }))
  );
});

// POST /api/staff -> add an assistant to this clinic. If the assistant already
// has an account (portable identity), we send them a pending INVITE to accept.
// If not, we create their account and an active engagement (dentist onboards a
// brand-new hire), sharing sign-in details.
router.post("/", async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    const cleanEmail = email?.trim().toLowerCase() || undefined;
    const trimmedPhone = phone?.trim() || undefined;
    if (!cleanEmail && !trimmedPhone) {
      return res.status(400).json({ message: "Provide an email or phone to find or invite the assistant." });
    }

    // Already on the platform? Invite them (pending engagement).
    const existing = await User.findOne({
      role: "assistant",
      $or: [...(cleanEmail ? [{ email: cleanEmail }] : []), ...(trimmedPhone ? [{ phone: trimmedPhone }] : [])],
    });
    // Guard: an email/phone that belongs to a non-assistant account can't be staff.
    if (!existing) {
      const other = await User.findOne({
        $or: [...(cleanEmail ? [{ email: cleanEmail }] : []), ...(trimmedPhone ? [{ phone: trimmedPhone }] : [])],
      });
      if (other) {
        return res.status(409).json({ message: "That email/phone belongs to a non-assistant account." });
      }
    }

    if (existing) {
      const live = await Engagement.findOne({
        assistant: existing._id,
        dentist: req.user._id,
        status: { $in: ["pending", "active"] },
      });
      if (live) {
        return res.status(409).json({
          message: live.status === "active" ? "Already on your team." : "You've already invited this assistant.",
        });
      }
      await Engagement.create({
        assistant: existing._id,
        dentist: req.user._id,
        status: "pending",
        initiatedBy: "dentist",
      });
      notifyUser(existing._id, {
        type: "engagement_invite",
        title: "Clinic invite",
        body: `Dr. ${req.user.name} invited you to join their clinic on MyDentalBooking.`,
        url: "/invites",
      });
      return res.status(201).json({ invited: true, assistant: { _id: existing._id, name: existing.name } });
    }

    // New hire — create the account + an active engagement.
    if (!name || !password) {
      return res.status(400).json({ message: "name and password are required for a new assistant." });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    const assistant = await User.create({
      name,
      email: cleanEmail,
      password,
      role: "assistant",
      phone: trimmedPhone,
    });
    await Engagement.create({
      assistant: assistant._id,
      dentist: req.user._id,
      status: "active",
      initiatedBy: "dentist",
      startedAt: new Date(),
    });

    const loginUrl =
      (process.env.CLIENT_ORIGIN || "http://localhost:5173").split(",")[0].trim().replace(/\/+$/, "") + "/login";
    const shareMessage =
      `Hi ${name}, Dr. ${req.user.name} added you as an assistant on MyDentalBooking.\n\n` +
      `Login: ${loginUrl}\n` +
      (cleanEmail ? `Email: ${cleanEmail}\n` : `Phone: ${trimmedPhone}\n`) +
      `Password: ${password}\n\n` +
      `Please sign in and change your password.`;
    if (cleanEmail) {
      sendMail({
        to: cleanEmail,
        subject: "Your MyDentalBooking assistant account",
        text: shareMessage,
        html: shareMessage.replace(/\n/g, "<br/>"),
      }).catch((e) => console.error("staff creds email failed:", e?.message));
    }

    res.status(201).json({
      invited: false,
      assistant: { _id: assistant._id, name: assistant.name, email: cleanEmail || "", phone: trimmedPhone || "" },
      credentials: { email: cleanEmail || "", phone: trimmedPhone || "", password },
      shareMessage,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/staff/:id -> reset name/phone/password for an assistant this clinic
// actively engages (a convenience for hires the dentist onboarded).
router.put("/:id", async (req, res) => {
  try {
    const active = await Engagement.findOne({
      assistant: req.params.id,
      dentist: req.user._id,
      status: "active",
    });
    if (!active) return res.status(404).json({ message: "Assistant not on your team" });

    const { name, phone, password } = req.body;
    const trimmedPhone = phone?.trim();
    if (trimmedPhone) {
      const phoneExists = await User.findOne({ phone: trimmedPhone, _id: { $ne: req.params.id } });
      if (phoneExists) return res.status(409).json({ message: "Phone already in use" });
    }
    const assistant = await User.findOne({ _id: req.params.id, role: "assistant" });
    if (!assistant) return res.status(404).json({ message: "Assistant not found" });

    if (name !== undefined) assistant.name = name;
    assistant.phone = trimmedPhone || undefined;
    if (password) {
      if (String(password).length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }
      assistant.password = password; // hashed by the User pre-save hook
    }
    await assistant.save();
    res.json({ _id: assistant._id, name: assistant.name, email: assistant.email || "", phone: assistant.phone || "" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/staff/:engagementId -> remove the assistant from THIS clinic (ends
// the engagement; the assistant's account and history are kept).
router.delete("/:engagementId", async (req, res) => {
  const e = await Engagement.findOne({
    _id: req.params.engagementId,
    dentist: req.user._id,
    status: { $in: ["active", "pending"] },
  });
  if (!e) return res.status(404).json({ message: "Engagement not found" });
  e.status = "ended";
  e.endedAt = new Date();
  await e.save();
  notifyUser(e.assistant, {
    type: "engagement_removed",
    title: "Removed from clinic",
    body: `Dr. ${req.user.name} removed you from their clinic.`,
  });
  res.json({ message: "Removed" });
});

export default router;
