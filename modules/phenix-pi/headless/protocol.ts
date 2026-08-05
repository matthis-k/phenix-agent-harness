import { type TProperties, Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";

const IdType = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});
const NonEmptyStringType = Type.String({ minLength: 1 });
const ThinkingLevelType = Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const AuthMethodType = Type.Enum(["oauth", "api_key"]);
const StreamingBehaviorType = Type.Enum(["steer", "follow_up"]);
const ImageType = Type.Object(
  {
    mediaType: NonEmptyStringType,
    data: Type.String(),
  },
  { additionalProperties: false },
);
const ModelRefType = Type.Object(
  {
    provider: NonEmptyStringType,
    model: NonEmptyStringType,
  },
  { additionalProperties: false },
);

export interface HeadlessClientInformation {
  readonly name: string;
  readonly build: string;
}

export interface HeadlessImage {
  readonly mediaType: string;
  readonly data: string;
}

export interface HeadlessModelRef {
  readonly provider: string;
  readonly model: string;
}

export type HeadlessThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type HeadlessAuthMethod = "oauth" | "api_key";
export type HeadlessStreamingBehavior = "steer" | "follow_up";

export type HeadlessAuthResponse =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "secret"; readonly value: string }
  | { readonly kind: "selected"; readonly value: string }
  | { readonly kind: "manual_code"; readonly value: string }
  | { readonly kind: "cancelled" };

export type HeadlessExtensionUiResponse =
  | { readonly kind: "selected"; readonly value: string }
  | { readonly kind: "confirmed"; readonly value: boolean }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "cancelled" };

export type HeadlessCommand =
  | { readonly type: "initialize"; readonly client: HeadlessClientInformation }
  | { readonly type: "snapshot.request" }
  | {
      readonly type: "prompt.submit";
      readonly runId: string;
      readonly text: string;
      readonly images: readonly HeadlessImage[];
      readonly streamingBehavior?: HeadlessStreamingBehavior;
    }
  | {
      readonly type: "prompt.steer";
      readonly runId: string;
      readonly text: string;
      readonly images: readonly HeadlessImage[];
    }
  | {
      readonly type: "prompt.follow_up";
      readonly runId: string;
      readonly text: string;
      readonly images: readonly HeadlessImage[];
    }
  | { readonly type: "execution.abort"; readonly runId?: string }
  | { readonly type: "session.create"; readonly parentSession?: string }
  | { readonly type: "session.switch"; readonly sessionId: string }
  | {
      readonly type: "session.fork";
      readonly sessionId: string;
      readonly entryId: string;
    }
  | { readonly type: "session.clone"; readonly sessionId: string }
  | {
      readonly type: "session.rename";
      readonly sessionId: string;
      readonly name: string;
    }
  | { readonly type: "session.list" }
  | { readonly type: "session.tree"; readonly sessionId: string }
  | {
      readonly type: "session.export";
      readonly sessionId: string;
      readonly path?: string;
    }
  | { readonly type: "model.list" }
  | {
      readonly type: "model.select";
      readonly runId: string;
      readonly model: HeadlessModelRef;
    }
  | { readonly type: "thinking.levels"; readonly runId: string }
  | {
      readonly type: "thinking.select";
      readonly runId: string;
      readonly level: HeadlessThinkingLevel;
    }
  | { readonly type: "auth.providers" }
  | {
      readonly type: "auth.login.start";
      readonly providerId: string;
      readonly method: HeadlessAuthMethod;
    }
  | {
      readonly type: "auth.login.respond";
      readonly flowId: string;
      readonly response: HeadlessAuthResponse;
    }
  | { readonly type: "auth.login.cancel"; readonly flowId: string }
  | { readonly type: "auth.logout"; readonly providerId: string }
  | {
      readonly type: "compaction.start";
      readonly runId: string;
      readonly instructions?: string;
    }
  | { readonly type: "compaction.abort"; readonly runId: string }
  | {
      readonly type: "retry.configure";
      readonly runId: string;
      readonly enabled: boolean;
    }
  | { readonly type: "retry.abort"; readonly runId: string }
  | { readonly type: "command.list" }
  | {
      readonly type: "command.invoke";
      readonly runId: string;
      readonly name: string;
      readonly arguments: string;
    }
  | { readonly type: "resource.reload" }
  | {
      readonly type: "extension_ui.respond";
      readonly dialogId: string;
      readonly response: HeadlessExtensionUiResponse;
    }
  | { readonly type: "shutdown" };

export interface HeadlessRequestFrame {
  readonly kind: "request";
  readonly id: string;
  readonly command: HeadlessCommand;
}

export interface HeadlessProtocolError {
  readonly code:
    | "invalid_frame"
    | "unsupported_command"
    | "invalid_state"
    | "backend_failure"
    | "cancelled";
  readonly message: string;
  readonly retryable: boolean;
}

export type HeadlessResponseFrame =
  | {
      readonly kind: "response";
      readonly id: string;
      readonly result: { readonly ok: true; readonly reply: unknown };
    }
  | {
      readonly kind: "response";
      readonly id: string;
      readonly result: { readonly ok: false; readonly error: HeadlessProtocolError };
    };

export interface HeadlessEventFrame {
  readonly kind: "event";
  readonly event: unknown;
}

export type HeadlessOutboundFrame = HeadlessResponseFrame | HeadlessEventFrame;

const AuthResponseType = Type.Union([
  Type.Object(
    { kind: Type.Literal("text"), value: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("secret"), value: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("selected"), value: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("manual_code"), value: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("cancelled") }, { additionalProperties: false }),
]);

const ExtensionUiResponseType = Type.Union([
  Type.Object(
    { kind: Type.Literal("selected"), value: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("confirmed"), value: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("text"), value: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("cancelled") }, { additionalProperties: false }),
]);

function command<T extends string, P extends TProperties>(type: T, properties: P) {
  return Type.Object({ type: Type.Literal(type), ...properties }, { additionalProperties: false });
}

export const HeadlessCommandSchema = defineSchema<HeadlessCommand>(
  "headless.command",
  Type.Union([
    command("initialize", {
      client: Type.Object(
        { name: NonEmptyStringType, build: NonEmptyStringType },
        { additionalProperties: false },
      ),
    }),
    command("snapshot.request", {}),
    command("prompt.submit", {
      runId: IdType,
      text: Type.String(),
      images: Type.Array(ImageType),
      streamingBehavior: Type.Optional(StreamingBehaviorType),
    }),
    command("prompt.steer", {
      runId: IdType,
      text: Type.String(),
      images: Type.Array(ImageType),
    }),
    command("prompt.follow_up", {
      runId: IdType,
      text: Type.String(),
      images: Type.Array(ImageType),
    }),
    command("execution.abort", { runId: Type.Optional(IdType) }),
    command("session.create", { parentSession: Type.Optional(IdType) }),
    command("session.switch", { sessionId: IdType }),
    command("session.fork", {
      sessionId: IdType,
      entryId: IdType,
    }),
    command("session.clone", { sessionId: IdType }),
    command("session.rename", {
      sessionId: IdType,
      name: NonEmptyStringType,
    }),
    command("session.list", {}),
    command("session.tree", { sessionId: IdType }),
    command("session.export", {
      sessionId: IdType,
      path: Type.Optional(NonEmptyStringType),
    }),
    command("model.list", {}),
    command("model.select", {
      runId: IdType,
      model: ModelRefType,
    }),
    command("thinking.levels", { runId: IdType }),
    command("thinking.select", {
      runId: IdType,
      level: ThinkingLevelType,
    }),
    command("auth.providers", {}),
    command("auth.login.start", {
      providerId: NonEmptyStringType,
      method: AuthMethodType,
    }),
    command("auth.login.respond", {
      flowId: IdType,
      response: AuthResponseType,
    }),
    command("auth.login.cancel", { flowId: IdType }),
    command("auth.logout", { providerId: NonEmptyStringType }),
    command("compaction.start", {
      runId: IdType,
      instructions: Type.Optional(Type.String()),
    }),
    command("compaction.abort", { runId: IdType }),
    command("retry.configure", {
      runId: IdType,
      enabled: Type.Boolean(),
    }),
    command("retry.abort", { runId: IdType }),
    command("command.list", {}),
    command("command.invoke", {
      runId: IdType,
      name: NonEmptyStringType,
      arguments: Type.String(),
    }),
    command("resource.reload", {}),
    command("extension_ui.respond", {
      dialogId: IdType,
      response: ExtensionUiResponseType,
    }),
    command("shutdown", {}),
  ]),
);

export const HeadlessRequestFrameSchema = defineSchema<HeadlessRequestFrame>(
  "headless.request-frame",
  Type.Object(
    {
      kind: Type.Literal("request"),
      id: IdType,
      command: HeadlessCommandSchema.jsonSchema,
    },
    { additionalProperties: false },
  ),
);

export function parseHeadlessRequest(value: unknown): HeadlessRequestFrame {
  const result = HeadlessRequestFrameSchema.validate(value);
  if (result.ok) return result.value;
  const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  throw new Error(`Invalid headless request frame: ${detail}`);
}
