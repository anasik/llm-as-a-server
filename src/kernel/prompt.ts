// Prompt construction.
//
// The prefix has three parts in a fixed order: the runtime contract (identical
// in every deployment), the site definition (whatever this deployment is), and
// the enforced output schema. Message order is chosen for automatic prompt
// caching, which keys on an exact shared prefix: all three are byte-stable, so
// only the per-request state, request and any bounded filesystem results vary.
import { CONTRACT, SITE } from "./constitution.generated";
import { OUTPUT_SCHEMA } from "./schema";
import type { NormalizedRequest } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SCHEMA_BLOCK = [
  "OUTPUT CONTRACT (enforced by the runtime; violations are rejected and nothing is persisted):",
  JSON.stringify(OUTPUT_SCHEMA.schema),
  "Return exactly one JSON object matching this schema. No prose, no code fences.",
].join("\n");

// One system message, not several. Some OpenAI-compatible surfaces (Gemini's
// among them) keep only a single system message and silently drop the rest,
// which would hand the model the schema without the contract — schema-valid
// output with no idea what the site is. Concatenating is byte-stable, so prompt
// caching is unaffected.
const PREFIX = `${CONTRACT}\n\n${SITE}\n\n${SCHEMA_BLOCK}`;

function stablePrefix(): ChatMessage[] {
  return [{ role: "system", content: PREFIX }];
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
