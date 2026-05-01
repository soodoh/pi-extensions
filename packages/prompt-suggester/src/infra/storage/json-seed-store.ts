import { promises as fs } from "node:fs";
import type { SeedStore } from "../../app/ports/seed-store";
import { isSeedArtifact, type SeedArtifact } from "../../domain/seed";
import { atomicWriteJson } from "./atomic-write";

export class JsonSeedStore implements SeedStore {
	public constructor(private readonly filePath: string) {}

	public async load(): Promise<SeedArtifact | null> {
		let raw: string;
		try {
			raw = await fs.readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error(
				`Failed to read seed file ${this.filePath}: ${(error as Error).message}`,
			);
		}

		try {
			const parsed: unknown = JSON.parse(raw);
			return isSeedArtifact(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	public async save(seed: SeedArtifact): Promise<void> {
		await atomicWriteJson(this.filePath, seed);
	}
}
