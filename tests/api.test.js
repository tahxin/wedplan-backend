process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

const { default: app, CATEGORIES } = await import("../index.js");

test("Backend API Module & Route Verification", async (t) => {
  await t.test("should export a valid Express application instance", () => {
    assert.equal(typeof app, "function");
    assert.equal(typeof app.use, "function");
    assert.equal(typeof app.listen, "function");
  });

  await t.test("should export predefined wedding categories matching specification", () => {
    assert.ok(Array.isArray(CATEGORIES));
    assert.equal(CATEGORIES.length, 6);
    assert.ok(CATEGORIES.includes("Photography & Videography"));
    assert.ok(CATEGORIES.includes("Wedding Venues"));
    assert.ok(CATEGORIES.includes("Decoration & Florist"));
    assert.ok(CATEGORIES.includes("Catering Services"));
    assert.ok(CATEGORIES.includes("Makeup & Styling"));
    assert.ok(CATEGORIES.includes("Wedding Fashion"));
  });

  await t.test("should have required route handlers configured", () => {
    // Check that Express router stack has registered handlers in Express 5
    const stack = app.router?.stack || [];
    assert.ok(stack.length >= 25, "Expected at least 25 registered middleware and route layers");
  });
});
