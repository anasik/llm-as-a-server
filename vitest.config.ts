import { defineConfig } from "vitest/config";

// Two projects: the kernel runs against real local D1 and R2 bindings in the
// Workers runtime; the sanitizer and the static architecture audit run in Node.
export default defineConfig({
  test: {
    projects: ["./vitest.workers.config.ts", "./vitest.node.config.ts"],
  },
});
