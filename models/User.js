import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    password: { type: String, required: true, minlength: 8 },
    role: { type: String, enum: ["dentist", "client"], required: true },
    // Client-only fields
    dateOfBirth: { type: Date },
    address: { type: String },
    medicalNotes: { type: String },
    // Link: a client may be created by / belong to a dentist
    dentist: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Avoid storing empty-string phones, which would violate the sparse unique index
userSchema.pre("save", function (next) {
  if (this.phone === "" || this.phone === null) this.phone = undefined;
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
  return obj;
};

export default mongoose.model("User", userSchema);
