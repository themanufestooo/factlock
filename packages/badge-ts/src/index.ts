/** Veritas badge — hosted page + embeddable JS badge (T7). */
export { createBadgeServer } from "./server.js";
export type { BadgeServerOptions } from "./server.js";
export {
  badgePage,
  badgeData,
  badgeScript,
  notFoundPage,
  businessName,
  priceLines,
  dotColor,
  esc,
  pickLang,
  t,
} from "./render.js";
export type { Lang, BadgePageInput, PriceLine } from "./render.js";
