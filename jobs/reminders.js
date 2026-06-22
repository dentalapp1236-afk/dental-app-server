import Appointment from "../models/Appointment.js";
import Notification from "../models/Notification.js";
import { sendPush } from "../utils/push.js";
import { sendMail } from "../utils/mailer.js";

const CHECK_MS = 15 * 60 * 1000; // check every 15 minutes

// Format in the clinic's timezone (server runs in UTC) so reminders show local time.
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

// Send a one-time reminder for scheduled appointments entering the next 24 hours.
// Returns the number of reminders sent (used by the cron endpoint).
export async function runRemindersOnce() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const due = await Appointment.find({
    status: "scheduled",
    reminderSent: { $ne: true },
    date: { $gt: now, $lte: in24h },
  })
    .populate("client", "name email")
    .populate("dentist", "name");

  for (const appt of due) {
    const c = appt.client;
    if (!c) continue;
    const when = fmtWhen(appt.date);
    const body = `Reminder: your appointment with Dr. ${appt.dentist?.name} is on ${when}.`;

    await Notification.create({
      user: c._id,
      type: "appointment_reminder",
      title: "Appointment reminder",
      body,
      data: { url: "/client", appointmentId: appt._id },
    }).catch((e) => console.error("[reminder] notif:", e?.message));

    sendPush(c._id, { title: "Appointment reminder", body, url: "/client" });

    if (c.email) {
      const text = `Hi ${c.name},\n\n${body}\n\nSee you then!`;
      sendMail({
        to: c.email,
        subject: "Appointment reminder — MyDentalBooking",
        text,
        html: text.replace(/\n/g, "<br/>"),
      }).catch((e) => console.error("[reminder] email:", e?.message));
    }

    appt.reminderSent = true;
    await appt.save();
  }
  if (due.length) console.log(`[reminder] sent ${due.length} appointment reminder(s)`);
  return due.length;
}

// In-process timer (works when the server stays awake). A managed cron hitting
// /api/cron/run-reminders covers free-tier instances that sleep.
export function startAppointmentReminders() {
  runRemindersOnce().catch((e) => console.error("[reminder] error:", e?.message));
  setInterval(
    () => runRemindersOnce().catch((e) => console.error("[reminder] error:", e?.message)),
    CHECK_MS
  );
}
