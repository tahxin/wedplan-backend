import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { hashPassword } from "./scripts/password.js";

dotenv.config();

const sampleServices = [
  {
    serviceName: "Fairytale Chateau & Grand Ballroom",
    category: "Wedding Venues",
    description: "An enchanting historic estate featuring sculpted gardens, crystal chandeliers, and seating for up to 350 guests. Includes bridal suite and full day access.",
    price: 4500,
    location: "Hudson Valley, NY",
    images: [
      "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1544077960-604201fe74bc?auto=format&fit=crop&w=800&q=80",
    ],
    status: "approved",
    isActive: true,
  },
  {
    serviceName: "Golden Hour Cinematic Photo & Video",
    category: "Photography & Videography",
    description: "Complete full-day wedding coverage with 2 lead photographers, drone cinematography, 4K highlight reel, and full digital gallery delivery within 3 weeks.",
    price: 3200,
    location: "New York, NY",
    images: [
      "https://images.unsplash.com/photo-1519741497674-611481863552?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1606800052052-a08af7148866?auto=format&fit=crop&w=800&q=80",
    ],
    status: "approved",
    isActive: true,
  },
  {
    serviceName: "Romantic Garden Florals & Arch Styling",
    category: "Decoration & Florist",
    description: "Custom floral design including ceremony arch, bridal bouquet, 10 table centerpieces, and candlelit aisle runners tailored to your palette.",
    price: 1800,
    location: "Brooklyn, NY",
    images: [
      "https://images.unsplash.com/photo-1526047932273-341f2a7631f9?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1561181286-d3fee7d55364?auto=format&fit=crop&w=800&q=80",
    ],
    status: "approved",
    isActive: true,
  },
  {
    serviceName: "Farm-to-Table Gourmet Plated Catering",
    category: "Catering Services",
    description: "Five-course bespoke seasonal menu with cocktail hour hors d'oeuvres, organic local produce, premium wine pairings, and professional waitstaff.",
    price: 6500,
    location: "Long Island, NY",
    images: [
      "https://images.unsplash.com/photo-1555244162-803834f70033?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=800&q=80",
    ],
    status: "approved",
    isActive: true,
  },
  {
    serviceName: "Radiant Bridal Glam & Hair Artistry",
    category: "Makeup & Styling",
    description: "Luxury bridal makeup with airbrushing, trial run, lashes, and hair styling for the bride and up to 4 bridesmaids on location.",
    price: 1200,
    location: "Manhattan, NY",
    images: [
      "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
    ],
    status: "approved",
    isActive: true,
  },
  {
    serviceName: "Bespoke Silk Gowns & Custom Tuxedos",
    category: "Wedding Fashion",
    description: "Custom bridal atelier fittings, silk European lace gowns, and bespoke made-to-measure Italian wool tuxedos for the wedding party.",
    price: 2800,
    location: "SoHo, NY",
    images: [
      "https://images.unsplash.com/photo-1594552072238-b8a33785b261?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=800&q=80",
    ],
    status: "approved",
    isActive: true,
  },
];

async function seed() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI missing in .env");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db();

    // Find or create a default vendor for demo services.
    // Users must always get a matching credential `account` document, otherwise
    // Better Auth can never sign them in (INVALID_EMAIL_OR_PASSWORD).
    let vendor = await db.collection("user").findOne({ role: "vendor" });
    if (!vendor) {
      const now = new Date();
      const newVendor = {
        name: "Grand Mirage Wedding Co.",
        email: "studio@grandmirage.com",
        emailVerified: false,
        role: "vendor",
        businessName: "Grand Mirage Wedding Co.",
        subscriptionPlan: "premium",
        subscriptionExpiresAt: null,
        isBlocked: false,
        createdAt: now,
        updatedAt: now,
      };
      const res = await db.collection("user").insertOne(newVendor);
      vendor = { _id: res.insertedId, ...newVendor };
      console.log("Created demo vendor account:", vendor.email);
    }

    // Attach a credential account so the demo vendor can actually sign in.
    const demoPassword = process.env.DEMO_VENDOR_PASSWORD;
    const vendorAccount = await db
      .collection("account")
      .findOne({ userId: vendor._id, providerId: "credential" });

    if (!vendorAccount) {
      if (demoPassword) {
        const now = new Date();
        await db.collection("account").insertOne({
          accountId: vendor._id.toString(),
          providerId: "credential",
          userId: vendor._id,
          password: await hashPassword(demoPassword),
          createdAt: now,
          updatedAt: now,
        });
        console.log("Attached a credential account to the demo vendor.");
      } else {
        console.warn(
          "Demo vendor has no credential account and DEMO_VENDOR_PASSWORD is not set.\n" +
            "Run: npm run demo:account -- studio@grandmirage.com <password> vendor"
        );
      }
    }

    const servicesCount = await db.collection("services").countDocuments();
    if (servicesCount === 0) {
      const preparedServices = sampleServices.map((s) => ({
        ...s,
        vendorId: vendor._id,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      await db.collection("services").insertMany(preparedServices);
      console.log(`Seeded ${preparedServices.length} sample wedding services.`);
    } else {
      console.log(`Database already has ${servicesCount} services. Skipping seed.`);
    }
  } catch (err) {
    console.error("Seed error:", err);
  } finally {
    await client.close();
  }
}

seed();
