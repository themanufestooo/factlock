/**
 * Geo helpers (T9). Spec §3: a verification visit must happen within 500 m
 * of the business's registered coordinates, or it is rejected.
 */
import type { GpsPoint } from "./types.js";

const EARTH_M = 6_371_000;
const MAX_DISTANCE_M = 500;

const toRad = (d: number) => (d * Math.PI) / 180;

/** Haversine distance in meters between two GPS points. */
export function haversineMeters(a: GpsPoint, b: GpsPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h =
    s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when the visit point is within the 500 m spec radius. */
export function withinVisitRadius(visit: GpsPoint, business: GpsPoint): boolean {
  return haversineMeters(visit, business) <= MAX_DISTANCE_M;
}

export { MAX_DISTANCE_M };
