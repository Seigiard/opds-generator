import type { Effect } from "effect";
import type { Result } from "neverthrow";
import type { ConfigService, FileSystemService, LoggerService } from "../services.ts";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";

export type EffectHandler = (
  event: EventType,
) => Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService>;

export type AsyncHandler = (
  event: EventType,
  deps: HandlerDeps,
) => Promise<Result<readonly EventType[], Error>>;

export type UnifiedHandler =
  | { kind: "effect"; handler: EffectHandler }
  | { kind: "async"; handler: AsyncHandler };
