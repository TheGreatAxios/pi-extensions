/**
 * Minimal shell argument parser.
 * Handles single quotes, double quotes, escaped characters, and basic
 * chaining operators (&&, ;, |, ||). Does NOT evaluate subshells or
 * variable expansions — it parses the literal text.
 */

export interface ShellArg {
	value: string;
	quoted: boolean;
}

export function parseShellArgs(input: string): ShellArg[] {
	const args: ShellArg[] = [];
	let i = 0;

	while (i < input.length) {
		const ch = input[i];

		if (/\s/.test(ch)) {
			i++;
			continue;
		}

		if (ch === "#") break; // comment

		if (ch === "'") {
			let val = "";
			i++;
			while (i < input.length && input[i] !== "'") {
				if (input[i] === "\\") { i++; if (i < input.length) val += input[i]; }
				else val += input[i];
				i++;
			}
			i++; // closing quote
			args.push({ value: val, quoted: true });
			continue;
		}

		if (ch === '"') {
			let val = "";
			i++;
			while (i < input.length && input[i] !== '"') {
				if (input[i] === "\\") { i++; if (i < input.length) val += input[i]; }
				else val += input[i];
				i++;
			}
			i++; // closing quote
			args.push({ value: val, quoted: true });
			continue;
		}

		if (ch === "\\") {
			i++;
			if (i < input.length) args.push({ value: input[i], quoted: false });
			i++;
			continue;
		}

		// bare word
		let val = "";
		while (i < input.length) {
			const c = input[i];
			if (/\s/.test(c) || c === "#" || c === "'" || c === '"') break;
			if (c === "\\") { i++; if (i < input.length) val += input[i]; i++; continue; }
			val += c;
			i++;
		}
		if (val) args.push({ value: val, quoted: false });
	}

	return args;
}

export function splitCommands(input: string): string[] {
	// Split on &&, ;, ||, | but not inside quotes
	const commands: string[] = [];
	let current = "";
	let depth = 0;
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (inSingle) {
			current += ch;
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			current += ch;
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") { inSingle = true; current += ch; continue; }
		if (ch === '"') { inDouble = true; current += ch; continue; }

		if (ch === "(" || ch === "{") { depth++; current += ch; continue; }
		if (ch === ")" || ch === "}") { depth--; current += ch; continue; }

		if (depth === 0) {
			if (/&&/.test(input.slice(i, i + 2))) {
				commands.push(current.trim());
				current = "";
				i++;
				continue;
			}
			if (input[i] === ";") {
				commands.push(current.trim());
				current = "";
				continue;
			}
			if (/\|\|/.test(input.slice(i, i + 2))) {
				commands.push(current.trim());
				current = "";
				i++;
				continue;
			}
			if (ch === "|" && !/\|/.test(input.slice(i + 1, i + 2))) {
				commands.push(current.trim());
				current = "";
				continue;
			}
		}

		current += ch;
	}

	const trimmed = current.trim();
	if (trimmed) commands.push(trimmed);

	return commands.filter(Boolean);
}
