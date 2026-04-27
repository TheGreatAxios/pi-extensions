// Top 100 npm packages (frozen snapshot for typosquat detection)
const TOP_NPM_PACKAGES = new Set([
	"lodash", "react", "vue", "angular", "jquery", "axios", "express",
	"moment", "underscore", "typescript", "webpack", "babel-core", "eslint",
	"prettier", "jest", "mocha", "chai", "dotenv", "debug", "colors",
	"chalk", "commander", "yargs", "minimist", "bluebird", "rxjs", "core-js",
	"prop-types", "immutable", "redux", "react-dom", "react-router",
	"next.js", "svelte", "solid-js", "tailwindcss", "postcss", "sass",
	"less", "stylus", "coffee-script", "tslib", "@types/node", "@types/react",
	"@types/express", "body-parser", "cors", "helmet", "morgan", "multer",
	"socket.io", "ws", "uuid", "validator", "joi", "yup", "zod",
	"class-validator", "typeorm", "sequelize", "mongoose", "knex", "bookshelf",
	"pg", "mysql2", "sqlite3", "redis", "ioredis", "mongodb", "mongoose",
	"elasticsearch", "bull", "bee-queue", "nodemailer", "sharp", "jimp",
	"canvas", "pdfkit", "puppeteer", "playwright", "cheerio", "jsdom",
	"request", "node-fetch", "got", "axios-retry", "superagent", "form-data",
]);

const TOP_PYPI_PACKAGES = new Set([
	"requests", "numpy", "pandas", "scipy", "django", "flask", "fastapi",
	"pillow", "opencv-python", "tensorflow", "torch", "keras", "scikit-learn",
	"matplotlib", "plotly", "bokeh", "sqlalchemy", "psycopg2-binary",
	"pymysql", "redis", "celery", "gunicorn", "uvicorn", "pytest",
	"black", "flake8", "mypy", "pylint", "click", "rich", "typer",
	"pydantic", "httpx", "aiohttp", "tornado", "boto3", "cryptography",
	"passlib", "python-jose", "pyjwt", "oauthlib", "authlib", "werkzeug",
	"jinja2", "markupsafe", "itsdangerous", "babel", "python-dateutil",
	"six", "certifi", "charset-normalizer", "idna", "urllib3",
]);

function levenshtein(a: string, b: string): number {
	const matrix: number[][] = [];
	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= a.length; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j - 1] + 1,
					matrix[i][j - 1] + 1,
					matrix[i - 1][j] + 1,
				);
			}
		}
	}

	return matrix[b.length][a.length];
}

export function checkTyposquatting(name: string, ecosystem: "npm" | "pypi"): string | null {
	const popularPackages = ecosystem === "npm" ? TOP_NPM_PACKAGES : TOP_PYPI_PACKAGES;

	if (popularPackages.has(name)) return null;

	let closestMatch: string | null = null;
	let minDistance = Infinity;

	for (const popular of popularPackages) {
		const dist = levenshtein(name.toLowerCase(), popular.toLowerCase());
		if (dist <= 2 && dist < minDistance) {
			minDistance = dist;
			closestMatch = popular;
		}
	}

	if (closestMatch && minDistance <= 2) {
		return `Possible typosquat: "${name}" is ${minDistance} char(s) from "${closestMatch}"`;
	}

	return null;
}
