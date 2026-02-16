/**
 * Agent-gate transform — gates events on running agent sessions.
 *
 * Shells out to `agent-ctl list --json` and checks if any sessions matching
 * the configured filter are still running. If sessions ARE running, the event
 * is dropped (returns null). If NO matching sessions are running, the event
 * passes through.
 *
 * Fails open: CLI errors pass the event through rather than blocking.
 */

import { execFile } from 'node:child_process';
import type { OrgLoopEvent, Transform, TransformContext } from '@orgloop/sdk';

export interface AgentGateConfig {
	/** Path to agent-ctl binary (default: "agent-ctl") */
	binary_path?: string;
	/** Only count sessions from this adapter (e.g. "claude-code") */
	adapter_filter?: string;
	/** Only count sessions with these statuses as "running" (default: ["running"]) */
	active_statuses?: string[];
	/** Timeout for CLI call in ms (default: 5000) */
	timeout?: number;
}

interface AgentSession {
	status: string;
	adapter: string;
	[key: string]: unknown;
}

const KNOWN_CONFIG_KEYS = new Set(['binary_path', 'adapter_filter', 'active_statuses', 'timeout']);

const DEFAULT_BINARY = 'agent-ctl';
const DEFAULT_ACTIVE_STATUSES = ['running'];
const DEFAULT_TIMEOUT = 5000;

/**
 * Execute agent-ctl list --json and parse the output.
 * Exported for testability (allows mocking in tests).
 */
export function execAgentCtl(binaryPath: string, timeoutMs: number): Promise<AgentSession[]> {
	return new Promise((resolve, reject) => {
		execFile(binaryPath, ['list', '--json'], { timeout: timeoutMs }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			try {
				const parsed = JSON.parse(stdout);
				const sessions = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
				resolve(sessions as AgentSession[]);
			} catch (parseError) {
				reject(new Error(`Failed to parse agent-ctl output: ${parseError}`));
			}
		});
	});
}

export class AgentGateTransform implements Transform {
	readonly id = 'agent-gate';
	private binaryPath = DEFAULT_BINARY;
	private adapterFilter: string | undefined;
	private activeStatuses: string[] = DEFAULT_ACTIVE_STATUSES;
	private timeoutMs = DEFAULT_TIMEOUT;

	/** Override for testing — allows injecting a mock executor */
	_execFn: typeof execAgentCtl = execAgentCtl;

	async init(config: Record<string, unknown>): Promise<void> {
		const unknownKeys = Object.keys(config).filter((k) => !KNOWN_CONFIG_KEYS.has(k));
		if (unknownKeys.length > 0) {
			throw new Error(
				`Agent-gate transform: unknown config keys: ${unknownKeys.join(', ')}. ` +
					`Valid keys are: ${[...KNOWN_CONFIG_KEYS].join(', ')}`,
			);
		}

		const c = config as unknown as AgentGateConfig;
		this.binaryPath = c.binary_path ?? DEFAULT_BINARY;
		this.adapterFilter = c.adapter_filter;
		this.activeStatuses = c.active_statuses ?? DEFAULT_ACTIVE_STATUSES;
		this.timeoutMs = c.timeout ?? DEFAULT_TIMEOUT;
	}

	async execute(event: OrgLoopEvent, _context: TransformContext): Promise<OrgLoopEvent | null> {
		let sessions: AgentSession[];
		try {
			sessions = await this._execFn(this.binaryPath, this.timeoutMs);
		} catch {
			// Fail open — if we can't check, let the event through
			return event;
		}

		const activeSessions = sessions.filter(
			(s) =>
				this.activeStatuses.includes(s.status) &&
				(!this.adapterFilter || s.adapter === this.adapterFilter),
		);

		// If active sessions exist, gate is closed — drop the event
		if (activeSessions.length > 0) {
			return null;
		}

		// No active sessions — gate is open, pass through
		return event;
	}

	async shutdown(): Promise<void> {
		// No resources to clean up
	}
}
