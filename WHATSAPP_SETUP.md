# WhatsApp Business (Meta Cloud API) setup

The app sends WhatsApp messages via Meta's **WhatsApp Business Cloud API**. Two flows:

1. **Add-patient welcome** — when a dentist/assistant creates a patient with a phone number, a `patient_welcome` template is sent automatically.
2. **Ad-hoc message** — the "Message" button on a patient card sends a `clinic_notification` template (a typed message with **confirm buttons** the patient can tap).

Because WhatsApp only allows free-form text within a 24-hour window, both flows use **pre-approved templates**, which work anytime.

---

## 1. Create the Meta app & number

1. Go to <https://developers.facebook.com> → **My Apps** → **Create App** → type **Business**.
2. Add the **WhatsApp** product to the app.
3. In **WhatsApp → API Setup** you'll get a **test number** immediately. For production, add and verify your own business number (WhatsApp → API Setup → "Add phone number"). Verifying a real number requires a Meta Business verification.
4. Note these two values from **API Setup**:
   - **Phone number ID** → env `WHATSAPP_PHONE_NUMBER_ID`
   - **Temporary access token** (24h) — fine for testing. For production create a **permanent token**: Business Settings → System Users → add a system user → generate token with `whatsapp_business_messaging` + `whatsapp_business_management` permissions → env `WHATSAPP_TOKEN`.

## 2. Create the two message templates

Meta Business Manager → **WhatsApp Manager → Message templates → Create template**.
Category **Utility**, language **English (US)** (must match `WHATSAPP_TEMPLATE_LANG=en_US`).

### Template A — `patient_welcome`
- **Body:**
  ```
  Hi {{1}}, Dr. {{2}} created your MyDentalBooking account. Your temporary password is {{3}}. Please log in and change it.
  ```
- Sample values when prompted: `{{1}}=Ali`, `{{2}}=Ahmad Qureshi`, `{{3}}=Dt4f9k29`
- (Optional) add a **URL button** "Open app" pointing to your client URL.

The code sends params in this order: **`[name, dentistName, password]`**.

### Template B — `clinic_notification`
- **Body:**
  ```
  Hi {{1}}, you have a message from {{2}}: {{3}}
  ```
- Sample values: `{{1}}=Ali`, `{{2}}=Bright Smiles Clinic`, `{{3}}=Your appointment is tomorrow at 3 PM. Please confirm.`
- Add **two Quick reply buttons**: `I'll be there` and `Can't make it`
  (these are the "confirm availability / show-up" taps).

The code sends params in this order: **`[patientName, clinicName, typedMessage]`**.

> Approval usually takes minutes to a few hours. Until both templates are **Approved**, sends will fail with a template error.

## 3. Configure the webhook (so button taps come back)

1. In the Meta app → **WhatsApp → Configuration → Webhook → Edit**.
2. **Callback URL:** `https://dentalappserver.onrender.com/api/whatsapp/webhook`
3. **Verify token:** any random string — must equal env `WHATSAPP_VERIFY_TOKEN`.
4. Click **Verify and save** (our server answers the verification handshake).
5. Under **Webhook fields**, subscribe to **`messages`**.

When a patient taps a button or replies, Meta calls the webhook; the server notifies the clinic in-app/push ("<patient> replied on WhatsApp: …") and opens their 24-hour window.

## 4. Set the environment variables on Render

```
WHATSAPP_TOKEN=<permanent or temp access token>
WHATSAPP_PHONE_NUMBER_ID=<phone number id>
WHATSAPP_API_VERSION=v21.0
WHATSAPP_COUNTRY_CODE=92            # 92 = Pakistan; converts 03001234567 -> 923001234567
WHATSAPP_TEMPLATE_LANG=en_US        # must match the templates' language
WA_TEMPLATE_WELCOME=patient_welcome
WA_TEMPLATE_NOTIFY=clinic_notification
WHATSAPP_VERIFY_TOKEN=<same random string used in step 3>
```

Save → Render redeploys. On boot the logs show `[whatsapp] configured=true …`.
Leaving `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` blank disables WhatsApp cleanly (messages are skipped, nothing crashes).

## Testing notes
- With the **test number**, you can only message phone numbers you've added as recipients in API Setup. Production needs the verified business number.
- Numbers are stored locally (e.g. `03001234567`) and converted to `923001234567` automatically via `WHATSAPP_COUNTRY_CODE`.
