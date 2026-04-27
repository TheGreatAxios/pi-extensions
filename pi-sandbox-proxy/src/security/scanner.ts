interface Vulnerability {
	id: string;
	summary: string;
	severity: string;
	score?: number;
}

interface ScanResult {
	vulnerabilities: Vulnerability[];
	error?: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface ScanCacheEntry {
	package: string;
	version: string;
	vulnerabilities: Vulnerability[];
	scannedAt: number;
	expiresAt: number;
}

export class VulnerabilityScanner {
	private cache: Map<string, ScanCacheEntry> = new Map();
	private cachePath: string | null = null;

	constructor(agentDir?: string) {
		if (agentDir) {
			this.cachePath = `${agentDir}/proxy-scan-cache.json`;
			this.loadCache();
		}
	}

	private loadCache(): void {
		if (!this.cachePath) return;
		try {
			const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
			if (!existsSync(this.cachePath)) return;
			const data = JSON.parse(readFileSync(this.cachePath, "utf-8")) as ScanCacheEntry[];
			const now = Date.now();
			for (const entry of data) {
				if (entry.expiresAt > now) {
					this.cache.set(`${entry.package}@${entry.version}`, entry);
				}
			}
		} catch {}
	}

	private saveCache(): void {
		if (!this.cachePath) return;
		try {
			const { writeFileSync } = require("node:fs") as typeof import("node:fs");
			writeFileSync(this.cachePath, JSON.stringify(Array.from(this.cache.values()), null, 2));
		} catch {}
	}

	async scan(name: string, version: string, ecosystem: string = "npm"): Promise<ScanResult> {
		const cacheKey = `${name}@${version}`;
		const cached = this.cache.get(cacheKey);

		if (cached && cached.expiresAt > Date.now()) {
			return { vulnerabilities: cached.vulnerabilities };
		}

		try {
			const res = await fetch("https://api.osv.dev/v1/query", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					package: { name, ecosystem },
					version,
				}),
			});

			if (!res.ok) {
				return { vulnerabilities: [], error: `OSV API returned ${res.status}` };
			}

			const data = await res.json() as { vulns?: Vulnerability[] };
			const vulns = data.vulns ?? [];

			this.cache.set(cacheKey, {
				package: name,
				version,
				vulnerabilities: vulns,
				scannedAt: Date.now(),
				expiresAt: Date.now() + CACHE_TTL_MS,
			});
			this.saveCache();

			return { vulnerabilities: vulns };
		} catch (err) {
			return { vulnerabilities: [], error: err instanceof Error ? err.message : "scan failed" };
		}
	}

	formatScanResult(result: ScanResult): string {
		if (result.error) return `Scan unavailable (${result.error}) — approve at your own risk`;

		const vulns = result.vulnerabilities;
		if (vulns.length === 0) return "Vulnerability scan: 0 known CVEs";

		const critical = vulns.filter((v) => (v.score ?? 0) >= 9).length;
		const high = vulns.filter((v) => (v.score ?? 0) >= 7 && (v.score ?? 0) < 9).length;
		const moderate = vulns.filter((v) => (v.score ?? 0) >= 4 && (v.score ?? 0) < 7).length;

		const parts = [`Vulnerability scan: ${vulns.length} found`];
		if (critical > 0) parts.push(`  CRITICAL (CVSS≥9): ${critical}`);
		if (high > 0) parts.push(`  HIGH (CVSS≥7): ${high}`);
		if (moderate > 0) parts.push(`  MODERATE: ${moderate}`);

		return parts.join("\n");
	}

	getMaxCvss(result: ScanResult): number {
		return result.vulnerabilities.reduce((max, v) => Math.max(max, v.score ?? 0), 0);
	}
}
