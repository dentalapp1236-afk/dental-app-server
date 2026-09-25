# Deploying WAHA on Render

WAHA is the WhatsApp gateway. It runs as its **own Render service**, separate
from `dental-app-server`, and the API reaches it over HTTP via `WAHA_URL`.

## Before you start

**The free tier will not work.** Render's persistent disks are a paid feature,
and WAHA keeps its session credentials in `/app/.sessions`. With no disk, every
deploy and every restart wipes the pairing and someone has to scan a QR code
again. UptimeRobot doesn't help — it prevents idle spin-down, not restarts.

Budget: Starter instance (~$7/mo) plus ~$0.25/mo for a 1 GB disk.

## 1. Generate three secrets

On Render the dashboard and Swagger UI are reachable from the public internet.
On a VPS you would bind them to localhost; here you cannot. These three strings
are the only thing standing between anyone on the internet and your WhatsApp
account, so generate them properly:

```
openssl rand -hex 32    # WAHA_API_KEY
openssl rand -hex 32    # WAHA_DASHBOARD_PASSWORD
```

Pick any username you like. Keep all three somewhere safe — you need the API
key again in step 4.

(WAHA's own `init-waha` Docker command generates the same things if you have
Docker locally. Either is fine.)

## 2. Create the service

Render Dashboard → **New → Blueprint** → point it at this repo. It picks up
`infra/waha/render.yaml`.

Or create it by hand: **New → Web Service → Deploy an existing image**, image
`docker.io/devlikeapro/waha`, region **Singapore**, plan **Starter**, and add a
disk mounted at `/app/.sessions`.

Two settings that cannot be changed later:

- **Region: Singapore.** It's Render's closest to Pakistan. A Pakistani number
  linked from a US datacenter is a conspicuous fingerprint.
- **The disk.** Adding one later means recreating the service.

## 3. Set the secrets and deploy

In the service's **Environment** tab, fill in `WAHA_API_KEY`,
`WAHA_DASHBOARD_USERNAME` and `WAHA_DASHBOARD_PASSWORD`. The blueprint marks
them `sync: false`, so they live only in Render, never in git.

## 4. Pair the number

1. Open `https://<your-waha-service>.onrender.com/dashboard`
2. Log in with the dashboard username/password
3. Connect using the **API key**
4. Start the `default` session — leave the settings alone, the engine is
   already set to NOWEB by the blueprint
5. Wait for status `SCAN_QR`, click the camera icon, and scan with the
   **dedicated SIM's** phone — never a personal or clinic number
6. Status should move to `WORKING`

If you see "Click to reload QR", stop the session and start it again.

## 5. Point the API at it

On the **staging** `dental-app-server` service:

```
WAHA_URL=https://<your-waha-service>.onrender.com
WAHA_API_KEY=<the same key from step 1>
WAHA_SESSION=default
WHATSAPP_TEST_TO=<your own number, E.164>
```

Leave `WHATSAPP_ENABLED` **unset** for now. Nothing sends until it is `true`.

`WHATSAPP_TEST_TO` redirects every message to that one number and stamps the
body, so a test can never reach a real patient. Staging should keep it set
permanently.

## 6. Prove it works

From `dental-app-server`, with the same environment:

```
node scripts/whatsappTest.mjs                    # session status only
node scripts/whatsappTest.mjs +923001234567      # send yourself one message
```

This talks to the driver directly and deliberately bypasses the opt-in and
rate-limit guards. It is the last step before anything points at a patient.

## 7. Turn it on

Only once step 6 passes: set `WHATSAPP_ENABLED=true` on staging.

Start with the defaults — 50 messages per rolling 24 hours, 4–8 seconds
between sends. Raise `WHATSAPP_DAILY_CAP` gradually over weeks. A fresh number
that suddenly sends 80 messages at 08:00 is close to a guaranteed ban.

## Operational notes

- **Pin the image version** in `render.yaml` once you have a working one.
  `:latest` means an upgrade can land on a restart and break the session.
- **`WHATSAPP_RESTART_ALL_SESSIONS=true`** is set so the session comes back by
  itself after a Render restart. Without it the container returns but the
  session sits `STOPPED` and every send fails quietly.
- **The primary phone must open WhatsApp at least every ~14 days**, or WhatsApp
  logs out all linked devices. Decide who owns that handset.
- **Memory:** NOWEB has no browser, so it fits Starter's 512 MB. Do not switch
  the engine to WEBJS, WPP or VENOM — those run Chromium and will not fit.
