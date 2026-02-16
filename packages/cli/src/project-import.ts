/**
 * Project-relative package resolution.
 *
 * Resolves packages from the project directory's node_modules,
 * not the CLI's install location. This allows users to `npm install`
 * connectors/transforms/loggers as project dependencies.
 *
 * Falls back to the CLI's own resolution (bare import) so that
 * monorepo workspace links and CLI-bundled packages still work.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Create an import function that resolves packages from the given project directory.
 *
 * Resolution order:
 * 1. Project's node_modules (via createRequire from projectDir)
 * 2. CLI's own node_modules (bare dynamic import — monorepo/workspace fallback)
 */
export function createProjectImport(projectDir: string) {
	const projectRequire = createRequire(join(projectDir, 'package.json'));

	return async (specifier: string): Promise<{ default: unknown; [key: string]: unknown }> => {
		// Try project-relative resolution first
		try {
			const resolved = projectRequire.resolve(specifier);
			return await import(resolved);
		} catch {
			// Fall through to CLI-relative resolution
		}

		// Fallback: bare import (resolves from CLI's own node_modules)
		return await import(specifier);
	};
}
