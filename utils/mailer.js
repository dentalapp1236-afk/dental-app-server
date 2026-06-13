import { Resend } from "resend";

// Configured only when a Resend API key is present in the environment.
export const mailerConfigured = !!process.env.RESEND_API_KEY;

const resend = mailerConfigured ? new Resend(process.env.RESEND_API_KEY) : null;
// Use a verified domain sender in production; onboarding@resend.dev works for testing.
const FROM = process.env.MAIL_FROM || "MyDentalBooking <onboarding@resend.dev>";

// Sends an email via Resend. When no API key is configured, logs the contents
// to the server console so flows (e.g. password reset links) stay testable in dev.
// Never throws — email failures are logged and reported via the return value.
export async function sendMail({ to, subject, text, html }) {
  if (!resend) {
    console.log(
      `\n[mailer] RESEND_API_KEY not set — email NOT sent.\n  To: ${to}\n  Subject: ${subject}\n  ${text}\n`
    );
    return { delivered: false };
  }
  try {
    const { data, error } = await resend.emails.send({ from: FROM, to, subject, text, html });
    if (error) {
      console.error("[mailer] Resend error:", error);
      return { delivered: false };
    }
    return { delivered: true, id: data?.id };
  } catch (err) {
    console.error("[mailer] send failed:", err.message);
    return { delivered: false };
  }
}
