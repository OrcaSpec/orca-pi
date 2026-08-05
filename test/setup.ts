import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point pi's agent directory — and therefore `defaultStateRoot()` — at a throwaway
 * temp directory for the whole suite.
 *
 * The extension resolves its state root from `getAgentDir()` when no override is
 * supplied, which in a developer's shell is their real `~/.pi/agent`. Most of the
 * offline suite installs the extension without an override, and since Phase 6 the
 * runtime DELETES files under that root, so without this a `npm test` run could expire
 * a developer's own preserved patches. Set unconditionally rather than defaulted: a
 * developer who has `PI_CODING_AGENT_DIR` exported is exactly the person this protects.
 */
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "orca-agent-dir-"));
