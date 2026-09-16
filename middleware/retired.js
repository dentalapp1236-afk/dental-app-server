// Platform retirement kill switch.
//
// When RETIRED=true, every API route returns 410 Gone except the handful
// needed to hand a user over to MyMedIn. This is the real guarantee that no
// new data gets written here after cutover — a frontend-only notice can be
// defeated by a stale cached PWA build, but nothing gets past the API.
//
// Deliberately allowed through:
//   GET  /api/auth/me      — so the retirement screen knows who's signed in
//                            and can offer the one-tap handoff
//   POST /api/handoff/token— issues the short-lived handoff token itself
//
// Everything else (including login/register) is closed: a user whose session
// has expired signs in on MyMedIn directly with the same credentials, which
// migrated across unchanged.

const ALLOWED = [
  { method: "GET", path: "/auth/me" },
  { method: "POST", path: "/handoff/token" },
];

export const MYMEDIN_URL = process.env.MYMEDIN_URL || "https://mymedin.com";

export const retired = (req, res, next) => {
  if (process.env.RETIRED !== "true") return next();

  const allowed = ALLOWED.some(
    (a) => a.method === req.method && req.path === a.path
  );
  if (allowed) return next();

  return res.status(410).json({
    code: "PLATFORM_RETIRED",
    message: "MyDentalBooking has moved to MyMedIn. Your account and records are already there.",
    url: MYMEDIN_URL,
  });
};
