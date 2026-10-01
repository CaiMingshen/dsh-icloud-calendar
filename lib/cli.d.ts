#!/usr/bin/env node
/**
 * Standalone CLI.
 *
 * Why it exists: credentials and connectivity are the two things that go wrong
 * first, and debugging them through an agent conversation is slow. This entry
 * point reuses the exact same client, credential store and delete guard as the
 * plugin, so `status` and `calendars` prove the profile will work before the
 * model ever calls a tool.
 *
 * It is also the answer to the measured "13 seconds per call" problem: one
 * process serves one command and keeps its connection for the duration, so put
 * several operations in one invocation (or use the plugin, whose service keeps
 * the connection for the whole session) instead of scripting many short runs.
 */
import { DEFAULT_CONFIG } from './config.js';
export { DEFAULT_CONFIG };
