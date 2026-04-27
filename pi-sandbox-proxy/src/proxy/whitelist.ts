export class DomainWhitelist {
	private domains: Set<string> = new Set();

	constructor(initialDomains: string[] = []) {
		for (const domain of initialDomains) {
			this.add(domain);
		}
	}

	add(domain: string): void {
		this.domains.add(domain.toLowerCase());
	}

	remove(domain: string): void {
		this.domains.delete(domain.toLowerCase());
	}

	isAllowed(hostname: string): boolean {
		const lower = hostname.toLowerCase();

		// Exact match
		if (this.domains.has(lower)) return true;

		// Subdomain match: if api.github.com is allowed, any *.github.com is too
		for (const domain of this.domains) {
			if (lower.endsWith(`.${domain}`)) return true;
		}

		return false;
	}

	list(): string[] {
		return Array.from(this.domains);
	}

	size(): number {
		return this.domains.size;
	}
}

const PRIVATE_IP_PATTERNS = [
	/^127\./,
	/^10\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^169\.254\./,
	/^::1$/,
	/^fc00:/i,
	/^fe80:/i,
];

export function isPrivateIP(ipOrHost: string): boolean {
	for (const pattern of PRIVATE_IP_PATTERNS) {
		if (pattern.test(ipOrHost)) return true;
	}
	return false;
}
