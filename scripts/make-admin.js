import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

async function makeAdmin() {
  const targetEmail = process.argv[2];

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not configured in .env");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db();

    if (!targetEmail) {
      console.log("Usage: node scripts/make-admin.js <user-email>");
      console.log("\nExisting users in database:");
      const users = await db
        .collection("user")
        .find({})
        .project({ name: 1, email: 1, role: 1 })
        .toArray();
      users.forEach((u) => {
        console.log(`- ${u.name} (${u.email}) -> current role: ${u.role || "customer"}`);
      });
      return;
    }

    const user = await db.collection("user").findOne({ email: targetEmail.toLowerCase().trim() });
    if (!user) {
      console.error(`User with email "${targetEmail}" was not found in the database.`);
      return;
    }

    await db.collection("user").updateOne(
      { _id: user._id },
      { $set: { role: "admin", updatedAt: new Date() } }
    );

    console.log(`SUCCESS: User "${user.name}" (${user.email}) has been granted ADMIN privileges.`);
  } catch (err) {
    console.error("Error updating admin role:", err);
  } finally {
    await client.close();
  }
}

makeAdmin();
