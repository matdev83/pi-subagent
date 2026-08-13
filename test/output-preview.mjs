import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOutputPreview } from "../src/output-preview.ts";

const root = await mkdtemp(join(tmpdir(), "pi-output-preview-"));
try {
	const outputPath = join(root, "output.log");
	await writeFile(outputPath, "assistant answer\n", "utf8");
	const short = await readOutputPreview(root, [
		{ type: "stderr", path: "stderr.log" },
		{ type: "output", path: "output.log" },
	]);
	assert.deepEqual(short, {
		output: "assistant answer\n",
		outputTruncated: false,
	});

	const long = `${"A".repeat(7000)}\n${"B".repeat(7000)}`;
	await writeFile(outputPath, long, "utf8");
	const truncated = await readOutputPreview(root, [
		{ type: "output", path: "output.log" },
	], 1024);
	assert.equal(truncated?.outputTruncated, true);
	assert.ok(Buffer.byteLength(truncated?.output ?? "", "utf8") <= 1024);
	assert.match(truncated?.output ?? "", /^A+/);
	assert.match(truncated?.output ?? "", /B+$/);

	await writeFile(outputPath, "😀".repeat(5000), "utf8");
	const unicode = await readOutputPreview(root, [
		{ type: "output", path: "output.log" },
	], 1024);
	assert.equal(unicode?.outputTruncated, true);
	assert.ok(Buffer.byteLength(unicode?.output ?? "", "utf8") <= 1024);
	assert.doesNotMatch(unicode?.output ?? "", /�/);

	const unsafe = await readOutputPreview(root, [
		{ type: "output", path: "../outside.log" },
	]);
	assert.equal(unsafe, undefined);
	console.log("output-preview checks passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
