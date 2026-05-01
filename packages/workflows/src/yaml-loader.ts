import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export async function loadYamlFile(path: string): Promise<unknown> {
	const raw = await readFile(path, "utf8");
	return parse(raw);
}
