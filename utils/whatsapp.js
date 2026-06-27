// WhatsApp Business Cloud API (Meta) helper.
//
// Configured only when the access token + phone-number id are present, mirroring
// the mailer: never throws, returns { delivered, reason } so callers can log.
//
// Required env:
//   WHATSAPP_TOKEN              - permanent access token (System User token)
//   WHATSAPP_PHONE_NUMBER_ID    - the sending number's phone_number_id
// Optional env:
//   WHATSAPP_API_VERSION        - default "v21.0"
//   WHATSAPP_COUNTRY_CODE       - default "92" (Pakistan) for local-number conversion
//   WHATSAPP_TEMPLATE_LANG      - default "en_US"
//   WA_TEMPLATE_WELCOME         - default "patient_welcome"
//   WA_TEMPLATE_NOTIFY          - default "clinic_notification"

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const COUNTRY_CODE = process.env.WHATSAPP_COUNTRY_CODE || "92";
const LANG = process.env.WHATSAPP_TEMPLATE_LANG || "en_US";

export const TEMPLATES = {
  welcome: process.env.WA_TEMPLATE_WELCOME || "patient_welcome",
  notify: process.env.WA_TEMPLATE_NOTIFY || "clinic_notification",
};

export const whatsappConfigured = () => !!(TOKEN && PHONE_NUMBER_ID);

console.log(
  `[whatsapp] configured=${whatsappConfigured()}` +
    (whatsappConfigured() ? ` phoneNumberId=${PHONE_NUMBER_ID}` : " (set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID to enable)")
);

// Convert a stored local number (e.g. "03001234567") to WhatsApp's wa_id form
// (digits only, international, no "+"): "923001234567".
export function toWaNumber(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2); // 00<cc>... international prefix
  if (d.startsWith("0")) d = COUNTRY_CODE + d.slice(1); // local with leading 0
  else if (!d.startsWith(COUNTRY_CODE) && d.length <= 10) d = COUNTRY_CODE + d; // bare local
  return d;
}

async function post(payload) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.message || `HTTP ${res.status}`;
    return { delivered: false, reason, data };
  }
  return { delivered: true, id: data?.messages?.[0]?.id, data };
}

// Send a pre-approved template. `bodyParams` is an array of strings that fill the
// template body's {{1}}, {{2}}, … (parameter values must not contain newlines).
export async function sendTemplate({ to, template, languageCode = LANG, bodyParams = [] }) {
  if (!whatsappConfigured()) return { delivered: false, reason: "WhatsApp not configured" };
  const wa = toWaNumber(to);
  if (!wa) return { delivered: false, reason: "No phone number" };
  try {
    const components = bodyParams.length
      ? [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: String(t).replace(/\s*\n\s*/g, " ") })) }]
      : [];
    const result = await post({
      to: wa,
      type: "template",
      template: { name: template, language: { code: languageCode }, components },
    });
    if (!result.delivered) console.error(`[whatsapp] template "${template}" to ${wa} failed: ${result.reason}`);
    return result;
  } catch (err) {
    return { delivered: false, reason: err.message || String(err) };
  }
}

// Send a free-form text message. NOTE: WhatsApp only delivers this inside the
// 24-hour customer-service window (i.e. the patient messaged us in the last 24h);
// otherwise Meta rejects it and you must use a template.
export async function sendText({ to, body }) {
  if (!whatsappConfigured()) return { delivered: false, reason: "WhatsApp not configured" };
  const wa = toWaNumber(to);
  if (!wa) return { delivered: false, reason: "No phone number" };
  try {
    const result = await post({ to: wa, type: "text", text: { preview_url: false, body } });
    if (!result.delivered) console.error(`[whatsapp] text to ${wa} failed: ${result.reason}`);
    return result;
  } catch (err) {
    return { delivered: false, reason: err.message || String(err) };
  }
}
