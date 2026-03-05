# agenticros-skill-followme

Follow Me skill for [AgenticROS](https://github.com/your-org/agenticros): the robot follows the user using depth (and optionally Ollama/VLM) and publishes `cmd_vel`.

## What it does

- **Behavior**: A control loop runs at a configured rate (e.g. 5 Hz). It samples distance from a depth topic (e.g. RealSense) and optionally uses Ollama (e.g. Qwen VL) for person detection and left/right steering. It publishes twist commands to `cmd_vel` to keep the user at a target distance and centered.
- **Tools**:  
  - **`follow_robot`** — Start, stop, or query Follow Me (actions: `start`, `stop`, `status`).  
  - **`follow_me_see`** — When Ollama is enabled, returns what the vision model sees (person position/distance hint).  
  - **`ollama_status`** — Checks if Ollama is reachable and lists models (for debugging/setup).
- **Config**: All options live under **`config.skills.followme`** (see [Contract](#contract-summary) and [Install](#install-and-run)).

## Install and run

1. **Install the skill** where the OpenClaw gateway can load it:
   - **Option A (recommended)**: Add to AgenticROS config as a package name:
     - In OpenClaw config, under `plugins.entries.agenticros.config`, set:
       - `skillPackages`: `["agenticros-skill-followme"]`
     - Install the package in the same environment as the gateway (e.g. `pnpm add agenticros-skill-followme` in the gateway app, or install globally).
   - **Option B**: Clone this repo into a directory and add that directory to `skillPaths`:
     - `skillPaths`: `["/path/to/agenticros-skill-followme"]`
     - Run `pnpm install` and `pnpm build` in this repo.
2. **Configure** the skill in the same config under `skills.followme` (see [Contract](#contract-summary)).
3. **Restart the OpenClaw gateway** so the plugin loads the skill.
4. In chat, use natural language: e.g. “follow me”, “start following”, “stop following”. The agent will call `follow_robot` with the appropriate action.

## Project structure

| Path | Purpose |
|------|--------|
| `src/index.ts` | Entry point; exports `registerSkill(api, config, context)`. |
| `src/config.ts` | Follow Me config slice: reads `config.skills.followme` and applies defaults. |
| `src/loop.ts` | Control loop: depth + optional Ollama, publishes `cmd_vel`; start/stop/status. |
| `src/tools/follow-robot.ts` | Registers `follow_robot` (start/stop/status). |
| `src/tools/follow-me-detection.ts` | Registers `follow_me_see` (what the tracker sees when useOllama is on). |
| `src/tools/ollama-status.ts` | Registers `ollama_status`. |

The skill gets **transport** and **depth** from the plugin via **context**:

- `context.getTransport()` — ROS2 transport (subscribe/publish).
- `context.getDepthDistance(transport, topic, timeoutMs?)` — Sample depth topic and return median distance (meters).
- `context.logger` — Plugin logger.

Config is the full AgenticROS config; the skill only uses `config.skills.followme` and, for topic resolution, `config.robot.namespace` / `config.teleop.cmdVelTopic` where needed.

## Using this repo as a template for a new skill

1. **Copy or fork** this repo and rename the package (e.g. `agenticros-skill-myskill`).
2. **`package.json`**:  
   - Set `"agenticrosSkill": true`.  
   - Set `"main"` to your built entry (e.g. `"dist/index.js"`).  
   - Keep `peerDependencies` on `@agenticros/agenticros` and add any deps your skill needs (e.g. no extra deps for Ollama — this skill uses `fetch`).
3. **Entry point**: Export a single function **`registerSkill(api, config, context)`** that:
   - Reads its config from `config.skills.<skillId>` (e.g. `config.skills.followme`).
   - Registers tools with `api.registerTool(...)` (and optionally commands, etc.).
   - Optionally starts a background loop (as here) using `context.getTransport()` and `context.getDepthDistance(...)`.
4. **Config slice**: Validate and default your slice (e.g. with a small helper like `getFollowMeConfig` in `src/config.ts`).
5. **Build**: Run `pnpm build` (or `npm run build`) so the plugin can load your `main` entry.
6. **Install**: Users add your package to `skillPackages` or install into a path in `skillPaths` and set `config.skills.<skillId>` as needed.

Full contract and types: **[AgenticROS docs: Skills](https://github.com/your-org/agenticros/blob/main/docs/skills.md)** (replace with your repo URL).

## Contract summary

- **Package**: `package.json` has `"agenticrosSkill": true` and a `main` entry that exports **`registerSkill(api, config, context)`**.
- **Config**: Skill-specific options live under **`config.skills.<skillId>`** (e.g. `config.skills.followme`). The skill validates and defaults its own slice.
- **Context**: Use **`context.getTransport()`** for ROS2, **`context.getDepthDistance(transport, topic, timeoutMs?)`** for depth (optional), and **`context.logger`** for logging.
- **Registration**: Call **`api.registerTool(...)`** (and optionally commands) inside `registerSkill`. Do not depend on the plugin’s internal file layout; depend only on the public skill API and types exported by `@agenticros/agenticros`.

For the full contract and how to create a third-party skill, see **[docs/skills.md](https://github.com/your-org/agenticros/blob/main/docs/skills.md)** in the AgenticROS repo.
