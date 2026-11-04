export interface SandboxEnabledConfig {
	enabled?: boolean;
	size?: string;
	persist?: boolean;
	cacheVolume?: string;
}

export function resolveAutoStart(opts: {
	noContainer: boolean;
	noc: boolean;
	containerFlag: boolean;
	configEnabled?: boolean;
}): boolean {
	if (opts.noContainer || opts.noc) return false;
	if (opts.containerFlag) return true;
	return opts.configEnabled === true;
}

export function mergeSandboxEnabled(
	existing: Record<string, unknown> | null,
	enabled: boolean,
): { sandbox: Record<string, unknown> } {
	const sandbox = { ...(existing ?? {}), enabled };
	return { sandbox };
}

export function createInFlight() {
	let n = 0;
	return {
		begin() {
			n++;
		},
		end() {
			n = Math.max(0, n - 1);
		},
		get count() {
			return n;
		},
		get busy() {
			return n > 0;
		},
	};
}
