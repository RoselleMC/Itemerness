// Environment-neutral exports. The canvas painter needs DOM types and lives behind
// `@itemerness/mc-render/canvas` so a Node service can depend on measurement and geometry without
// pretending it has a document.
export * from "./colors.js";
export * from "./fonts.js";
export * from "./measure.js";
export * from "./wrap.js";
export * from "./drawlist.js";
export * from "./tooltip.js";
export * from "./fidelity.js";
export * from "./compose.js";
