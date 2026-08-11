// Windows-friendly recursive delete with retry. Detached durable workers and
// other child processes can briefly hold a directory (as cwd or open handle),
// which makes rmdir fail with EBUSY/EPERM on Windows. Retrying with a short
// delay gives those processes time to exit and release the lock.
import { rm } from "node:fs/promises";

export async function rmTree(
	target,
	{ retries = 30, delayMs = 250 } = {},
) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			await rm(target, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = error?.code;
			if (attempt > retries || (code !== "EBUSY" && code !== "EPERM")) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}
