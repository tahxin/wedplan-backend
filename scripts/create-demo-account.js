import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { hashPassword } from "./password.js";

dotenv.config();

/**
 * Creates (or repairs) a demo account that can actually sign in.
 *
 * Why this exists: users inserted straight into the `user` collection have no
 * matching `account` document, so Better Auth answers INVALID_EMAIL_OR_PASSWORD
 * no matter what password is typed. This script attaches a real credential
 * account using Better Auth's own hashing scheme.
 *
 * Usage:
 *   node scripts/create-demo-account.js <email> <password> [role] [name]
 *   node scripts/create-demo-account.js studio@grandmirage.com 'VendorDemo2026!' vendor "Grand Mirage Wedding Co."
 */

const ALLOWED_ROLES = ["customer", "vendor", "admin"];

async function main() {
  const [email, password, roleArg, ...nameParts] = process.argv.slice(2);
  const role = roleArg || "vendor";
  const name = nameParts.join(" ") || "Demo Account";

  if (!email || !password) {
    console.error(
      "Usage: node scripts/create-demo-account.js <email> <password> [customer|vendor|admin] [display name]"
    );
    process.exit(1);
  }

  if (!ALLOWED_ROLES.includes(role)) {
    console.error(`Role must be one of: ${ALLOWED_ROLES.join(", ")}`);
    process.exit(1);
  }

  if (password.length < 6 || !/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    console.error("Password must be at least 6 characters and contain upper and lower case letters.");
    process.exit(1);
  }

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not configured in .env");
    process.exit(1);
  }

  const normalizedEmail = email.toLowerCase().trim();
  const client = new MongoClient(process.env.MONGODB_URI);

  try {
    await client.connect();
    const db = client.db();

    let user = await db.collection("user").findOne({ email: normalizedEmail });
    let createdUser = false;

    if (!user) {
      const now = new Date();
      const doc = {
        name,
        email: normalizedEmail,
        emailVerified: false,
        role,
        isBlocked: false,
        businessName: role === "vendor" ? name : "",
        subscriptionPlan: "free",
        subscriptionExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const res = await db.collection("user").insertOne(doc);
      user = { _id: res.insertedId, ...doc };
      createdUser = true;
      console.log(`Created user ${normalizedEmail} (${role}).`);
    } else if (user.role !== role) {
      await db
        .collection("user")
        .updateOne({ _id: user._id }, { $set: { role, updatedAt: new Date() } });
      console.log(`Updated role for ${normalizedEmail}: ${user.role || "unset"} -> ${role}.`);
      user.role = role;
    } else {
      console.log(`User ${normalizedEmail} already exists (${user.role}).`);
    }

    const existingAccount = await db
      .collection("account")
      .findOne({ userId: user._id, providerId: "credential" });

    if (existingAccount) {
      console.log("Credential account already present - leaving the existing password untouched.");
    } else {
      const now = new Date();
      await db.collection("account").insertOne({
        accountId: user._id.toString(),
        providerId: "credential",
        userId: user._id,
        password: await hashPassword(password),
        createdAt: now,
        updatedAt: now,
      });
      console.log("Attached a credential account - this user can now sign in.");
    }

    if (createdUser) {
      console.log("\nSign in with:");
      console.log(`  email:    ${normalizedEmail}`);
      console.log(`  password: <the one you passed in>`);
    }
  } catch (err) {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
