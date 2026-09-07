import type { KernelEnv } from "../src/kernel/types";

declare module "cloudflare:test" {
  // Merges the project's bindings into the pool's ProvidedEnv.
  interface ProvidedEnv extends KernelEnv {
    TEST_MIGRATION_SQL: string;
  }
}
