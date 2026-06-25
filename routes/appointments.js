import express from "express";
import mongoose from "mongoose";
import Appointment from "../models/Appointment.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { sendPush } from "../utils/push.js";
import { sendMail } from "../utils/mailer.js";
import { protect, clinicId } from "../middleware/auth.js";
import { notifyClinic } from "../utils/notify.js";

const router = express.Router();
router.use(protect);

const isStaff = (user) => user.role === "dentist" || user.role === "assistant";

// Format an appointment time in the clinic's timezone (server runs in UTC),
// so notifications/emails show local time, not UTC.
const CLINIC_TZ = process.env.CLINIC_TZ || "Asia/Karachi";
const fmtWhen = (d) =>
  new Date(d).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: CLINIC_TZ,
  });

// Assistants act on behalf of their dentist — resolve the dentist's display name.
const dentistNameFor = async (user) => {
  if (user.role === "assistant") {
    const d = await User.findById(user.dentist).select("name");
    return d?.name || "your dentist";
  }
  return user.name;
};

// True if a scheduled or pending appointment already occupies this exact slot.
const ACTIVE = ["scheduled", "pending"];
const slotConflict = async (dentistId, date, exceptId) => {
  const query = { dentist: dentistId, status: { $in: ACTIVE }, date: new Date(date) };
  if (exceptId) query._id = { $ne: exceptId };
  return Appointment.findOne(query);
};

// Calendar-day window [start, end) for the given instant.
const dayRange = (date) => {
  const d = new Date(date);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
};

// True if the patient already has an active (scheduled/pending) appointment that day.
// One appointment per patient per day keeps the schedule sane.
const patientDayConflict = async (clientId, date, exceptId) => {
  const { start, end } = dayRange(date);
  const query = { client: clientId, status: { $in: ACTIVE }, date: { $gte: start, $lt: end } };
  if (exceptId) query._id = { $ne: exceptId };
  return Appointment.findOne(query);
};

// Notify a user in-app + push + (optionally) email.
const notifyUser = async (userId, { type, title, body, url, email }) => {
  Notification.create({ user: userId, type, title, body, data: { url } }).catch((e) =>
    console.error("notif failed:", e?.message)
  );
  sendPush(userId, { title, body, url });
  if (email?.to) {
    const text = `${email.greeting || ""}${body}`;
    sendMail({ to: email.to, subject: title, text, html: text.replace(/\n/g, "<br/>") }).catch(
      (e) => console.error("email failed:", e?.message)
    );
  }
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
    .populate("dentist", "name email clinicName location")
    .sort({ date: -1 });
  res.json(appts);
});

// GET /api/appointments/booked?from=ISO&to=ISO&exclude=<id>
// Returns the datetimes of scheduled appointments for the relevant clinic within
// [from, to), so the UI can show which slots are taken. Scoped by role:
// staff -> their clinic; client -> their associated dentist.
router.get("/booked", async (req, res) => {
  try {
    const dentistId = isStaff(req.user)
      ? clinicId(req.user)
      : req.user.role === "client"
      ? req.user.dentist
      : null;
    if (!dentistId) return res.json({ slots: [] });

    const q = { dentist: dentistId, status: { $in: ACTIVE } };
    const { from, to, exclude } = req.query;
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to) q.date.$lt = new Date(to);
    }
    if (exclude && mongoose.isValidObjectId(exclude)) q._id = { $ne: exclude };

    const [appts, dentist] = await Promise.all([
      Appointment.find(q).select("date").lean(),
      User.findById(dentistId).select("availability").lean(),
    ]);
    res.json({
      slots: appts.map((a) => a.date),
      availability: dentist?.availability || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
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
    if (await patientDayConflict(client, date)) {
      return res.status(409).json({
        message: "This patient already has an appointment on this day.",
        code: "PATIENT_DAY_TAKEN",
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

// POST /api/appointments/request  (client requests an appointment with their dentist)
router.post("/request", async (req, res) => {
  try {
    if (req.user.role !== "client") {
      return res.status(403).json({ message: "Only patients can request appointments" });
    }
    const dentistId = req.user.dentist;
    if (!dentistId) {
      return res.status(400).json({ message: "You are not associated with a dentist yet." });
    }
    const { date, reason } = req.body;
    if (!date) return res.status(400).json({ message: "Please pick a time slot." });
    if (new Date(date).getTime() < Date.now()) {
      return res.status(400).json({ message: "Appointment cannot be in the past" });
    }
    if (await slotConflict(dentistId, date)) {
      return res.status(409).json({
        message: "That slot was just taken. Please pick another time.",
        code: "SLOT_TAKEN",
      });
    }
    if (await patientDayConflict(req.user._id, date)) {
      return res.status(409).json({
        message: "You already have an appointment on this day.",
        code: "PATIENT_DAY_TAKEN",
      });
    }

    const appt = await Appointment.create({
      dentist: dentistId,
      client: req.user._id,
      date,
      reason,
      status: "pending",
    });

    const when = fmtWhen(date);
    const dentist = await User.findById(dentistId).select("name email");
    const body = `${req.user.name} requested an appointment on ${when}${
      reason ? ` for ${reason}` : ""
    }.`;
    await notifyClinic(dentistId, {
      type: "appointment_requested",
      title: "New appointment request",
      body,
      url: "/appointments",
      email: dentist?.email ? { to: dentist.email, greeting: `Hi Dr. ${dentist.name},\n\n` } : null,
    });

    res.status(201).json({ appointment: appt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/confirm  (staff approves a pending request)
router.patch("/:id/confirm", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can confirm requests" });
    }
    const dentistId = clinicId(req.user);
    const appt = await Appointment.findOne({ _id: req.params.id, dentist: dentistId, status: "pending" });
    if (!appt) return res.status(404).json({ message: "Request not found" });

    // Make sure the slot wasn't taken by someone else since the request came in.
    if (await slotConflict(dentistId, appt.date, appt._id)) {
      return res.status(409).json({
        message: "That slot is already taken — decline this request or reschedule.",
        code: "SLOT_TAKEN",
      });
    }
    if (await patientDayConflict(appt.client, appt.date, appt._id)) {
      return res.status(409).json({
        message: "This patient already has another appointment on this day.",
        code: "PATIENT_DAY_TAKEN",
      });
    }

    appt.status = "scheduled";
    appt.remind24hSent = false;
    appt.remind12hSent = false;
    appt.remind1hSent = false;
    await appt.save();
    const populated = await appt.populate([
      { path: "client", select: "name email phone" },
      { path: "dentist", select: "name email" },
    ]);

    const dName = await dentistNameFor(req.user);
    const when = fmtWhen(appt.date);
    const body = `Dr. ${dName} confirmed your appointment on ${when}.`;
    await notifyUser(populated.client._id, {
      type: "appointment_confirmed",
      title: "Appointment confirmed",
      body,
      url: "/client",
      email: populated.client.email
        ? { to: populated.client.email, greeting: `Hi ${populated.client.name},\n\n` }
        : null,
    });

    res.json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/decline  (staff declines a pending request)
router.patch("/:id/decline", async (req, res) => {
  try {
    if (!isStaff(req.user)) {
      return res.status(403).json({ message: "Only clinic staff can decline requests" });
    }
    const dentistId = clinicId(req.user);
    const appt = await Appointment.findOne({ _id: req.params.id, dentist: dentistId, status: "pending" });
    if (!appt) return res.status(404).json({ message: "Request not found" });

    appt.status = "cancelled";
    await appt.save();
    const populated = await appt.populate([
      { path: "client", select: "name email phone" },
      { path: "dentist", select: "name email" },
    ]);

    const dName = await dentistNameFor(req.user);
    const when = fmtWhen(appt.date);
    const body = `Dr. ${dName} could not confirm your requested appointment on ${when}. Please pick another time.`;
    await notifyUser(populated.client._id, {
      type: "appointment_declined",
      title: "Appointment request declined",
      body,
      url: "/client",
      email: populated.client.email
        ? { to: populated.client.email, greeting: `Hi ${populated.client.name},\n\n` }
        : null,
    });

    res.json(populated);
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
    if (date && ACTIVE.includes(nextStatus) && (await patientDayConflict(current.client, date, current._id))) {
      return res.status(409).json({
        message: "This patient already has an appointment on this day.",
        code: "PATIENT_DAY_TAKEN",
      });
    }

    const dateChanged =
      date !== undefined && new Date(date).getTime() !== new Date(current.date).getTime();

    const set = {};
    if (date !== undefined) set.date = date;
    if (reason !== undefined) set.reason = reason;
    if (notes !== undefined) set.notes = notes;
    if (status !== undefined) set.status = status;
    // Moving the time re-arms the 24h/12h/1h reminders and clears travel status,
    // so a rescheduled appointment notifies the patient for its NEW time.
    if (dateChanged) {
      set.remind24hSent = false;
      set.remind12hSent = false;
      set.remind1hSent = false;
      set.arrivalStatus = "none";
    }

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

    // Tell the patient when staff move their appointment to a new time.
    if (dateChanged && appt.client?._id && appt.status === "scheduled") {
      const dName = await dentistNameFor(req.user);
      const body = `Dr. ${dName} rescheduled your appointment to ${fmtWhen(appt.date)}.`;
      await notifyUser(appt.client._id, {
        type: "appointment_scheduled",
        title: "Appointment rescheduled",
        body,
        url: "/client",
        email: appt.client.email
          ? { to: appt.client.email, greeting: `Hi ${appt.client.name},\n\n` }
          : null,
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
    if (!ACTIVE.includes(appt.status)) {
      return res.status(400).json({ message: "Only active appointments can be rescheduled." });
    }

    if (await slotConflict(appt.dentist, date, appt._id)) {
      return res.status(409).json({
        message: "That slot is already taken. Please pick a different time.",
        code: "SLOT_TAKEN",
      });
    }
    if (await patientDayConflict(req.user._id, date, appt._id)) {
      return res.status(409).json({
        message: "You already have another appointment on this day.",
        code: "PATIENT_DAY_TAKEN",
      });
    }

    // Keep the current status — a pending request stays pending (awaiting
    // confirmation) at the new time; a scheduled one stays scheduled.
    appt.date = date;
    appt.arrivalStatus = "none"; // moved time → clear travel status
    appt.remind24hSent = false; // re-arm reminders for the new time
    appt.remind12hSent = false;
    appt.remind1hSent = false;
    await appt.save();

    const populated = await appt.populate([
      { path: "dentist", select: "name email" },
      { path: "client", select: "name" },
    ]);
    const when = fmtWhen(date);
    const body =
      appt.status === "pending"
        ? `${populated.client.name} changed their requested appointment time to ${when}.`
        : `${populated.client.name} rescheduled their appointment to ${when}.`;

    await notifyClinic(populated.dentist._id, {
      type: "appointment_rescheduled",
      title: "Appointment rescheduled",
      body,
      url: "/appointments",
      email: populated.dentist.email
        ? { to: populated.dentist.email, greeting: `Hi Dr. ${populated.dentist.name},\n\n` }
        : null,
    });

    res.json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/cancel  (client cancels their own active appointment)
router.patch("/:id/cancel", async (req, res) => {
  try {
    if (req.user.role !== "client") {
      return res.status(403).json({ message: "Only the patient can cancel their appointment" });
    }
    const appt = await Appointment.findOne({ _id: req.params.id, client: req.user._id });
    if (!appt) return res.status(404).json({ message: "Appointment not found" });
    if (!ACTIVE.includes(appt.status)) {
      return res.status(400).json({ message: "This appointment can no longer be cancelled." });
    }

    const wasPending = appt.status === "pending";
    appt.status = "cancelled";
    await appt.save();

    const populated = await appt.populate([
      { path: "dentist", select: "name email" },
      { path: "client", select: "name" },
    ]);
    const when = fmtWhen(appt.date);
    const body = wasPending
      ? `${populated.client.name} withdrew their appointment request for ${when}.`
      : `${populated.client.name} cancelled their appointment on ${when}.`;

    await notifyClinic(populated.dentist._id, {
      type: "appointment_cancelled",
      title: "Appointment cancelled",
      body,
      url: "/appointments",
      email: populated.dentist.email
        ? { to: populated.dentist.email, greeting: `Hi Dr. ${populated.dentist.name},\n\n` }
        : null,
    });

    res.json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/appointments/:id/arrival  (patient signals they're on the way / arrived)
router.patch("/:id/arrival", async (req, res) => {
  try {
    if (req.user.role !== "client") {
      return res.status(403).json({ message: "Only the patient can update arrival status" });
    }
    const { status } = req.body;
    if (!["on_the_way", "arrived"].includes(status)) {
      return res.status(400).json({ message: "Invalid arrival status" });
    }
    const appt = await Appointment.findOne({ _id: req.params.id, client: req.user._id });
    if (!appt) return res.status(404).json({ message: "Appointment not found" });
    if (appt.status !== "scheduled") {
      return res.status(400).json({ message: "Only confirmed appointments can be updated." });
    }

    appt.arrivalStatus = status;
    await appt.save();
    const populated = await appt.populate([
      { path: "dentist", select: "name email" },
      { path: "client", select: "name" },
    ]);

    const when = fmtWhen(appt.date);
    const body =
      status === "arrived"
        ? `${populated.client.name} has arrived at the clinic for their ${when} appointment.`
        : `${populated.client.name} is on the way to the clinic (appointment ${when}).`;
    await notifyClinic(populated.dentist._id, {
      type: "appointment_arrival",
      title: status === "arrived" ? "Patient has arrived" : "Patient on the way",
      body,
      url: "/appointments",
      email: populated.dentist.email
        ? { to: populated.dentist.email, greeting: `Hi Dr. ${populated.dentist.name},\n\n` }
        : null,
    });

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
