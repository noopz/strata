/**
 * SessionStart / SubagentStart hook — primes the agent with outline awareness.
 * Fires on startup, resume, /clear, and after compaction.
 *
 * Replaces session-start.sh with pure Node.js for Windows compatibility.
 */

import { readStdin, strataLog, getCacheDir, getProjectRoot } from "./lib/common.js";

const input = await readStdin();
const source = input.source || "unknown";
const hookEventName = input.hook_event_name || "SessionStart";

const projectRoot = getProjectRoot(process.cwd());
const cacheDir = getCacheDir(process.cwd());
strataLog(cacheDir, { hook: "session-start", decision: "context_injected", source });

const contextText = `Strata structural outlines are active for large files (300+ lines).

How it works: Reading a large file without offset/limit returns a structural outline -- a compressed map of the file structure. Reading with any offset/limit always returns actual code, bypassing the outline.

Exploring or navigating: Read without offset/limit to get the outline. This shows structure, line ranges, and cross-file connections without consuming the full file. Example outline:

  views.py [1274 lines]
    connections: -> models.py, <- schemas.py
    ---
    [1-15] 1:from django.views import View
    [16-89] 16:class ListingListView(View):
    [90-156] 90:class ListingDetailView(View):

Preparing to edit: The Read tool returns at most 2000 lines per call. Use the outline's line ranges to read the section you need — for example, [90-156] means offset=90, limit=67 will get that class. For files over 2000 lines, paginate: read offset=1 limit=2000, then offset=2001 limit=2000, etc. You choose how much context to read based on what you're changing.`;

const output = {
  hookSpecificOutput: {
    hookEventName,
    additionalContext: contextText,
  },
};

process.stdout.write(JSON.stringify(output) + "\n");
