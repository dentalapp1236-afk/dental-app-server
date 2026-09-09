import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Engagement from "../models/Engagement.js";

// For an assistant, the "clinic they're working in" is the currently-selected
// ACTIVE engagement, not a fixed field. We resolve it here — from the
// X-Clinic-Id header, validated against their active engagements — and stamp it
// onto req.user.dentist so every clinicId(req.user) call scopes to it. With no
// valid selection, dentist is cleared so clinic queries safely return nothing.
async function attachActiveClinic(req, user) {
  try {
    const active = await Engagement.find({ assistant: user._id, status: "active" })
      .select("dentist")
      .lean();
    const ids = active.map((e) => String(e.dentist));
    req.activeClinics = ids;
    const requested = req.headers["x-clinic-id"];
    const clinic = requested && ids.includes(String(requested)) ? String(requested) : ids[0] || null;
    req.activeClinic = clinic;
    user.dentist = clinic || undefined;
  } catch (err) {
    console.error("[clinic] resolve failed:", err?.message);
    // Fall back to the legacy single dentist link already on the user doc.
  }
}

export const protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: "Not authenticated" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: "User no longer exists" });

    if (user.role === "assistant") await attachActiveClinic(req, user);

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

// Resolve the clinic owner (dentist) id for any staff member. An assistant acts
// on behalf of the dentist they belong to, so all clinic-scoped data is keyed to
// the dentist's id whether the request comes from the dentist or their assistant.
export const clinicId = (user) =>
  user.role === "assistant" ? user.dentist : user._id;

// Convenience: middleware allowing any clinic staff (dentist or their assistant).
export const requireStaff = requireRole("dentist", "assistant");
