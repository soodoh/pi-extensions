# auto-session-name

`auto-session-name` is a small Pi extension that names skill-started sessions from the user's actual request.

## Highlights

- Detects sessions whose first user message starts with a Pi `<skill name="...">...</skill>` block.
- Removes the leading skill wrapper and uses the remaining request as the human-readable session title.
- Formats titles as `<skill-name>: <request>` and truncates them to 72 characters.
- Names eligible sessions after the first turn when Pi has not already assigned a name.
- Backfills existing unnamed skill sessions by appending a `session_info` entry to session JSONL files.

## Install

These packages are not published to npm. Use Pi's Git package source.

To install the whole repo package:

```bash
pi install git:github.com/soodoh/pi-extensions
```

To load only `auto-session-name`, add a filtered package entry to `~/.pi/agent/settings.json` for a global install, or `.pi/settings.json` for a project-local install:

```json
{
  "packages": [
    {
      "source": "git:github.com/soodoh/pi-extensions",
      "extensions": ["packages/auto-session-name/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

If you prefer SSH, use this source instead:

```text
git:git@github.com:soodoh/pi-extensions
```

Restart Pi or run `/reload` after installing.

## Usage

The extension runs automatically. Start a session through a skill invocation, and when the first turn finishes Pi will receive a session name based on the request.

For example, a first user message shaped like this:

```xml
<skill name="planner">...</skill>
Add README.md for each package
```

will be named similar to:

```text
planner: Add README.md for each package
```

## Configuration

There is no user configuration.

## Storage and backfill

On session startup, the extension performs a one-time scan of existing session files under:

```text
~/.pi/agent/sessions/**/*.jsonl
```

For unnamed sessions that started with a skill invocation, it appends a `session_info` entry with the generated title. Malformed or concurrently modified session files are skipped so naming never blocks normal Pi usage.

## Notes

- Existing session names are preserved.
- Sessions that do not start with a skill block are ignored.
- Empty requests fall back to `<skill-name> skill session`.

## Development

From the repository root:

```bash
bun run --filter auto-session-name typecheck
bun run --filter auto-session-name test
```
