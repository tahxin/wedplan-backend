import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";
import { jwtVerify, createRemoteJWKSet } from "jose";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// ----------------------------------------------------
// Regex escaping helper to prevent ReDoS / 500 on bad regex patterns
// ----------------------------------------------------
/**
 * Escape user input used in $regex queries to prevent ReDoS attacks.
 * Only allows safe characters: alphanumeric, spaces, and common wedding-related symbols.
 * Throws a 400 error if the input contains potentially dangerous regex metacharacters.
 */
function escapeRegexInput(input) {
  if (typeof input !== "string") {
    throw new Error("Input must be a string");
  }
  // Allow only alphanumeric, spaces, apostrophes, ampersands, hyphens, and parentheses
  // Anything else could be used for ReDoS injection
  if (/[^\w\s&'()-]/.test(input)) {
    throw new Error("Invalid characters in search input");
  }
  // Escape regex special characters
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ----------------------------------------------------
// Rate limiting middleware
// ----------------------------------------------------
// Root-level limiter: 100 requests per 15 minutes
const rootLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { success: false, message: "Too many requests from this IP, please try again later." },
});

// Payments endpoint limiter: 10 requests per 15 minutes
const paymentsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { success: false, message: "Too many payment requests, please try again later." },
});

// Bookings endpoint limiter: 50 requests per 15 minutes
const bookingsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: { success: false, message: "Too many booking requests, please try again later." },
});

app.use("/", rootLimiter);
app.use("/payments", paymentsLimiter);
app.use("/bookings", bookingsLimiter);
// CLIENT_URL may hold a comma-separated list; the first entry is the canonical
// origin used for Stripe redirects, all of them are allowed by CORS.
const clientOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const clientUrl = clientOrigins[0] || "http://localhost:3000";
const mongoUri = process.env.MONGODB_URI;
const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
const betterAuthUrl = process.env.BETTER_AUTH_URL || clientUrl;
const stripeSecretKey =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_API_KEY ||
  process.env.STRIPE_API_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

// Categories constant (matching Section 5 of AGENTS.md)
export const CATEGORIES = [
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
];

// Reusable MongoDB client (serverless-friendly; reconnect on stale/closed topology)
let dbClient = null;
let db = null;
let dbConnectPromise = null;

async function getDb() {
  if (!mongoUri) {
    throw new Error("MONGODB_URI is not defined in environment variables");
  }

  if (db && dbClient) {
    try {
      await db.command({ ping: 1 });
      return db;
    } catch {
      db = null;
      try {
        await dbClient.close();
      } catch {
        // ignore close errors on stale client
      }
      dbClient = null;
      dbConnectPromise = null;
    }
  }

  if (!dbConnectPromise) {
    dbConnectPromise = (async () => {
      const client = new MongoClient(mongoUri);
      await client.connect();
      dbClient = client;
      db = client.db("wedplan");
      console.log(`Connected to MongoDB Atlas database: ${db.databaseName}`);
      return db;
    })().catch((err) => {
      db = null;
      dbClient = null;
      dbConnectPromise = null;
      throw err;
    });
  }

  return dbConnectPromise;
}

// Ensure indexes on startup
async function setupIndexes() {
  try {
    const database = await getDb();
    await database.collection("services").createIndex({ status: 1, isActive: 1 });
    await database.collection("services").createIndex({ vendorId: 1 });
    await database.collection("services").createIndex({ category: 1 });
    await database.collection("bookings").createIndex({ vendorId: 1 });
    await database.collection("bookings").createIndex({ customerId: 1 });
    await database.collection("bookings").createIndex({ serviceId: 1 });
    await database.collection("bookings").createIndex(
      { customerId: 1, serviceId: 1, eventDate: 1 },
      {
        unique: true,
        partialFilterExpression: { status: { $in: ["pending", "accepted"] } },
      }
    );
    await database.collection("transactions").createIndex(
      { stripeSessionId: 1 },
      { unique: true, sparse: true }
    );
    await database.collection("transactions").createIndex({ vendorId: 1 });
    console.log("Database indexes verified");
  } catch (err) {
    console.warn("Index setup notice:", err.message);
  }
}

// ----------------------------------------------------
// CORS configuration
// ----------------------------------------------------
const allowedOrigins = [
  ...clientOrigins,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://wedplan-ice.vercel.app",
].filter((origin, index, all) => origin && all.indexOf(origin) === index);

app.use(
  cors({
    origin: (origin, callback) => {
      // Same-origin / server-to-server requests have no Origin header.
      if (!origin) return callback(null, true);

      const normalized = origin.replace(/\/$/, "");
      if (allowedOrigins.includes(normalized)) {
        return callback(null, true);
      }

      return callback(new Error(`Origin ${normalized} is not allowed by CORS`));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "stripe-signature"],
  })
);

// ----------------------------------------------------
// Stripe Webhook (MUST be registered before express.json)
// ----------------------------------------------------
app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!stripe || !stripeWebhookSecret) {
      return res.status(500).json({ success: false, message: "Stripe is not configured" });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const database = await getDb();

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          // H2: Only activate premium on successful payment
          if (session.payment_status !== "paid") {
            break;
          }

          const vendorIdStr = session.metadata?.vendorId;
          const plan = session.metadata?.plan || "premium";

          if (vendorIdStr) {
            const vendorObjectId = ObjectId.isValid(vendorIdStr)
              ? new ObjectId(vendorIdStr)
              : vendorIdStr;

            // Idempotent transaction recording (H1): skip if transaction already exists
            const existingTx = await database.collection("transactions").findOne({
              stripeSessionId: session.id,
            });

            if (!existingTx) {
              await database.collection("transactions").insertOne({
                vendorId: vendorObjectId,
                plan,
                amount: (session.amount_total || 2000) / 100,
                currency: session.currency || "usd",
                stripeSessionId: session.id,
                stripeSubscriptionId: session.subscription || null,
                status: "completed",
                createdAt: new Date(),
              });
            }

            // Grant Premium subscription (1 year validity) - only if not already premium
            const userExists = await database.collection("user").findOne({
              _id: vendorObjectId,
            });

            if (!userExists || userExists.subscriptionPlan !== "premium") {
              const expiresAt = new Date();
              expiresAt.setFullYear(expiresAt.getFullYear() + 1);

              await database.collection("user").updateOne(
                { _id: vendorObjectId },
                {
                  $set: {
                    subscriptionPlan: "premium",
                    subscriptionExpiresAt: expiresAt,
                    updatedAt: new Date(),
                  },
                }
              );
            }
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const tx = await database.collection("transactions").findOne({
            stripeSubscriptionId: subscription.id,
          });

          if (tx?.vendorId) {
            // Revert vendor to free
            await database.collection("user").updateOne(
              { _id: tx.vendorId },
              {
                $set: {
                  subscriptionPlan: "free",
                  subscriptionExpiresAt: null,
                  updatedAt: new Date(),
                },
              }
            );

            // Per open decision #6: deactivate services beyond free limit (max 3 active)
            const activeServices = await database
              .collection("services")
              .find({ vendorId: tx.vendorId, isActive: true })
              .sort({ createdAt: 1 })
              .toArray();

            if (activeServices.length > 3) {
              const toDeactivate = activeServices.slice(3).map((s) => s._id);
              await database.collection("services").updateMany(
                { _id: { $in: toDeactivate } },
                { $set: { isActive: false, updatedAt: new Date() } }
              );
            }
          }
          break;
        }

        default:
          console.log(`Unhandled stripe event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("Error processing webhook:", err);
      res.status(500).json({ success: false, message: "Webhook handler failed" });
    }
  }
);

// Body parser for JSON
app.use(express.json());

// ----------------------------------------------------
// Authentication & Role Middlewares
// ----------------------------------------------------
let remoteJWKS = null;
function getRemoteJWKS() {
  if (!remoteJWKS) {
    remoteJWKS = createRemoteJWKSet(new URL(`${betterAuthUrl}/api/auth/jwks`));
  }
  return remoteJWKS;
}

/**
 * Premium is only valid while `subscriptionExpiresAt` is in the future.
 * Legacy rows seeded without an expiry are treated as active.
 */
export function isSubscriptionActive(user) {
  if (!user || user.subscriptionPlan !== "premium") return false;
  if (!user.subscriptionExpiresAt) return true;
  return new Date(user.subscriptionExpiresAt).getTime() > Date.now();
}

export async function verifyJWT(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authorization token required" });
    }

    const token = authHeader.split(" ")[1].trim();
    if (!token) {
      return res.status(401).json({ success: false, message: "Malformed token" });
    }

    const database = await getDb();
    let userId = null;

    // Strategy 1: Better Auth session token check
    const sessionDoc = await database.collection("session").findOne({
      token,
      expiresAt: { $gt: new Date() },
    });

    if (sessionDoc && sessionDoc.userId) {
      userId = sessionDoc.userId;
    } else {
      // Strategy 2: If token is a JWT, verify with Better Auth Secret or JWKS
      try {
        if (betterAuthSecret) {
          const secretKey = new TextEncoder().encode(betterAuthSecret);
          const { payload } = await jwtVerify(token, secretKey);
          userId = payload.sub || payload.id || payload.userId;
        }
      } catch (jwtErr) {
        // Fallback to JWKS if symmetric verification failed
        try {
          const JWKS = getRemoteJWKS();
          const { payload } = await jwtVerify(token, JWKS);
          userId = payload.sub || payload.id || payload.userId;
        } catch (jwksErr) {
          // Token verification failed
        }
      }
    }

    if (!userId) {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }

    const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : userId;
    const user = await database.collection("user").findOne({ _id: userObjectId });

    if (!user) {
      return res.status(401).json({ success: false, message: "User not found" });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: "Your account is blocked. Please contact support.",
      });
    }

    // H3: Downgrade logic - if subscriptionExpiresAt has passed, transition to free plan
    let premiumActive = false;
    if (user.subscriptionPlan === "premium" && user.subscriptionExpiresAt) {
      premiumActive = new Date(user.subscriptionExpiresAt).getTime() > Date.now();
    } else if (user.subscriptionPlan === "premium" && !user.subscriptionExpiresAt) {
      // Legacy rows without expiry are treated as active (existing behavior)
      premiumActive = true;
    }

    // If premium expired, downgrade to free and deactivate services beyond limit
    if (!premiumActive && user.subscriptionPlan === "premium") {
      // Downgrade plan to free
      await database.collection("user").updateOne(
        { _id: userObjectId },
        {
          $set: {
            subscriptionPlan: "free",
            subscriptionExpiresAt: null,
            updatedAt: new Date(),
          },
        }
      );

      // Deactivate services beyond free limit (max 3 active services)
      const activeServices = await database
        .collection("services")
        .find({ vendorId: user._id, isActive: true })
        .sort({ createdAt: 1 })
        .toArray();

      if (activeServices.length > 3) {
        const toDeactivate = activeServices.slice(3).map((s) => s._id);
        await database.collection("services").updateMany(
          { _id: { $in: toDeactivate } },
          { $set: { isActive: false, updatedAt: new Date() } }
        );
      }
    }

    req.user = {
      id: user._id.toString(),
      _id: user._id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role || "customer",
      isBlocked: Boolean(user.isBlocked),
      businessName: user.businessName || "",
      // An expired premium plan must behave exactly like the free plan.
      subscriptionPlan: premiumActive ? "premium" : "free",
      subscriptionExpiresAt: user.subscriptionExpiresAt || null,
    };

    next();
  } catch (error) {
    console.error("verifyJWT error:", error);
    return res.status(401).json({ success: false, message: "Authentication failed" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: requires one of [${roles.join(", ")}] role`,
      });
    }
    next();
  };
}

// ----------------------------------------------------
// Public / General Endpoints
// ----------------------------------------------------

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "WedPlan API is running",
    timestamp: new Date().toISOString(),
  });
});

// Categories list
app.get("/categories", async (req, res, next) => {
  try {
    const database = await getDb();
    const counts = await database
      .collection("services")
      .aggregate([
        { $match: { status: "approved", isActive: { $ne: false } } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ])
      .toArray();

    const countMap = Object.fromEntries(counts.map((c) => [c._id, c.count]));
    const categoriesWithCount = CATEGORIES.map((cat) => ({
      name: cat,
      count: countMap[cat] || 0,
    }));

    res.json({ success: true, categories: categoriesWithCount });
  } catch (err) {
    next(err);
  }
});

// Featured services (at least 6 approved and active)
app.get("/services/featured", async (req, res, next) => {
  try {
    const database = await getDb();
    const services = await database
      .collection("services")
      .aggregate([
        { $match: { status: "approved", isActive: { $ne: false } } },
        { $sort: { createdAt: -1 } },
        { $limit: 6 },
        {
          $lookup: {
            from: "user",
            localField: "vendorId",
            foreignField: "_id",
            as: "vendor",
          },
        },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            serviceName: 1,
            category: 1,
            description: 1,
            price: 1,
            location: 1,
            images: 1,
            status: 1,
            isActive: 1,
            createdAt: 1,
            vendor: {
              _id: "$vendor._id",
              name: "$vendor.name",
              businessName: "$vendor.businessName",
              email: "$vendor.email",
              image: "$vendor.image",
            },
          },
        },
      ])
      .toArray();

    res.json({ success: true, count: services.length, services });
  } catch (err) {
    next(err);
  }
});

// Browse services (Public, approved+active only, search, filters, sorting)
app.get("/services", async (req, res, next) => {
  try {
    const { search, category, location, sort, page = 1, limit = 12 } = req.query;
    const query = {
      status: "approved",
      isActive: { $ne: false },
    };

    if (search && typeof search === "string" && search.trim()) {
      query.serviceName = { $regex: escapeRegexInput(search.trim()), $options: "i" };
    }

    if (category && typeof category === "string" && category.trim()) {
      query.category = category.trim();
    }

    if (location && typeof location === "string" && location.trim()) {
      query.location = { $regex: escapeRegexInput(location.trim()), $options: "i" };
    }

    const sortOption = {};
    if (sort === "price_asc") {
      sortOption.price = 1;
    } else if (sort === "price_desc") {
      sortOption.price = -1;
    } else {
      sortOption.createdAt = -1;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(50, parseInt(limit, 10) || 12));
    const skip = (pageNum - 1) * limitNum;

    const database = await getDb();
    const total = await database.collection("services").countDocuments(query);

    const services = await database
      .collection("services")
      .aggregate([
        { $match: query },
        { $sort: sortOption },
        { $skip: skip },
        { $limit: limitNum },
        {
          $lookup: {
            from: "user",
            localField: "vendorId",
            foreignField: "_id",
            as: "vendor",
          },
        },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            serviceName: 1,
            category: 1,
            description: 1,
            price: 1,
            location: 1,
            images: 1,
            status: 1,
            isActive: 1,
            createdAt: 1,
            vendor: {
              _id: "$vendor._id",
              name: "$vendor.name",
              businessName: "$vendor.businessName",
              email: "$vendor.email",
              image: "$vendor.image",
            },
          },
        },
      ])
      .toArray();

    res.json({
      success: true,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      services,
    });
  } catch (err) {
    next(err);
  }
});

// Single service details
app.get("/services/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid service ID" });
    }

    const database = await getDb();
    const services = await database
      .collection("services")
      .aggregate([
        {
          $match: {
            _id: new ObjectId(id),
            // Public visibility rule: only approved + active services are readable.
            status: "approved",
            isActive: { $ne: false },
          },
        },
        {
          $lookup: {
            from: "user",
            localField: "vendorId",
            foreignField: "_id",
            as: "vendor",
          },
        },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            serviceName: 1,
            category: 1,
            description: 1,
            price: 1,
            location: 1,
            images: 1,
            status: 1,
            isActive: 1,
            createdAt: 1,
            vendor: {
              _id: "$vendor._id",
              name: "$vendor.name",
              businessName: "$vendor.businessName",
              email: "$vendor.email",
              image: "$vendor.image",
            },
          },
        },
      ])
      .toArray();

    if (!services || services.length === 0) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    res.json({ success: true, service: services[0] });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// Authenticated User Endpoints
// ----------------------------------------------------

// Current user profile
app.get("/me", verifyJWT, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Update profile (whitelisted fields only)
app.patch("/me", verifyJWT, async (req, res, next) => {
  try {
    const { name, image, businessName } = req.body;
    const updates = {};

    if (typeof name === "string" && name.trim()) {
      updates.name = name.trim();
    }
    if (typeof image === "string") {
      updates.image = image.trim();
    }
    if (typeof businessName === "string") {
      updates.businessName = businessName.trim();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No valid fields to update" });
    }

    updates.updatedAt = new Date();
    const database = await getDb();
    await database.collection("user").updateOne({ _id: req.user._id }, { $set: updates });

    const updatedUser = await database.collection("user").findOne({ _id: req.user._id });
    res.json({
      success: true,
      message: "Profile updated successfully",
      user: {
        id: updatedUser._id.toString(),
        name: updatedUser.name,
        email: updatedUser.email,
        image: updatedUser.image,
        role: updatedUser.role || "customer",
        isBlocked: Boolean(updatedUser.isBlocked),
        businessName: updatedUser.businessName || "",
        subscriptionPlan: updatedUser.subscriptionPlan || "free",
        subscriptionExpiresAt: updatedUser.subscriptionExpiresAt || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// Vendor Endpoints (role: vendor)
// ----------------------------------------------------

// Vendor overview statistics
app.get("/vendor/overview", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const database = await getDb();
    const vendorId = req.user._id;

    const [totalServices, activeServices, pendingRequests, acceptedBookings] = await Promise.all([
      database.collection("services").countDocuments({ vendorId }),
      database.collection("services").countDocuments({ vendorId, status: "approved", isActive: true }),
      database.collection("bookings").countDocuments({ vendorId, status: "pending" }),
      database.collection("bookings").countDocuments({ vendorId, status: "accepted" }),
    ]);

    res.json({
      success: true,
      overview: {
        totalServices,
        activeServices,
        pendingRequests,
        acceptedBookings,
        currentPlan: req.user.subscriptionPlan,
        subscriptionExpiresAt: req.user.subscriptionExpiresAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Get vendor's own services
app.get("/vendor/services", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const database = await getDb();
    const services = await database
      .collection("services")
      .find({ vendorId: req.user._id })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, count: services.length, services });
  } catch (err) {
    next(err);
  }
});

// Add new service
app.post("/vendor/services", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const { serviceName, category, description, price, location, images } = req.body;

    if (!serviceName || !category || !description || price === undefined || !location) {
      return res.status(400).json({ success: false, message: "All service fields are required" });
    }

    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({
        success: false,
        message: `Invalid category. Must be one of: ${CATEGORIES.join(", ")}`,
      });
    }

    const numPrice = Number(price);
    if (isNaN(numPrice) || numPrice <= 0) {
      return res.status(400).json({ success: false, message: "Price must be a positive number" });
    }

    const imageArray = Array.isArray(images) ? images : images ? [images] : [];
    const database = await getDb();

    // Enforce Free tier limit (max 3 active services)
    if (req.user.subscriptionPlan !== "premium") {
      const activeCount = await database.collection("services").countDocuments({
        vendorId: req.user._id,
        isActive: true,
        status: { $ne: "rejected" },
      });

      if (activeCount >= 3) {
        return res.status(400).json({
          success: false,
          message:
            "Free plan limit reached (maximum 3 active services). Please upgrade to Premium to publish more.",
        });
      }
    }

    const newService = {
      vendorId: req.user._id,
      serviceName: serviceName.trim(),
      category: category.trim(),
      description: description.trim(),
      price: numPrice,
      location: location.trim(),
      images: imageArray,
      status: "pending", // Always pending upon creation
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await database.collection("services").insertOne(newService);
    newService._id = result.insertedId;

    res.status(201).json({
      success: true,
      message: "Service submitted for approval",
      service: newService,
    });
  } catch (err) {
    next(err);
  }
});

// Update service (vendor ownership check)
app.patch("/vendor/services/:id", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid service ID" });
    }

    const database = await getDb();
    const service = await database.collection("services").findOne({ _id: new ObjectId(id) });

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    if (service.vendorId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "You do not own this service" });
    }

    const { serviceName, category, description, price, location, images } = req.body;
    const updates = {};

    if (serviceName) updates.serviceName = serviceName.trim();
    if (category) {
      if (!CATEGORIES.includes(category)) {
        return res.status(400).json({ success: false, message: "Invalid category" });
      }
      updates.category = category.trim();
    }
    if (description) updates.description = description.trim();
    if (price !== undefined) {
      const numPrice = Number(price);
      if (isNaN(numPrice) || numPrice <= 0) {
        return res.status(400).json({ success: false, message: "Price must be positive" });
      }
      updates.price = numPrice;
    }
    if (location) updates.location = location.trim();
    if (images) updates.images = Array.isArray(images) ? images : [images];

    // If the service was "approved", reset its status to "pending" because it has been edited
    const updatePayload = { ...updates };
    if (service.status === "approved") {
      updatePayload.status = "pending";
    }

    updatePayload.updatedAt = new Date();
    await database.collection("services").updateOne({ _id: new ObjectId(id) }, { $set: updatePayload });

    const updated = await database.collection("services").findOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Service updated successfully", service: updated });
  } catch (err) {
    next(err);
  }
});

// Delete service (vendor ownership check)
app.delete("/vendor/services/:id", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid service ID" });
    }

    const database = await getDb();
    const service = await database.collection("services").findOne({ _id: new ObjectId(id) });

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    if (service.vendorId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "You do not own this service" });
    }

    await database.collection("services").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Service deleted successfully" });
  } catch (err) {
    next(err);
  }
});

// Toggle service availability (isActive)
app.patch("/vendor/services/:id/availability", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid service ID" });
    }

    const database = await getDb();
    const service = await database.collection("services").findOne({ _id: new ObjectId(id) });

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    if (service.vendorId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "You do not own this service" });
    }

    const newActiveState = !service.isActive;

    // If re-activating, enforce Free limit
    if (newActiveState && req.user.subscriptionPlan !== "premium") {
      const activeCount = await database.collection("services").countDocuments({
        vendorId: req.user._id,
        isActive: true,
        status: { $ne: "rejected" },
      });

      if (activeCount >= 3) {
        return res.status(400).json({
          success: false,
          message:
            "Cannot activate service: Free plan limit reached (max 3 active services). Upgrade to Premium to activate more.",
        });
      }
    }

    await database.collection("services").updateOne(
      { _id: new ObjectId(id) },
      { $set: { isActive: newActiveState, updatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: `Service availability set to ${newActiveState ? "active" : "inactive"}`,
      isActive: newActiveState,
    });
  } catch (err) {
    next(err);
  }
});

// Vendor booking requests
app.get("/vendor/bookings", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const database = await getDb();
    const bookings = await database
      .collection("bookings")
      .aggregate([
        { $match: { vendorId: req.user._id } },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "services",
            localField: "serviceId",
            foreignField: "_id",
            as: "service",
          },
        },
        { $unwind: { path: "$service", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "user",
            localField: "customerId",
            foreignField: "_id",
            as: "customer",
          },
        },
        { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            serviceId: 1,
            vendorId: 1,
            customerId: 1,
            eventDate: 1,
            eventLocation: 1,
            message: 1,
            status: 1,
            createdAt: 1,
            service: {
              _id: "$service._id",
              serviceName: "$service.serviceName",
              category: "$service.category",
              price: "$service.price",
              images: "$service.images",
            },
            customer: {
              _id: "$customer._id",
              name: "$customer.name",
              email: "$customer.email",
              image: "$customer.image",
            },
          },
        },
      ])
      .toArray();

    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    next(err);
  }
});

// Vendor accept booking
app.patch("/vendor/bookings/:id/accept", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid booking ID" });
    }

    const database = await getDb();
    const booking = await database.collection("bookings").findOne({ _id: new ObjectId(id) });

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (booking.vendorId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "Booking does not belong to your service" });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Booking cannot be accepted because it is already '${booking.status}'`,
      });
    }

    await database.collection("bookings").updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "accepted", updatedAt: new Date() } }
    );

    res.json({ success: true, message: "Booking accepted successfully", status: "accepted" });
  } catch (err) {
    next(err);
  }
});

// Vendor reject booking
app.patch("/vendor/bookings/:id/reject", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid booking ID" });
    }

    const database = await getDb();
    const booking = await database.collection("bookings").findOne({ _id: new ObjectId(id) });

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (booking.vendorId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "Booking does not belong to your service" });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Booking cannot be rejected because it is already '${booking.status}'`,
      });
    }

    await database.collection("bookings").updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "rejected", updatedAt: new Date() } }
    );

    res.json({ success: true, message: "Booking rejected", status: "rejected" });
  } catch (err) {
    next(err);
  }
});

// Create Stripe Checkout Session for Premium
app.post("/payments/create-checkout-session", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(500).json({ success: false, message: "Stripe is not configured" });
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "WedPlan Vendor Premium Subscription",
              description: "Publish unlimited wedding services and get premium badge and perks.",
            },
            unit_amount: 2000, // $20.00
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payment/cancel`,
      metadata: {
        vendorId: req.user.id,
        plan: "premium",
      },
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    next(err);
  }
});

// Verify & confirm completed Stripe test session (sandbox / webhook backup)
app.post("/payments/confirm-session", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, message: "sessionId is required" });
    }

    if (!stripe) {
      return res.status(500).json({ success: false, message: "Stripe is not configured" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Verify session belongs to the vendor and was paid
    if (session.metadata?.vendorId !== req.user.id) {
      return res.status(403).json({ success: false, message: "Session metadata mismatch" });
    }

    if (session.payment_status !== "paid") {
      return res.status(400).json({ success: false, message: "Payment has not been completed" });
    }

    const database = await getDb();
    const vendorObjectId = req.user._id;

    // Idempotent transaction save: only grant if not already premium (H1)
    const existingUser = await database.collection("user").findOne({
      _id: vendorObjectId,
    });

    if (existingUser && existingUser.subscriptionPlan === "premium") {
      // Already premium - just return current state without re-granting
      return res.json({
        success: true,
        plan: existingUser.subscriptionPlan,
        expiresAt: existingUser.subscriptionExpiresAt,
      });
    }

    // Idempotent transaction record
    const existingTx = await database.collection("transactions").findOne({
      stripeSessionId: session.id,
    });

    if (!existingTx) {
      await database.collection("transactions").insertOne({
        vendorId: vendorObjectId,
        plan: "premium",
        amount: (session.amount_total || 2000) / 100,
        currency: session.currency || "usd",
        stripeSessionId: session.id,
        stripeSubscriptionId: session.subscription || null,
        status: "completed",
        createdAt: new Date(),
      });
    }

    // Grant Premium subscription (1 year validity) - only if not already premium
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    await database.collection("user").updateOne(
      { _id: vendorObjectId },
      {
        $set: {
          subscriptionPlan: "premium",
          subscriptionExpiresAt: expiresAt,
          updatedAt: new Date(),
        },
      }
    );

    res.json({ success: true, plan: "premium", expiresAt });
  } catch (err) {
    next(err);
  }
});

// Vendor subscription info
app.get("/vendor/subscription", verifyJWT, requireRole("vendor"), async (req, res) => {
  res.json({
    success: true,
    plan: req.user.subscriptionPlan,
    expiresAt: req.user.subscriptionExpiresAt,
  });
});

// ----------------------------------------------------
// Customer Endpoints (role: customer)
// ----------------------------------------------------

// Submit booking request
app.post("/bookings", verifyJWT, requireRole("customer"), async (req, res, next) => {
  try {
    const { serviceId, eventDate, eventLocation, message } = req.body;

    if (!serviceId || !eventDate || !eventLocation) {
      return res.status(400).json({
        success: false,
        message: "serviceId, eventDate, and eventLocation are required",
      });
    }

    if (!ObjectId.isValid(serviceId)) {
      return res.status(404).json({ success: false, message: "Invalid service ID" });
    }

    // Validate the date up front: an unparseable value used to throw inside
    // toISOString() and surface as an opaque 500.
    const parsedDate = new Date(eventDate);
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "eventDate must be a valid date (YYYY-MM-DD)",
      });
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (parsedDate < startOfToday) {
      return res.status(400).json({ success: false, message: "eventDate cannot be in the past" });
    }

    const eventDateIso = parsedDate.toISOString().split("T")[0];

    const database = await getDb();
    const service = await database.collection("services").findOne({ _id: new ObjectId(serviceId) });

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    if (service.status !== "approved" || service.isActive === false) {
      return res.status(400).json({
        success: false,
        message: "This service is currently unavailable for booking",
      });
    }

    // Prevent vendor self-booking
    if (service.vendorId.toString() === req.user.id) {
      return res.status(400).json({ success: false, message: "You cannot book your own service" });
    }

    // Duplicate booking protection (same customer + service + date pending/accepted)
    const existing = await database.collection("bookings").findOne({
      customerId: req.user._id,
      serviceId: service._id,
      eventDate: eventDateIso,
      status: { $in: ["pending", "accepted"] },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "You already have an active booking request for this service on this date.",
      });
    }

    const booking = {
      serviceId: service._id,
      vendorId: service.vendorId,
      customerId: req.user._id,
      eventDate: eventDateIso,
      eventLocation: eventLocation.trim(),
      message: message ? message.trim() : "",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await database.collection("bookings").insertOne(booking);
    booking._id = result.insertedId;

    res.status(201).json({
      success: true,
      message: "Booking request submitted successfully",
      booking,
    });
  } catch (err) {
    next(err);
  }
});

// Customer overview stats
app.get("/customer/overview", verifyJWT, requireRole("customer"), async (req, res, next) => {
  try {
    const database = await getDb();
    const customerId = req.user._id;

    const [total, pending, accepted, rejected, cancelled] = await Promise.all([
      database.collection("bookings").countDocuments({ customerId }),
      database.collection("bookings").countDocuments({ customerId, status: "pending" }),
      database.collection("bookings").countDocuments({ customerId, status: "accepted" }),
      database.collection("bookings").countDocuments({ customerId, status: "rejected" }),
      database.collection("bookings").countDocuments({ customerId, status: "cancelled" }),
    ]);

    res.json({
      success: true,
      overview: { total, pending, accepted, rejected, cancelled },
    });
  } catch (err) {
    next(err);
  }
});

// Customer list bookings
app.get("/customer/bookings", verifyJWT, requireRole("customer"), async (req, res, next) => {
  try {
    const database = await getDb();
    const bookings = await database
      .collection("bookings")
      .aggregate([
        { $match: { customerId: req.user._id } },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "services",
            localField: "serviceId",
            foreignField: "_id",
            as: "service",
          },
        },
        { $unwind: { path: "$service", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "user",
            localField: "vendorId",
            foreignField: "_id",
            as: "vendor",
          },
        },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            serviceId: 1,
            vendorId: 1,
            customerId: 1,
            eventDate: 1,
            eventLocation: 1,
            message: 1,
            status: 1,
            createdAt: 1,
            service: {
              _id: "$service._id",
              serviceName: "$service.serviceName",
              category: "$service.category",
              price: "$service.price",
              images: "$service.images",
              location: "$service.location",
            },
            vendor: {
              _id: "$vendor._id",
              name: "$vendor.name",
              businessName: "$vendor.businessName",
              email: "$vendor.email",
              image: "$vendor.image",
            },
          },
        },
      ])
      .toArray();

    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    next(err);
  }
});

// Customer single booking
app.get("/customer/bookings/:id", verifyJWT, requireRole("customer"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid booking ID" });
    }

    const database = await getDb();
    const bookings = await database
      .collection("bookings")
      .aggregate([
        { $match: { _id: new ObjectId(id), customerId: req.user._id } },
        {
          $lookup: {
            from: "services",
            localField: "serviceId",
            foreignField: "_id",
            as: "service",
          },
        },
        { $unwind: { path: "$service", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "user",
            localField: "vendorId",
            foreignField: "_id",
            as: "vendor",
          },
        },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
      ])
      .toArray();

    if (!bookings || bookings.length === 0) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    res.json({ success: true, booking: bookings[0] });
  } catch (err) {
    next(err);
  }
});

// Customer cancel pending booking
app.patch("/customer/bookings/:id/cancel", verifyJWT, requireRole("customer"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid booking ID" });
    }

    const database = await getDb();
    const booking = await database.collection("bookings").findOne({ _id: new ObjectId(id) });

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (booking.customerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "You can only cancel your own bookings" });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Only pending bookings can be cancelled. Current status is '${booking.status}'`,
      });
    }

    await database.collection("bookings").updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "cancelled", updatedAt: new Date() } }
    );

    res.json({ success: true, message: "Booking cancelled successfully", status: "cancelled" });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// Admin Endpoints (role: admin)
// ----------------------------------------------------

// Admin overview stats
app.get("/admin/overview", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const database = await getDb();

    const [
      totalUsers,
      totalVendors,
      totalCustomers,
      totalServices,
      pendingServices,
      totalTransactions,
    ] = await Promise.all([
      database.collection("user").countDocuments({}),
      database.collection("user").countDocuments({ role: "vendor" }),
      database.collection("user").countDocuments({ role: "customer" }),
      database.collection("services").countDocuments({}),
      database.collection("services").countDocuments({ status: "pending" }),
      database.collection("transactions").countDocuments({}),
    ]);

    res.json({
      success: true,
      overview: {
        totalUsers,
        totalVendors,
        totalCustomers,
        totalServices,
        pendingServices,
        totalTransactions,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Admin list users with search and filter
app.get("/admin/users", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const { search, role } = req.query;
    const query = {};

    if (search && typeof search === "string" && search.trim()) {
      query.$or = [
        { name: { $regex: search.trim(), $options: "i" } },
        { email: { $regex: search.trim(), $options: "i" } },
      ];
    }

    if (role && ["customer", "vendor", "admin"].includes(role)) {
      query.role = role;
    }

    const database = await getDb();
    const users = await database
      .collection("user")
      .find(query)
      .project({
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        isBlocked: 1,
        businessName: 1,
        subscriptionPlan: 1,
        createdAt: 1,
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, count: users.length, users });
  } catch (err) {
    next(err);
  }
});

// Admin single user
app.get("/admin/users/:id", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid user ID" });
    }

    const database = await getDb();
    const user = await database.collection("user").findOne(
      { _id: new ObjectId(id) },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          isBlocked: 1,
          businessName: 1,
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
          createdAt: 1,
        },
      }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

// Admin block user
app.patch("/admin/users/:id/block", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid user ID" });
    }

    if (id === req.user.id) {
      return res.status(400).json({ success: false, message: "You cannot block yourself" });
    }

    const database = await getDb();
    await database.collection("user").updateOne(
      { _id: new ObjectId(id) },
      { $set: { isBlocked: true, updatedAt: new Date() } }
    );

    // Invalidate active sessions
    await database.collection("session").deleteMany({ userId: new ObjectId(id) });

    res.json({ success: true, message: "User blocked successfully", isBlocked: true });
  } catch (err) {
    next(err);
  }
});

// Admin unblock user
app.patch("/admin/users/:id/unblock", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid user ID" });
    }

    const database = await getDb();
    await database.collection("user").updateOne(
      { _id: new ObjectId(id) },
      { $set: { isBlocked: false, updatedAt: new Date() } }
    );

    res.json({ success: true, message: "User unblocked successfully", isBlocked: false });
  } catch (err) {
    next(err);
  }
});

// Admin list services
app.get("/admin/services", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const { search, status, category } = req.query;
    const query = {};

    if (search && typeof search === "string" && search.trim()) {
      query.serviceName = { $regex: search.trim(), $options: "i" };
    }
    if (status && ["pending", "approved", "rejected"].includes(status)) {
      query.status = status;
    }
    if (category && typeof category === "string") {
      query.category = category;
    }

    const database = await getDb();
    const services = await database
      .collection("services")
      .aggregate([
        { $match: query },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "user",
            localField: "vendorId",
            foreignField: "_id",
            as: "vendor",
          },
        },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            serviceName: 1,
            category: 1,
            description: 1,
            price: 1,
            location: 1,
            images: 1,
            status: 1,
            isActive: 1,
            createdAt: 1,
            vendor: {
              _id: "$vendor._id",
              name: "$vendor.name",
              businessName: "$vendor.businessName",
              email: "$vendor.email",
            },
          },
        },
      ])
      .toArray();

    res.json({ success: true, count: services.length, services });
  } catch (err) {
    next(err);
  }
});

// Admin approve service
app.patch("/admin/services/:id/approve", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid service ID" });
    }

    const database = await getDb();
    const result = await database.collection("services").updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "approved", updatedAt: new Date() } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    res.json({ success: true, message: "Service approved successfully", status: "approved" });
  } catch (err) {
    next(err);
  }
});

// Admin reject service
app.patch("/admin/services/:id/reject", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid service ID" });
    }

    const database = await getDb();
    const result = await database.collection("services").updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "rejected", updatedAt: new Date() } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    res.json({ success: true, message: "Service rejected", status: "rejected" });
  } catch (err) {
    next(err);
  }
});

// Admin change service status
app.patch("/admin/services/:id/status", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid service ID" });
    }

    if (!["pending", "approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be one of 'pending', 'approved', 'rejected'",
      });
    }

    const database = await getDb();
    const result = await database.collection("services").updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    res.json({ success: true, message: `Service status updated to ${status}`, status });
  } catch (err) {
    next(err);
  }
});

// Admin delete any service
app.delete("/admin/services/:id", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: "Invalid service ID" });
    }

    const database = await getDb();
    const result = await database.collection("services").deleteOne({ _id: new ObjectId(id) });

    if (!result.deletedCount) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    res.json({ success: true, message: "Service deleted by admin" });
  } catch (err) {
    next(err);
  }
});

// Admin list transactions (read-only)
app.get("/admin/transactions", verifyJWT, requireRole("admin"), async (req, res, next) => {
  try {
    const database = await getDb();
    const transactions = await database
      .collection("transactions")
      .aggregate([
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "user",
            localField: "vendorId",
            foreignField: "_id",
            as: "vendor",
          },
        },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            plan: 1,
            amount: 1,
            currency: 1,
            stripeSessionId: 1,
            stripeSubscriptionId: 1,
            status: 1,
            createdAt: 1,
            vendor: {
              _id: "$vendor._id",
              name: "$vendor.name",
              businessName: "$vendor.businessName",
              email: "$vendor.email",
            },
          },
        },
      ])
      .toArray();

    res.json({ success: true, count: transactions.length, transactions });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// Central Error Handler (Section 7: consistent JSON)
// ----------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Duplicate key from the partial unique booking index -> a real 409.
  if (err?.code === 11000) {
    return res.status(409).json({
      success: false,
      message: "You already have an active booking request for this service on this date.",
    });
  }

  // A rejected CORS origin is an authorisation problem, not a server fault.
  if (typeof err?.message === "string" && err.message.includes("not allowed by CORS")) {
    return res.status(403).json({ success: false, message: "Origin not allowed" });
  }

  console.error("Unhandled error:", err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

// ----------------------------------------------------
// Server Listen
// ----------------------------------------------------
if (process.env.NODE_ENV !== "test") {
  setupIndexes().then(() => {
    app.listen(port, () => {
      console.log(`WedPlan server listening on port ${port}`);
    });
  });
}

export default app;