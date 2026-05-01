import { readFile, stat } from "node:fs/promises";
import { parse } from "yaml";

export async function loadYamlFile(
	path: string,
	options: { maxBytes?: number } = {},
): Promise<unknown> {
	if (options.maxBytes !== undefined) {
		const metadata = await stat(path);
		if (!metadata.isFile()) throw new Error("YAML path is not a file");
		if (metadata.size > options.maxBytes) {
			throw new Error(
				`YAML file is too large (${metadata.size} bytes; max ${options.maxBytes} bytes)`,
			);
		}
	}
	const raw = await readFile(path, "utf8");
	return parse(raw);
}
