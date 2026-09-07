// The strict JSON Schema handed to Groq Structured Outputs.
//
// Constraints verified against the live provider (2026-09):
//   * the root schema must be type "object"; anyOf/oneOf/enum at the root are
//     rejected, so the discriminated union is expressed as a flat object with a
//     `kind` discriminator and nullable branches;
//   * every object must set additionalProperties:false and list all properties
//     as required, which makes free-form JSON inexpressible — hence
//     `next_state` is a *string* holding the serialized opaque state document.
//     That is also the most opaque representation available: the kernel only
//     checks that it parses and fits the size cap.
//
// This object is frozen and stringified once so the cached prompt prefix stays
// byte-stable across requests.
export const OUTPUT_SCHEMA = {
  name: "server_transition",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "response", "next_state", "filesystem_mutations", "filesystem_request"],
    properties: {
      kind: { type: "string", enum: ["final", "filesystem_request"] },
      response: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["status", "headers", "body"],
            properties: {
              status: { type: "integer" },
              headers: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "value"],
                  properties: { name: { type: "string" }, value: { type: "string" } },
                },
              },
              body: { type: "string" },
            },
          },
          { type: "null" },
        ],
      },
      next_state: { type: ["string", "null"] },
      filesystem_mutations: {
        anyOf: [
          {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["op", "path", "encoding", "content", "content_type", "necessity"],
              properties: {
                op: { type: "string", enum: ["write", "delete"] },
                path: { type: "string" },
                encoding: { type: ["string", "null"], enum: ["utf8", "base64", null] },
                content: { type: ["string", "null"] },
                content_type: { type: ["string", "null"] },
                necessity: { type: "string" },
              },
            },
          },
          { type: "null" },
        ],
      },
      filesystem_request: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["necessity", "operations"],
            properties: {
              necessity: { type: "string" },
              operations: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["op", "path", "limit", "max_bytes"],
                  properties: {
                    op: { type: "string", enum: ["list", "stat", "read"] },
                    path: { type: "string" },
                    limit: { type: ["integer", "null"] },
                    max_bytes: { type: ["integer", "null"] },
                  },
                },
              },
            },
          },
          { type: "null" },
        ],
      },
    },
  },
} as const;

export const OUTPUT_SCHEMA_JSON = JSON.stringify(OUTPUT_SCHEMA);
