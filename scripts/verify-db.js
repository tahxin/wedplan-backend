import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

async function verify() {
  if (!process.env.MONGODB_URI) {
    console.error("FAIL: MONGODB_URI is not set");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    console.log("PASS: Successfully connected to MongoDB Atlas");

    const db = client.db("wedplan");
    const collections = await db.listCollections().toArray();
    console.log("Collections:", collections.map((c) => c.name).join(", "));

    const [userCount, serviceCount, bookingCount, txCount] = await Promise.all([
      db.collection("user").countDocuments(),
      db.collection("services").countDocuments(),
      db.collection("bookings").countDocuments(),
      db.collection("transactions").countDocuments(),
    ]);

    console.log(`Document Counts -> Users: ${userCount}, Services: ${serviceCount}, Bookings: ${bookingCount}, Transactions: ${txCount}`);
    console.log("PASS: All collections responsive");
  } catch (err) {
    console.error("FAIL: Verification error", err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

verify();
