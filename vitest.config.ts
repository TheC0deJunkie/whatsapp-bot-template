import { defineConfig } from 'vitest/config';

// 260617-1fv — Root vitest config.
//
// WHY: vitest's default scan picked up the agent worktrees under
// .claude/worktrees/* — 11 leftover copies → 561 stale spec files → false
// failures and ~34s runs. `test.exclude` REPLACES (does not merge) vitest's
// defaults, so the 5 standard default-exclude globs are re-listed below and
// '**/.claude/**' is added. This is the backend config only —
// frontend/vitest.config.ts is a separate React app config.
//
// 260816-h3y — '**/frontend/**' added to actually ENFORCE that last sentence.
// The root scan had always collected frontend/src/**/*.test.ts; it just never
// failed, because the only frontend test at the time (test/example.test.ts)
// imports nothing. The first frontend test with a real '@/…' import blew up
// here with "Cannot find package '@/lib/api'" — that alias is defined in
// frontend/vite.config.ts, which this config never loads. Run frontend tests
// with `cd frontend && npx vitest run`.
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      '**/.claude/**',
      '**/frontend/**',
    ],
  },
});
