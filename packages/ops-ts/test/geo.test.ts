/**
 * T9 geo tests. Run compiled: node --test dist/test/geo.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineMeters, withinVisitRadius, MAX_DISTANCE_M } from "../src/geo.js";

test("haversine: same point is 0", () => {
  assert.equal(haversineMeters({ lat: 25.9, lng: -80.3 }, { lat: 25.9, lng: -80.3 }), 0);
});

test("haversine: ~1 degree of latitude ≈ 111 km", () => {
  const d = haversineMeters({ lat: 25, lng: -80 }, { lat: 26, lng: -80 });
  assert.ok(d > 110_000 && d < 112_000, `got ${d}`);
});

test("withinVisitRadius: 400 m passes, 600 m fails", () => {
  const biz = { lat: 25.987, lng: -80.357 };
  // ~400 m north: 0.0036 deg latitude ≈ 400 m
  assert.equal(withinVisitRadius({ lat: biz.lat + 0.0036, lng: biz.lng }, biz), true);
  // ~600 m north
  assert.equal(withinVisitRadius({ lat: biz.lat + 0.0054, lng: biz.lng }, biz), false);
});

test("MAX_DISTANCE_M is the 500 m spec radius", () => {
  assert.equal(MAX_DISTANCE_M, 500);
});
