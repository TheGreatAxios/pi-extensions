import type { ParsedCommand } from "../parsers/types";

export interface EncodingResult {
	blocked: boolean;
	reason?: string;
}

const BASE64_LONG_PATTERN = /[A-Za-z0-9+/]{40,}={0,2}/;
const HEX_ESCAPE_PATTERN = /\\x[0-9a-fA-F]{2}/g;
const UNICODE_HOMOGLYPH_PATTERN = /[аАєЄеЕрРсСоОуУчЧхХҩ™]/;

export function detectEncoding(command: string): EncodingResult {
	// Base64 strings >40 chars in arguments (likely encoded payload)
	const base64Matches = command.match(BASE64_LONG_PATTERN);
	if (base64Matches && base64Matches.some((m) => m.length >= 40)) {
		return { blocked: true, reason: "Blocked: base64-encoded content detected in command (possible obfuscation)" };
	}

	// Hex escape sequences (more than 1 suggests encoding)
	const hexEscapes = command.match(HEX_ESCAPE_PATTERN);
	if (hexEscapes && hexEscapes.length > 2) {
		return { blocked: true, reason: "Blocked: multiple hex escape sequences detected (possible obfuscation)" };
	}

	// Unicode homoglyph attacks (Cyrillic chars that look like Latin)
	if (UNICODE_HOMOGLYPH_PATTERN.test(command)) {
		return { blocked: true, reason: "Blocked: suspicious unicode characters detected (possible homoglyph attack)" };
	}

	// eval / atob in commands
	if (/\beval\s*\(/.test(command) || /\batob\s*\(/.test(command)) {
		return { blocked: true, reason: "Blocked: code evaluation function detected in command" };
	}

	return { blocked: false };
}
