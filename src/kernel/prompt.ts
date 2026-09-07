// Prompt construction.
//
// Message order is chosen for automatic prompt caching, which keys on an exact
// shared prefix: the constitution and the output contract are byte-stable and
// come first; the per-request state, the request itself and any bounded
// filesystem results come last.
import { CONSTITUTION } from "./constitution.generated";
import { OUTPUT_SCHEMA } from "./schema";
import type { NormalizedRequest } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Stable prefix. Byte-identical on every request, so a provider can cache it.
const CONTRACT = [
  "OUTPUT CONTRACT (enforced by the runtime; violations are rejected and nothing is persisted):",
  JSON.stringify(OUTPUT_SCHEMA.schema),
  "Return exactly one JSON object matching this schema. No prose, no code fences.",
].join("\n");

// One system message, not two. Some OpenAI-compatible surfaces (Gemini's among
// them) keep only a single system message and silently drop the rest, which
// would hand the model the schema without the constitution — schema-valid
// output with no idea what the site is. Merging is byte-stable, so prompt
// caching is unaffected.
function stablePrefix(): ChatMessage[] {
  return [{ role: "system", content: `${CONSTITUTION}\n\n${CONTRACT}` }];
}

export function buildTransitionMessages(stateJson: string, request: NormalizedRequest): ChatMessage[] {
  return [
    ...stablePrefix(),
    {
      role: "user",
      content: [
        "CURRENT_STATE (opaque to the runtime; this is your own document):",
        stateJson,
        "",
        "HTTP_REQUEST:",
        JSON.stringify(request),
      ].join("\n"),
    },
  ];
}

export function buildSecondInferenceMessages(
  stateJson: string,
  request: NormalizedRequest,
  emittedRequest: unknown,
  results: unknown,
): ChatMessage[] {
  return [
    ...buildTransitionMessages(stateJson, request),
    { role: "assistant", content: JSON.stringify({ kind: "filesystem_request", filesystem_request: emittedRequest }) },
    {
      role: "user",
      content: [
        "FILESYSTEM_RESULTS (bounded, from your private namespace only):",
        JSON.stringify(results),
        "",
        'You must now return kind:"final". A second filesystem_request is rejected and the request fails.',
      ].join("\n"),
    },
  ];
}
