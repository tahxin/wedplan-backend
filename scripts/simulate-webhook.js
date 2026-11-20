/**
 * Local utility to simulate a completed checkout session for testing
 * when the Stripe CLI is not running.
 */
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

async function simulate() {
  const vendorEmail = process.argv[2] || "studio@grandmirage.com";

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db("wedplan");

    const vendor = await db.collection("user").findOne({ email: vendorEmail });
    if (!vendor) {
      console.error(`Vendor with email "${vendorEmail}" not found`);
      process.exit(1);
    }

    const sessionId = `sim_cs_${Date.now()}`;
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    await db.collection("transactions").insertOne({
      vendorId: vendor._id,
      plan: "premium",
      amount: 20.0,
      currency: "usd",
      stripeSessionId: sessionId,
      stripeSubscriptionId: null,
      status: "completed",
      createdAt: new Date(),
    });

    await db.collection("user").updateOne(
      { _id: vendor._id },
      {
        $set: {
          subscriptionPlan: "premium",
          subscriptionExpiresAt: expiresAt,
          updatedAt: new Date(),
        },
      }
    );

    console.log(`PASS: Simulated Premium upgrade for vendor ${vendor.name} (${vendor.email})`);
    console.log(`Transaction recorded with session ID: ${sessionId}`);
  } catch (err) {
    console.error("Simulation error:", err);
  } finally {
    await client.close();
  }
}

simulate();
