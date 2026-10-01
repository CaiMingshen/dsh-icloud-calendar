/**
 * The model-facing tools.
 *
 * Registration only: each tool declares the schema the model sees and delegates
 * to `ctx.icloudCalendar`. Argument types, defaults and bounds live in the
 * service, because a schema cannot express "a window no longer than the profile
 * allows" or "a confirm count that must equal what actually matched".
 *
 * Every tool forwards `exec.signal`, so a cancelled call aborts the in-flight
 * CalDAV request instead of leaving it to finish.
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "icloud-calendar-tools";
/** Both the tool registry and the calendar service this row needs. */
export declare const inject: string[];
export declare function apply(ctx: Context): void;
