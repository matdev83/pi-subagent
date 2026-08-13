import { open, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactRef } from "./artifacts/result.ts";

/** Maximum final-answer bytes embedded in one subagent tool result. */
export const OUTPUT_PREVIEW_MAX_BYTES = 8 * 1024;
/** Maximum final-answer bytes embedded in one parallel tool result. */
export const OUTPUT_PREVIEW_TOTAL_MAX_BYTES = 32 * 1024;

const OUTPUT_TRUNCATION_MARKER = "\n… [output truncated] …\n";

export interface OutputPreview {
	output: string;
	outputTruncated: boolean;
}

interface OutputArtifact {
	type: string;
	path: string;
	artifactCwd?: string;
}

function isInsideOrEqual(parent: string, child: string): boolean {
	const childRelative = relative(parent, child);
	return (
		childRelative === "" ||
		(!childRelative.startsWith("..") && !isAbsolute(childRelative))
	);
}

function safeArtifactPath(cwd: string, artifact: OutputArtifact): string {
	if (isAbsolute(artifact.path) || artifact.path.split("/").includes(".."))
		throw new Error("output artifact path must be a safe relative path.");
	const artifactCwd = resolve(artifact.artifactCwd ?? cwd);
	const path = resolve(artifactCwd, artifact.path.split("/").join(sep));
	if (!isInsideOrEqual(artifactCwd, path))
		throw new Error("output artifact path must stay inside its artifact cwd.");
	return path;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function trimPrefixToBytes(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8Bytes(value) <= maxBytes) return value;
	let end = Math.min(value.length, maxBytes);
	while (end > 0 && utf8Bytes(value.slice(0, end)) > maxBytes) end -= 1;
	if (end > 0 && end < value.length) {
		const code = value.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	return value.slice(0, end);
}

function trimSuffixToBytes(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8Bytes(value) <= maxBytes) return value;
	let start = Math.max(0, value.length - maxBytes);
	while (start < value.length && utf8Bytes(value.slice(start)) > maxBytes)
		start += 1;
	if (start > 0 && start < value.length) {
		const code = value.charCodeAt(start);
		if (code >= 0xdc00 && code <= 0xdfff) start += 1;
	}
	return value.slice(start);
}

function decodeChunk(buffer: Buffer): string {
	// Read a few bytes beyond each requested boundary and drop edge replacement
	// characters caused only by cutting through a UTF-8 sequence.
	return buffer.toString("utf8").replace(/^\uFFFD|\uFFFD$/g, "");
}

async function readRange(
	path: string,
	position: number,
	length: number,
): Promise<string> {
	if (length <= 0) return "";
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, position);
		return decodeChunk(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function readBoundedText(path: string, maxBytes: number): Promise<OutputPreview> {
	const info = await stat(path);
	if (info.size <= maxBytes) {
		const output = await readRange(path, 0, info.size + 4);
		return { output, outputTruncated: false };
	}

	const markerBytes = utf8Bytes(OUTPUT_TRUNCATION_MARKER);
	const contentBytes = Math.max(0, maxBytes - markerBytes);
	const headBytes = Math.floor(contentBytes / 2);
	const tailBytes = contentBytes - headBytes;
	const head = trimPrefixToBytes(
		await readRange(path, 0, headBytes + 4),
		headBytes,
	);
	const tailPosition = Math.max(0, info.size - tailBytes - 4);
	const tail = trimSuffixToBytes(
		await readRange(path, tailPosition, tailBytes + 4),
		tailBytes,
	);
	return {
		output: `${head}${OUTPUT_TRUNCATION_MARKER}${tail}`,
		outputTruncated: true,
	};
}

/** Read only the final assistant-output artifact, never stderr or event payloads. */
export async function readOutputPreview(
	cwd: string,
	artifacts: readonly OutputArtifact[],
	maxBytes = OUTPUT_PREVIEW_MAX_BYTES,
): Promise<OutputPreview | undefined> {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) return undefined;
	const outputArtifact = artifacts.find((artifact) => artifact.type === "output");
	if (outputArtifact === undefined) return undefined;
	try {
		const preview = await readBoundedText(
			safeArtifactPath(cwd, outputArtifact),
			Math.floor(maxBytes),
		);
		return preview.output.length > 0 ? preview : undefined;
	} catch {
		return undefined;
	}
}
