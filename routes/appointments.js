import express from "express";
import Appointment from "../models/Appointment.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { sendPush } from "../utils/push.js";
import { sendMail } from "../utils/mailer.js";
import { protect, clinicId } from "../middleware/auth.js";

const router = express.Router();
router.use(protect);

const isStaff = (user) => user.role === "dentist" || user.role === "assistant";

const fmtWhen = (d) =>
  new Date(d).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

// Assistants act on behalf of their dentist — resolve the dentist's display name.
const dentistNameFor = async (user) => {
  if (user.role === "assistant") {
    const d = await User.findById(user.dentist).select("name");
    return d?.name || "your dentist";
  }
  return user.name;
};

// True if another *scheduled* appointment already occupies this exact slot at the clinic.
const slotConflict = async (dentistId, date, exceptId) => {
  const query = { dentist: dentistId, status: "scheduled", date: new Date(date) };
  if (exceptId) query._id = { $ne: exceptId };
  return Appointment.findOne(query);
};

// GET /api/appointments
// Dentist: appointments where they are the dentist
// Client: appointments where they are the client
router.get("/", async (req, res) => {
  const filter = isStaff(req.user)
    ? { dentist: clinicId(req.user) }
    : { client: req.user._id };
  const appts = await Appointment.find(filter)
    .populate("client", "name email phone")
    .populate("dentist", "name email")
    .sort({ date: -1 });
  res.json(appts);
});

// POST /api/appointments (clinic staff create)
router.post("/", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can create appointments" });
    }
    const dentistId = clinicId(req.user);
    const { client, date, reason, notes } = req.body;
    if (!client || !date) {
      return res.status(400).json({ message: "client and date are required" });
    }
    if (new Date(date).getTime() < Date.now()) {
      return res.status(400).json({ message: "Appointment cannot be in the past" });
    }
    if (await slotConflict(dentistId, date)) {
      return res.status(409).json({
        message: "Another appointment is already scheduled at this date and time.",
        code: "SLOT_TAKEN",
      });
    }
    const appt = await Appointment.create({
      dentist: dentistId,
      client,
      date,
      reason,
      notes,
    });
    const populated = await appt.populate([
      { path: "client", select: "name email phone" },
      { path: "dentist", select: "name email" },
    ]);

    // Notify the client: in-app + web push + email; give staff a WhatsApp link
    const c = populated.client;
    const dName = await dentistNameFor(req.user);
    const when = fmtWhen(date);
    const body = `Dr. ${dName} scheduled your appointment on ${when}${
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
      const text = `Hi ${c.name},\n\n${body}\n\nClinic: Dr. ${dName}\n\nSee you then!`;
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

// PUT /api/appointments/:id  (clinic staff update)
router.put("/:id", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can update appointments" });
    }
    const dentistId = clinicId(req.user);
    const { date, reason, notes, status, version } = req.body;

    const current = await Appointment.findOne({ _id: req.params.id, dentist: dentistId });
    if (!current) return res.status(404).json({ message: "Appointment not found" });

    // Optimistic concurrency: reject if the record changed since the client loaded it.
    if (version !== undefined && Number(version) !== current.__v) {
      return res.status(409).json({
        message: "This appointment was just changed by someone else. Refresh to see the latest, then try again.",
        code: "STALE",
      });
    }

    const nextStatus = status ?? current.status;
    if (date && nextStatus === "scheduled" && (await slotConflict(dentistId, date, current._id))) {
      return res.status(409).json({
        message: "Another appointment is already scheduled at this date and time.",
        code: "SLOT_TAKEN",
      });
    }

    const set = {};
    if (date !== undefined) set.date = date;
    if (reason !== undefined) set.reason = reason;
    if (notes !== undefined) set.notes = notes;
    if (status !== undefined) set.status = status;

    // Guard the write with the version we validated, bumping it atomically.
    const appt = await Appointment.findOneAndUpdate(
      { _id: current._id, dentist: dentistId, __v: current.__v },
      { $set: set, $inc: { __v: 1 } },
      { new: true }
    )
      .populate("client", "name email phone")
      .populate("dentist", "name email");
    if (!appt) {
      return res.status(409).json({
        message: "This appointment was just changed by someone else. Refresh and try again.",
        code: "STALE",
      });
    }
    res.json(appt);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/reschedule  (client moves their own appointment)
router.patch("/:id/reschedule", async (req, res) => {
  try {
    if (req.user.role !== "client") {
      return res.status(403).json({ message: "Only the client can reschedule" });
    }
    const { date } = req.body;
    if (!date) return res.status(400).json({ message: "New date is required" });
    if (new Date(date).getTime() < Date.now()) {
      return res.status(400).json({ message: "Appointment cannot be in the past" });
    }

    const appt = await Appointment.findOne({ _id: req.params.id, client: req.user._id });
    if (!appt) return res.status(404).json({ message: "Appointment not found" });

    if (await slotConflict(appt.dentist, date, appt._id)) {
      return res.status(409).json({
        message: "That slot is already taken. Please pick a different time.",
        code: "SLOT_TAKEN",
      });
    }

    appt.date = date;
    appt.status = "scheduled";
    appt.reminderSent = false; // re-arm the 24h reminder for the new time
    await appt.save();

    const populated = await appt.populate([
      { path: "dentist", select: "name email" },
      { path: "client", select: "name" },
    ]);
    const when = fmtWhen(date);
    const body = `${populated.client.name} rescheduled their appointment to ${when}.`;

    Notification.create({
      user: populated.dentist._id,
      type: "appointment_rescheduled",
      title: "Appointment rescheduled",
      body,
      data: { url: "/appointments", appointmentId: appt._id },
    }).catch((e) => console.error("notif failed:", e?.message));

    sendPush(populated.dentist._id, { title: "Appointment rescheduled", body, url: "/appointments" });

    if (populated.dentist.email) {
      const text = `Hi Dr. ${populated.dentist.name},\n\n${body}`;
      sendMail({
        to: populated.dentist.email,
        subject: "Appointment rescheduled — MyDentalBooking",
        text,
        html: text.replace(/\n/g, "<br/>"),
      }).catch((e) => console.error("reschedule email failed:", e?.message));
    }

    res.json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/appointments/:id
router.delete("/:id", async (req, res) => {
  if (!isStaff(req.user)) {
    return res.status(403).json({ message: "Only clinic staff can delete appointments" });
  }
  const appt = await Appointment.findOneAndDelete({
    _id: req.params.id,
    dentist: clinicId(req.user),
  });
  if (!appt) return res.status(404).json({ message: "Appointment not found" });
  res.json({ message: "Deleted" });
});

export default router;
