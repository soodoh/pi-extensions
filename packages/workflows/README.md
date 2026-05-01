# workflows

`workflows` provides deterministic YAML-defined workflows for Pi, including Plannotator-backed planning and reviewed execution loops.

## Highlights

- Adds slash commands for listing, starting, resuming, and inspecting workflow runs.
- Ships built-in workflows for plan-then-execute and execute-existing-plan flows.
- Loads additional workflow YAML files from user and project directories.
- Loads reusable workflow command prompts from user and project directories.
- Persists workflow run state so planning and execution can continue across sessions.
- Registers workflow tools that planning/execution agents can call to approve, submit, and complete runs.
- Supports model policies for stage-specific model/thinking selection.

## Install

These packages are not published to npm. Use Pi's Git package source.

To install the whole repo package:

```bash
pi install git:github.com/soodoh/pi-extensions
```

To load only `workflows`, add a filtered package entry to `~/.pi/agent/settings.json` for a global install, or `.pi/settings.json` for a project-local install:

```json
{
  "packages": [
    {
      "source": "git:github.com/soodoh/pi-extensions",
      "extensions": ["packages/workflows/index.ts"],
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

## Commands

| Command                        | Description                                              |
| ------------------------------ | -------------------------------------------------------- |
| `/workflows`                   | List discovered workflows and diagnostics.               |
| `/workflow <name> [arguments]` | Start a workflow by name. With no name, lists workflows. |
| `/workflow-status [runId]`     | Show one run or the 10 most recent runs.                 |
| `/workflow-continue <runId>`   | Continue a run after plan approval.                      |
| `/workflow-resume <runId>`     | Resume a run from its persisted plan artifact.           |

## Built-in workflows

| Workflow             | Use when                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `plan-execute`       | You want Plannotator-approved planning, then deterministic reviewed implementation.                |
| `grill-plan-execute` | You want grill-me clarification, Plannotator approval, then deterministic reviewed implementation. |
| `execute-plan`       | You already have a Markdown plan and want deterministic reviewed implementation.                   |

Examples:

```text
/workflow plan-execute Add README.md for every package
/workflow grill-plan-execute Refactor the auth flow
/workflow execute-plan plans/approved-plan.md
```

## Tools

The extension registers tools for agents running inside workflow sessions:

| Tool                    | Purpose                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `workflow_approve_plan` | Approve a workflow plan artifact without Plannotator browser review.      |
| `workflow_submit_plan`  | Submit a workflow plan artifact through Plannotator's event API.          |
| `workflow_complete_run` | Mark a workflow execution run completed or failed after final validation. |

These tools are meant to be called by workflow prompts, not usually by a human directly.

## Workflow and command discovery

Workflow YAML files are loaded from these directories, with later entries overriding earlier workflows of the same name:

```text
packages/workflows/workflows/defaults
~/.pi/agent/workflows
.pi/workflows
```

Workflow command prompt files are loaded from:

```text
packages/workflows/commands/defaults
~/.pi/agent/workflow-commands
.pi/workflow-commands
```

Commands are Markdown files. Workflows are YAML files with a required `name`, `description`, and non-empty `nodes` array.

## Workflow YAML notes

A workflow node must define exactly one node type. Supported node type fields include:

- `command`
- `prompt`
- `bash`
- `script`
- `approval`
- `plannotator_review`
- `handoff`
- `subagent`
- `workerReviewLoop`
- `worktreeWave`

Nodes may use `depends_on`, `trigger_rule`, `context`, `model`, `thinking`, `modelPolicy`, `output_format`, `output_artifact`, `timeout`, and loop settings. The current conditional expression support is intentionally narrow and used by the built-ins for plan complexity routing:

```yaml
when: "$classify-plan.output.complexity == 'simple'"
```

## State

Workflow runs are stored in:

```text
~/.pi/agent/workflow-runs/<runId>.json
```

Legacy runs may also be read from:

```text
~/.pi/agent/workflow-runs.json
```

Each run records phase, workflow name, cwd, request, plan artifact path/hash, approval notes, session paths, selected complexity, and recent logs.

## Notes

- Plannotator review requires the Plannotator event API to be available.
- `execute-plan` requires an existing `.md` or `.mdx` file inside the workflow cwd.
- Project workflows and commands are useful for team-specific automation; global workflows are useful for personal defaults.
- Model policies can select models automatically from authenticated/available models, or inherit the current session model.

## Development

From the repository root:

```bash
bun run --filter workflows typecheck
bun run --filter workflows test
```
