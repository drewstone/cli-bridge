import { defineConfig } from 'vitest/config'

// The gate owns this budget; Vitest otherwise derives workers from host parallelism.
const workerBudget = process.env.VITEST_MAX_WORKERS
const maxWorkers = workerBudget === undefined ? undefined : Number(workerBudget)
if (maxWorkers !== undefined && (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1)) {
  throw new Error('VITEST_MAX_WORKERS must be a positive integer')
}

export default defineConfig({
  test: {
    maxWorkers,
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      // A git worktree holds a second checkout of THIS repo, so every test file in it matches the
      // default include glob. Without these, a machine with two worktrees runs three full copies of
      // a suite whose tests spawn real CLI backends and containers, which is enough to exhaust it.
      '**/.claude/worktrees/**',
      '**/.worktrees/**',
    ],
  },
})
