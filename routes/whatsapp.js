import express from "express";
import User from "../models/User.js";
import { protect, requireRole, clinicId } from "../middleware/auth.js";
import { notifyClinic } from "../utils/notify.js";
import { sendTemplate, whatsappConfigured, TEMPLATES } from "../utils/whatsapp.js";

const router = express.Router();

const COUNTRY_CODE = process.env.WHATSAPP_COUNTRY_CODE || "92";

// Reverse of toWaNumber: "923001234567" -> "03001234567" so we can match the
// locally-stored phone (and guardianPhone) of the sender.
const waToLocal = (wa) => {
  let d = String(wa || "").replace(/\D/g, "");
  if (d.startsWith(COUNTRY_CODE)) d = "0" + d.slice(COUNTRY_CODE.length);
  return d;
};

// --- Webhook verification (Meta calls this once when you set the callback URL) ---
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Inbound messages (patient replies, including quick-reply button taps) ---
router.post("/webhook", async (req, res) => {
  // Always ack fast so Meta doesn't retry.
  res.sendStatus(200);
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) {
          const from = msg.from; // wa_id, e.g. 923001234567
          const local = waToLocal(from);

          // Find the patient by their stored phone (or guardian's phone).
          const user = await User.findOne({
            role: "client",
            $or: [{ phone: local }, { guardianPhone: local }],
          });
          if (!user) continue;

          // Opening a 24h customer-service window — record it.
          user.waLastInboundAt = new Date();
          await user.save().catch(() => {});

          // Extract the reply text (quick-reply button, interactive button, or plain text).
          let reply = "";
          if (msg.type === "button") reply = msg.button?.text || msg.button?.payload || "";
          else if (msg.type === "interactive")
            reply = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
          else if (msg.type === "text") reply = msg.text?.body || "";
          if (!reply || !user.dentist) continue;

          // Tell the clinic the patient responded (in-app + push).
          await notifyClinic(user.dentist, {
            type: "whatsapp_reply",
            title: `${user.name} replied on WhatsApp`,
            body: reply,
            url: `/clients/${user._id}`,
          });
        }
      }
    }
  } catch (err) {
    console.error("[whatsapp] webhook error:", err?.message);
  }
});

// --- Ad-hoc message a patient (dentist / assistant) ---
// POST /api/whatsapp/send { clientId, message }
// Sends the approved notification template (works anytime, carries confirm
// buttons). If the patient is within the 24h window, also fine as free text,
// but the template is the reliable path.
router.post("/send", protect, requireRole("dentist", "assistant"), async (req, res) => {
  try {
    if (!whatsappConfigured()) {
      return res.status(503).json({ message: "WhatsApp is not configured on the server." });
    }
    const { clientId, message } = req.body;
    const text = (message || "").toString().trim();
    if (!clientId || !text) {
      return res.status(400).json({ message: "clientId and message are required." });
    }

    const client = await User.findOne({ _id: clientId, role: "client", dentist: clinicId(req.user) });
    if (!client) return res.status(404).json({ message: "Patient not found." });

    // Managed dependents have no own number — reach them via the guardian's phone.
    const phone = client.managed ? client.guardianPhone : client.phone;
    if (!phone) return res.status(400).json({ message: "This patient has no WhatsApp number on file." });

    const clinicName = req.user.clinicName || "your clinic";
    const result = await sendTemplate({
      to: phone,
      template: TEMPLATES.notify,
      bodyParams: [client.name, clinicName, text],
    });

    if (!result.delivered) {
      return res.status(502).json({ message: `WhatsApp could not send: ${result.reason}` });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[whatsapp] send error:", err?.message);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
