Behavioral Measurement Suite — ATLAS Evolutionary Archive

Three tasks, each designed to probe one behavioral axis of the MAP-Elites archive:

  task-001.json  →  planning_depth   (multi-step trace over two source files)
  task-002.json  →  tool_diversity   (dependency audit requiring Glob+Grep+Bash in combination)
  task-003.json  →  verification_rate (Task Scheduler cross-check requiring separate verification steps per claim)

Scoring: each axis produces a 0-3 bin index (0=low, 3=high) based on the scoringHints in each task file.
A variant's behavioral cell is the triple (planning_depth, tool_diversity, verification_rate).
The archive keeps the best-scoring variant per cell; ties favor the newer variant.
Run tasks against a variant, score its response, then call recordBehavior() in population_engine.mjs.
