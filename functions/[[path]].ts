// Every request to this origin, on any path and with any method, arrives here.
//
// There is exactly one handler and no branch in this file that depends on what
// the requested path means. The response the visitor's browser receives is an
// ordinary HTTP response whose status, headers and body were decided entirely
// by the model.
import { handleSimulatedRequest } from "../src/kernel/handle";
import type { KernelEnv } from "../src/kernel/types";

export const onRequest: PagesFunction<KernelEnv> = async (context) =>
  handleSimulatedRequest(context.request, context.env);
