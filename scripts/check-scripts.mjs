#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function collect(directory) {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await collect(path)));
		else if (entry.isFile() && path.endsWith(".mjs")) files.push(path);
	}
	return files;
}

const files = [
	...(await collect("scripts")),
	...(await collect("test")),
];
for (const file of files) await import(`node:child_process`).then(({ execFileSync }) => {
	execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
});
