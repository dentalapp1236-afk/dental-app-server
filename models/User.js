import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    password: { type: String, required: true, minlength: 8 },
    role: { type: String, enum: ["dentist", "client", "vendor", "assistant"], required: true },
    // Client-only fields
    dateOfBirth: { type: Date },
    address: { type: String },
    medicalNotes: { type: String },
    // Managed (dependent) patient — e.g. a child with no own phone/email/login.
    // Communication goes to the guardian instead.
    managed: { type: Boolean, default: false },
    guardianName: { type: String, trim: true },
    guardianPhone: { type: String, trim: true }, // not unique (siblings share one)
    guardianEmail: { type: String, trim: true, lowercase: true },
    // When the guardian is a registered patient, link to their account so they
    // can view/manage this dependent and receive its notifications in-app/push.
    guardian: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Link: a client may be created by / belong to a dentist
    dentist: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Dentist-only profile fields
    clinicName: { type: String, trim: true },
    about: { type: String, trim: true },
    specialization: { type: String, trim: true },
    yearsOfExperience: { type: Number, min: 0 },
    // GeoJSON point for "nearest dentist" discovery: coordinates = [longitude, latitude]
    location: {
      type: { type: String, enum: ["Point"], default: undefined },
      coordinates: { type: [Number], default: undefined },
    },
    // Weekly availability, e.g. [{ day: "Monday", start: "09:00", end: "17:00" }]
    availability: [
      {
        _id: false,
        day: { type: String },
        start: { type: String },
        end: { type: String },
      },
    ],
    // Denormalized rating, recomputed from Reviews
    rating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },

    // Vendor-only profile field
    companyName: { type: String, trim: true },

    // Password reset (hashed token + expiry)
    resetTokenHash: { type: String },
    resetTokenExpires: { type: Date },
  },
  { timestamps: true }
);

// Geospatial index powers $near queries for nearest-dentist discovery
userSchema.index({ location: "2dsphere" });

// Avoid storing empty-string phone/email, which would violate the sparse unique indexes
userSchema.pre("save", function (next) {
  if (this.phone === "" || this.phone === null) this.phone = undefined;
  if (this.email === "" || this.email === null) this.email = undefined;
  next();
});

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.resetTokenHash;
  delete obj.resetTokenExpires;
  return obj;
};

export default mongoose.model("User", userSchema);
