const INJECTION_PATTERNS: RegExp[] = [
	// Direct instruction overrides
	/ignore\s+(all\s+)?previous\s+(instructions|prompts|context)/i,
	/forget\s+(everything|all|your\s+(instructions|training))/i,
	/disregard\s+(your|all|previous)\s+(instructions|rules|guidelines)/i,
	/you\s+are\s+now\s+(?:a\s+)?(?:different|new|unrestricted)/i,
	/new\s+instructions?:\s*/i,

	// System/assistant tag injection
	/system\s*:\s*/i,
	/assistant\s*:\s*/i,
	/\[SYSTEM\]/i,
	/<\/?system>/i,
	/<\/?instruction>/i,
	/```\s*system/i,
	/---\s*SYSTEM/i,

	// Role manipulation
	/pretend\s+(you\s+are|to\s+be)\s+/i,
	/act\s+as\s+(if\s+you\s+(are|were)|a)\s+/i,
	/roleplay\s+as\s+/i,

	// Output manipulation
	/do\s+not\s+(show|display|include|reveal)/i,
	/hide\s+(this|the\s+(following|output|result))/i,

	// Obfuscation patterns in output
	/\beval\s*\(/i,
	/\batob\s*\(/i,
	/String\.fromCharCode/i,
];

export interface InjectionMatch {
	pattern: string;
	offset: number;
}

export function detectPromptInjection(text: string): InjectionMatch[] {
	const matches: InjectionMatch[] = [];

	for (const pattern of INJECTION_PATTERNS) {
		const match = text.match(pattern);
		if (match && match.index !== undefined) {
			matches.push({
				pattern: pattern.source,
				offset: match.index,
			});
		}
	}

	return matches;
}
