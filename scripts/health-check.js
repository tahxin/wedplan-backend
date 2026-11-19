import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  console.error("FAIL: MONGODB_URI is not configured");
  process.exit(1);
}

async function runHealthCheck() {
  const startTime = Date.now();
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });

  try {
    await client.connect();
    const pingResult = await client.db().admin().ping();
    const latency = Date.now() - startTime;

    console.log("=== WedPlan Infrastructure Health ===");
    console.log(`Database: Connected (${latency}ms round-trip)`);
    console.log(`Admin Ping Result: ${JSON.stringify(pingResult)}`);
    console.log("Status: HEALTHY");
    process.exit(0);
  } catch (err) {
    console.error("Status: UNHEALTHY");
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    await client.close();
  }
}

runHealthCheck();
