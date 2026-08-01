import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      // A git worktree holds a second checkout of THIS repo, so every test file in it matches the
      // default include glob. Without these, a machine with two worktrees runs three full copies of
      // a suite whose tests spawn real CLI backends and containers, which is enough to exhaust it.
      '**/.claude/worktrees/**',
      '**/.worktrees/**',
      '**/worktrees/**',
    ],
  },
})
