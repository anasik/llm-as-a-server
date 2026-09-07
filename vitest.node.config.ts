import { defineProject } from "vitest/config";

// The static architecture audit. The sanitizer runs in the Workers project
// instead, since HTMLRewriter only exists in the Workers runtime.
export default defineProject({
  test: {
    name: "audit",
    include: ["test/**/*.node.test.ts"],
    environment: "node",
  },
});
