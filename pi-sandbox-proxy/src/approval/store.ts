import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ApprovalRecord {
	subject: string;
	specifier: string;
	approvedAt: number;
	expiresAt: number;
	approvedBy: string;
	reason: string;
}

const STORE_FILE = "proxy-approvals.json";

export class ApprovalStore {
	private path: string;
	private records: Map<string, ApprovalRecord>;

	constructor(agentDir: string) {
		this.path = join(agentDir, STORE_FILE);
		this.records = new Map();
		this.load();
	}

	private load(): void {
		const dir = this.path.slice(0, this.path.lastIndexOf("/"));
		mkdirSync(dir, { recursive: true });

		if (!existsSync(this.path)) return;

		try {
			const raw = JSON.parse(readFileSync(this.path, "utf-8")) as ApprovalRecord[];
			const now = Date.now();
			for (const record of raw) {
				if (record.expiresAt > now) {
					this.records.set(record.subject + ":" + record.specifier, record);
				}
			}
		} catch {
			// corrupt file — start fresh
		}
	}

	private save(): void {
		const tmpPath = this.path + ".tmp";
		const data = Array.from(this.records.values());
		writeFileSync(tmpPath, JSON.stringify(data, null, 2));
		renameSync(tmpPath, this.path);
	}

	find(subject: string, specifier?: string): ApprovalRecord | undefined {
		const key = specifier ? `${subject}:${specifier}` : subject;
		const exact = this.records.get(key);
		if (exact && exact.expiresAt > Date.now()) return exact;

		for (const [, record] of this.records) {
			if (record.subject === subject && record.expiresAt > Date.now()) return record;
		}
		return undefined;
	}

	add(subject: string, specifier: string, days: number, reason: string): void {
		const maxDays = 30; // hard cap
		const actualDays = Math.min(days, maxDays);
		const now = Date.now();

		const record: ApprovalRecord = {
			subject,
			specifier,
			approvedAt: now,
			expiresAt: now + actualDays * 24 * 60 * 60 * 1000,
			approvedBy: "user",
			reason,
		};

		this.records.set(`${subject}:${specifier}`, record);
		this.save();
	}

	revoke(subject: string): boolean {
		let found = false;
		for (const [key, record] of this.records) {
			if (record.subject === subject) {
				this.records.delete(key);
				found = true;
			}
		}
		if (found) this.save();
		return found;
	}

	list(): ApprovalRecord[] {
		return Array.from(this.records.values()).filter((r) => r.expiresAt > Date.now());
	}
}

// renameSync is imported from node:fs above
