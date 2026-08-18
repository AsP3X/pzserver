-- Objectives were a second, flatter copy of what a flow already is.
--
-- An `objectives` row carried kind/goal/xp/coins/cadence/active; a flow's
-- `task`/`objective` node carries measure/goal/xp/coins/cadence in its graph
-- JSON. Same two enums on both sides, two near-identical completion tables,
-- and two claim paths that both ended in the same account_progress + wallet
-- credit. Flows are the superset — they also carry audience, dependencies and
-- reward nodes — so a flow holding one condition node *is* an objective.
--
-- Dropped rather than migrated because both tables were empty: this lands
-- before launch, while no player has progress to carry over. After launch this
-- would have needed a row-by-row rewrite into single-node graphs.
--
-- account_progress is deliberately kept. It holds account XP, which flows award
-- exactly as objectives did, and it is referenced by the rank view.

DROP TABLE IF EXISTS objective_completions;
DROP TABLE IF EXISTS objectives;
