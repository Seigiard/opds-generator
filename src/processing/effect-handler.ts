import { Context, Data, Effect } from "effect";
import type { HandlerDeps } from "../context.ts";
import type { EffectFileSystem } from "../effect-file-system.ts";
import type { EventType } from "./types.ts";

export class CatalogueDeps extends Context.Service<CatalogueDeps, HandlerDeps>()("CatalogueDeps") {}

/** Constructors for catalogue events; the values stay plain `EventType` members. */
export const CatalogueEvent = Data.taggedEnum<EventType>();

/**
 * A handler failure is a tagged error; cancellation is fiber interruption, not a failure.
 * Handlers run uninterruptibly: a handler marks the phases shutdown may cancel with `Effect.interruptible`.
 * Interruption discards a result, so a phase that must finish once started stays outside those marks.
 */
export type HandlerError = Error & { readonly _tag: string };

export type EffectHandler = (event: EventType) => Effect.Effect<readonly EventType[], HandlerError, CatalogueDeps | EffectFileSystem>;

export type EffectHandlers = Readonly<Partial<Record<EventType["_tag"], EffectHandler>>>;
