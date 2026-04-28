import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type ApprovalScope = "exact" | "domain";

export interface ApprovalRecord {
	subject: string;
	specifier: string;
	scope: ApprovalScope;
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
					// Backfill scope for records from before the field existed
					if (!record.scope) record.scope = "exact";
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

		// Domain wildcard lookup: if subject is a URL, check for a domain-scoped approval
		const domain = this.extractDomain(subject);
		if (domain) {
			const domainKey = `${domain}:*`;
			const wildcard = this.records.get(domainKey);
			if (wildcard && wildcard.scope === "domain" && wildcard.expiresAt > Date.now()) {
				return wildcard;
			}
		}

		return undefined;
	}

	/** Extract the domain (host) from a URL string, or return undefined */
	private extractDomain(subject: string): string | undefined {
		try {
			const url = new URL(subject.startsWith("http") ? subject : `https://${subject}`);
			return url.hostname;
		} catch {
			return undefined;
		}
	}

	add(subject: string, specifier: string, days: number, reason: string, scope: ApprovalScope = "exact"): void {
		const maxDays = 30; // hard cap
		const actualDays = Math.min(days, maxDays);
		const now = Date.now();

		const record: ApprovalRecord = {
			subject,
			specifier,
			scope,
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

	/** Get just the domains that have wildcard approvals (for proxy whitelist) */
	listWildcardDomains(): string[] {
		const now = Date.now();
		return Array.from(this.records.values())
			.filter((r) => r.scope === "domain" && r.expiresAt > now)
			.map((r) => r.subject);
	}

	list(): ApprovalRecord[] {
		return Array.from(this.records.values()).filter((r) => r.expiresAt > Date.now());
	}
}

// renameSync is imported from node:fs above
