import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  console.error("FAIL: MONGODB_URI is not set");
  process.exit(1);
}

async function exportSummary() {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db();

    const collections = await db.listCollections().toArray();
    console.log("=== WedPlan Database Summary ===");
    console.log(`Connected to: ${db.databaseName}`);
    console.log(`Total Collections: ${collections.length}\n`);

    for (const col of collections) {
      const count = await db.collection(col.name).countDocuments();
      const sample = await db.collection(col.name).findOne({});
      const fields = sample ? Object.keys(sample).join(", ") : "(empty)";
      console.log(`- ${col.name} (${count} documents)`);
      console.log(`  Schema fields: ${fields}`);
    }

    console.log("\n=== Summary complete ===");
  } catch (err) {
    console.error("Export error:", err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

exportSummary();
