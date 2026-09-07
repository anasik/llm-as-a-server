// Deterministic experiment control plane. Namespaced so it can never be
// confused with the simulated website, and containing no application semantics:
// health, session reset, safe diagnostics, and generic attachment delivery.
import {
  handleHarnessAttachment,
  handleHarnessDiagnostics,
  handleHarnessHealth,
  handleHarnessReset,
} from "../../src/kernel/handle";
import type { KernelEnv } from "../../src/kernel/types";

export const onRequest: PagesFunction<KernelEnv> = async (context) => {
  const control = new URL(context.request.url).pathname.replace(/^\/__harness\/?/, "").replace(/\/$/, "");
  switch (control) {
    case "health":
      return handleHarnessHealth(context.env);
    case "reset":
      return handleHarnessReset(context.request, context.env);
    case "diagnostics":
      return handleHarnessDiagnostics(context.request, context.env);
    case "attachment":
      return handleHarnessAttachment(context.request, context.env);
    default:
      return Response.json({ ok: false, error: "unknown harness control" }, { status: 404 });
  }
};
