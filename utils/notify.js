import Notification from "../models/Notification.js";
import User from "../models/User.js";
import { sendPush } from "./push.js";
import { sendMail } from "./mailer.js";

// Notify a whole clinic — the dentist AND all of their assistants — so staff
// see every clinic-facing notification the dentist gets (in-app + web push).
// Email (when provided) goes to the dentist only.
export async function notifyClinic(dentistId, { type, title, body, url, email }) {
  let recipients = [String(dentistId)];
  try {
    const assistants = await User.find({ role: "assistant", dentist: dentistId }).select("_id");
    recipients = [...new Set([...recipients, ...assistants.map((a) => String(a._id))])];
  } catch (e) {
    console.error("[notifyClinic] assistant lookup:", e?.message);
  }

  for (const uid of recipients) {
    Notification.create({ user: uid, type, title, body, data: { url } }).catch((e) =>
      console.error("[notifyClinic] notif:", e?.message)
    );
    sendPush(uid, { title, body, url });
  }

  if (email?.to) {
    const text = `${email.greeting || ""}${body}`;
    sendMail({ to: email.to, subject: title, text, html: text.replace(/\n/g, "<br/>") }).catch(
      (e) => console.error("[notifyClinic] email:", e?.message)
    );
  }
}
