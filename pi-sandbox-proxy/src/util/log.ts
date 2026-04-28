import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface AuditEntry {
	ts: string;
	action: string;
	subject: string;
	reason?: string;
	mutatedTo?: string;
	source?: string;
	scope?: string;
	matches?: string[];
}

export class AuditLog {
	private path: string;

	constructor(agentDir: string) {
		this.path = join(agentDir, "proxy-audit.log");
		this.ensureFile();
	}

	private ensureFile(): void {
		const dir = this.path.slice(0, this.path.lastIndexOf("/"));
		mkdirSync(dir, { recursive: true });
	}

	log(entry: Omit<AuditEntry, "ts">): void {
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
		appendFileSync(this.path, line);
	}

	recent(count: number): AuditEntry[] {
		if (!existsSync(this.path)) return [];
		try {
			const raw = readFileSync(this.path, "utf-8").trimEnd();
			const lines = raw.split("\n");
			return lines
				.slice(-count)
				.map((l) => JSON.parse(l) as AuditEntry)
				.reverse();
		} catch {
			return [];
		}
	}
}
