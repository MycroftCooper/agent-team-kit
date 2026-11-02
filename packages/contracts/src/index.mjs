// Single entry point for the contracts draft.
//
// DRAFT (M0 / ATK-005): nothing imports this package yet. M1 wires it into the
// pnpm workspace and adds OpenAPI generation (ATK-103).
export * from "./version.mjs";
export * from "./enums.mjs";
export * from "./errors.mjs";
export * from "./dto.mjs";
export * from "./events.mjs";
export * from "./paths.mjs";
export * from "./execution-spec.mjs";
