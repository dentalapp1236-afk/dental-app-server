import express from "express";
import Appointment from "../models/Appointment.js";
import Notification from "../models/Notification.js";
import { sendPush } from "../utils/push.js";
import { sendMail } from "../utils/mailer.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();
router.use(protect);

const fmtWhen = (d) =>
  new Date(d).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

// GET /api/appointments
// Dentist: appointments where they are the dentist
// Client: appointments where they are the client
router.get("/", async (req, res) => {
  const filter =
    req.user.role === "dentist"
      ? { dentist: req.user._id }
      : { client: req.user._id };
  const appts = await Appointment.find(filter)
    .populate("client", "name email phone")
    .populate("dentist", "name email")
    .sort({ date: -1 });
  res.json(appts);
});

// POST /api/appointments (dentist creates)
router.post("/", async (req, res) => {
  try {
    if (req.user.role !== "dentist") {
      return res.status(403).json({ message: "Only dentists can create appointments" });
    }
    const { client, date, reason, notes } = req.body;
    if (!client || !date || !reason) {
      return res.status(400).json({ message: "client, date, reason required" });
    }
    const appt = await Appointment.create({
      dentist: req.user._id,
      client,
      date,
      reason,
      notes,
    });
    const populated = await appt.populate([
      { path: "client", select: "name email phone" },
      { path: "dentist", select: "name email" },
    ]);

    // Notify the client: in-app + web push + email; give the dentist a WhatsApp link
    const c = populated.client;
    const when = fmtWhen(date);
    const body = `Dr. ${req.user.name} scheduled your appointment on ${when}${
      reason ? ` for ${reason}` : ""
    }.`;

    Notification.create({
      user: c._id,
      type: "appointment_scheduled",
      title: "Appointment scheduled",
      body,
      data: { url: "/client", appointmentId: appt._id },
    }).catch((e) => console.error("notif failed:", e?.message));

    sendPush(c._id, { title: "Appointment scheduled", body, url: "/client" });

    if (c.email) {
      const text = `Hi ${c.name},\n\n${body}\n\nClinic: Dr. ${req.user.name}\n\nSee you then!`;
      sendMail({
        to: c.email,
        subject: "Your appointment is scheduled — MyDentalBooking",
        text,
        html: text.replace(/\n/g, "<br/>"),
      }).catch((e) => console.error("appointment email failed:", e?.message));
    }

    const shareMessage = `Hi ${c.name}, ${body}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;

    res.status(201).json({ appointment: populated, shareMessage, whatsappUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/appointments/:id  (dentist updates)
router.put("/:id", async (req, res) => {
  if (req.user.role !== "dentist") {
    return res.status(403).json({ message: "Only dentists can update appointments" });
  }
  const { date, reason, notes, status } = req.body;
  const appt = await Appointment.findOneAndUpdate(
    { _id: req.params.id, dentist: req.user._id },
    { date, reason, notes, status },
    { new: true }
  )
    .populate("client", "name email phone")
    .populate("dentist", "name email");
  if (!appt) return res.status(404).json({ message: "Appointment not found" });
  res.json(appt);
});

// DELETE /api/appointments/:id
router.delete("/:id", async (req, res) => {
  if (req.user.role !== "dentist") {
    return res.status(403).json({ message: "Only dentists can delete appointments" });
  }
  const appt = await Appointment.findOneAndDelete({
    _id: req.params.id,
    dentist: req.user._id,
  });
  if (!appt) return res.status(404).json({ message: "Appointment not found" });
  res.json({ message: "Deleted" });
});

export default router;
