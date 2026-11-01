// Internal-only surface shared by the two Store implementations.
//
// `importStateJson`/`exportStateJson` need information that must not leak into
// the public Store contract (§1): the original legacy object stored with an
// imported task/project, so `atk export` can round-trip the pre-migration file,
// and the real PRAGMA values of the open connection (used by tests to prove WAL
// / foreign_keys are genuinely on, not just intended).
//
// The property is a symbol so JSON serialisation, Object.keys() and API
// responses never see it. This is additive: the contract surface is unchanged.
export const INTERNAL = Symbol.for("@atk/database.internal");
