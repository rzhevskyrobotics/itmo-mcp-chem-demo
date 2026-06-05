# Demonstration Loop for Autonomous Chemical Product Development Using AI Agents and a Robotic Flow Synthesis System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Protocol: MCP](https://img.shields.io/badge/Protocol-MCP-5A2DDA.svg)](https://modelcontextprotocol.io)

A demonstration software loop showing the complete path of chemical product development
**from a free-form customer request to experimental verification on the rig** —
involving a chain of AI agents and a hardware/software platform: an autonomous synthesis system (Self-Driving Lab, SDL) controlled via the **MCP** (Model Context Protocol).

The system takes a task through **16 stages**: AI agents handle the stages of problem definition, search, design, evaluation,
and planning, while **stage 13** is a real experimental loop:
an AI operator controls a flow chemistry rig through a restricted set of
MCP tools, collects telemetry and NMR analysis data, after which the results
are returned to the chain for analysis, optimization, and the final report.

The system is planned for integration with the CoScientist multi-agent system developed by ITMO University [GitHub - aimclub/CoScientist: Framework for scientific llm-based multi-agent systems · GitHub](https://github.com/aimclub/CoScientist)

The hardware/software synthesis platform is being developed in collaboration between ITMO University, Microfluidika LLC, and RR Robotics LLC.

> In this version, the rig in the demonstration is represented by a **physically plausible emulator**.
> The adapter layer is designed so that the emulator can be replaced with a real
> device without changing the logic of the agents, the MCP tools, or the interface.

---

## About the Project

This tool was created as part of the **NIRSII** project at **ITMO University**.

- **Topic:** "Technologies for predicting the physicochemical properties of component-based
  lubricant formulations and the targeted creation of proprietary additives."
- **Project lead:** A. A. Muravev — Associate Professor at the Infochemistry Scientific Center, ITMO University.

**Main contributors to this demo:**

| Contributor        | Role              | Organization                        |
| ------------------ | ----------------- | ----------------------------------- |
| S. S. Rzhevskii    | CTO               | Microfluidika LLC / ITMO University |
| Dmitry Balyasnikov | Software engineer | RR Robotics LLC                     |
| Alexey Fedorov     | Software engineer | Microfluidica LLC                   |

---

## How the System Works

The user goes through a scenario of four web interface screens, backed by a
single orchestrator on the backend:

1. **Problem definition (stage 1).** The task definition agent refines the
   technical specification in a dialogue: the essence of the request, application domain and environment, target properties,
   constraints and safety requirements, and target scale. The free-form request
   is formalized into a structured specification card. You can describe everything in a single message —
   the agent will extract the fields itself and ask only about what is missing.

2. **Moving through the chain (stages 2–12).** On the left is a menu of 16 stages with the
   active agent highlighted; on the right is a feed of result cards. Each agent relies on
   the formalized specification and the outcomes of the previous stages.

3. **Experimental loop (stage 13).** An invitation to connect the rig appears
   in the chain. The flow rig interface opens (an SVG diagram of the units,
   live telemetry, a log), with parameters pre-filled with a safe plan proposed
   by the process engineering agent. Synthesis is launched on the emulator via MCP tools.

4. **Returning results and completion (stages 14–16).** The final experiment summary
   (target compound concentration, pressure, number of samples, status) is returned to the
   chain. The analytics agent interprets the **real** experiment data, the optimization
   agent proposes the next series, and the report agent assembles the final document
   with JSON export.

### Two Agent Operating Modes

- **Live mode** — when `OPENAI_API_KEY` is set, the agents call the model via the
  OpenAI Responses API.
- **Offline mode** — without a key, each stage produces a correct, plausible result
  from a template. The demonstration runs to completion either way — this is a standard mode.

---

## Pipeline Stages

| #      | Stage / module                | Responsible agent              | Output artifact                                   |
| ------ | ----------------------------- | ------------------------------ | ------------------------------------------------- |
| 1      | Request structuring           | Task definition agent          | Formalized task description                       |
| 2      | Analog search                 | Literature agent               | Compound classes and known analogs                |
| 3      | Candidate generation          | Molecular design agent         | Set of candidate molecules                        |
| 4      | Property prediction           | Property prediction agent      | Candidate ranking                                 |
| 5      | Candidate selection           | Selection agent / orchestrator | Priority list of 2–3 candidates                   |
| 6      | Retrosynthesis                | Synthetic accessibility agent  | Synthesis tree and steps                          |
| 7      | Forward reaction prediction   | Synthetic accessibility agent  | Likely products and risks                         |
| 8      | Reaction classification       | Process engineering agent      | Reaction type and equipment constraints           |
| 9      | Literature verification       | Literature agent               | Confirmed conditions and references               |
| 10     | Economic assessment           | Economic feasibility agent     | Cost and procurement risks                        |
| 11     | Translation to flow synthesis | Process engineering agent      | Preliminary process flow diagram                  |
| 12     | Experiment planning           | Experiment planning agent      | Experiment grid                                   |
| **13** | **MCP/SDL loop (rig)**        | **Experimental loop agent**    | **Experiment log: commands, telemetry, analysis** |
| 14     | Results analysis              | Analytics agent                | Conclusion on composition, purity, and yield      |
| 15     | Optimization                  | Optimization agent             | Next experiment series or recommendation          |
| 16     | Final report                  | Report agent                   | Final report for the team/customer                |

---

## Architecture and Modules

The backend is written in TypeScript (Node.js, Express + WebSocket). Rig and project state
is stored in process memory. The web interface is a self-contained HTML file with no bundler.

```
src/
├── server.ts       HTTP/WebSocket server: REST API, authorization, static files, WS stream
├── config.ts       Configuration from environment; secrets policy (see "Security")
├── pipeline.ts     Project orchestrator across 16 stages: intake, OpenAI calls, fallback
├── agents.ts       Registry of 16 stages: responsible agent, function, offline templates
├── tools.ts        Registry of rig MCP tools + safe-range validation
├── mcp.ts          MCP server (Streamable HTTP) on top of the tool registry
├── chat.ts         Built-in rig operator chat (OpenAI Responses API + MCP)
├── adapter.ts      DeviceAdapter: EmulatorAdapter (+ groundwork for a real device)
├── simulation.ts   Emulator engine: flows, pressures, temperatures, NMR logic
├── state.ts        Rig state model and safety limits
├── log.ts          Event log (ring buffer + subscriptions for WebSocket)
└── smoke.ts        Standalone backend check without HTTP (npm run smoke)

public/index.html   Web interface: 4 screens (Definition → Chain → Rig → Report)
deploy/             nginx config and systemd unit for deployment
```

### Experimental Loop (Stage 13)

Rig model: two reagent vessels → two plunger dosing pumps → preheating →
T-mixer → coil reactor in a thermostat → separation (collection jar +
peristaltic sampling into the NMR module).

Control is performed through a **restricted set of MCP tools** with explicit parameter
schemas. Each call
is range-checked and recorded in the log:

`get_system_status`, `get_telemetry`, `validate_synthesis_plan`, `prepare_synthesis`,
`start_synthesis`, `stop_synthesis`, `set_pump_flows`, `set_temperature_zones`,
`start_sampling`, `start_nmr_initial_calibration`, `generate_experiment_report`,
`emergency_stop`, `reset_demo`.

**Safety limits** (violation → command rejection or emergency stop):

| Parameter             | Allowed range                         |
| --------------------- | ------------------------------------- |
| Reagent A/B flow rate | 0–5 mL/min                            |
| Preheater temperature | 20–80 °C                              |
| Reactor temperature   | 20–100 °C                             |
| Pressure              | ≤ 10 bar (exceeding → emergency stop) |
| Sampling interval     | no more than once every 5 s           |

---

## Quick Start

Requires Node.js version 20 or newer.

```bash
git clone <repository-URL>
cd chem-sdl-pipeline

npm install
cp .env.example .env        # then edit .env to suit your setup

npm run dev                 # development mode with auto-restart
# or
npm run start               # regular start
```

Open `http://localhost:8080` (the port is configurable via `APP_PORT`).
Default credentials are `demo` / `demo` (be sure to change them, see below).

Standalone backend check without HTTP:

```bash
npm run smoke
```

To "bring the agents to life" (instead of offline templates), set the OpenAI key in `.env`:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
```

---

## Configuration

All parameters are set via environment variables (through `.env`). A full example is in
[`.env.example`](./.env.example).

| Variable              | Purpose                                                  | Default                    |
| --------------------- | -------------------------------------------------------- | -------------------------- |
| `APP_HOST`            | Listening interface                                      | `127.0.0.1`                |
| `APP_PORT`            | Backend port                                             | `8080`                     |
| `PUBLIC_URL`          | Public HTTPS address (needed by OpenAI to access `/mcp`) | `http://localhost:8080`    |
| `AUTH_USER`           | Web interface login                                      | `demo`                     |
| `AUTH_PASSWORD`       | Web interface password                                   | demo value (set your own!) |
| `INTERNAL_TOKEN`      | Privileged internal token                                | random per session         |
| `OPENAI_API_KEY`      | OpenAI key; without it — offline mode                    | —                          |
| `OPENAI_MODEL`        | Responses API model                                      | `gpt-5.5`                  |
| `MCP_CONNECTOR_TOKEN` | Bearer protection for the `/mcp` endpoint                | disabled                   |
| `TICK_MS`             | Emulator simulation tick, ms                             | `500`                      |

---

## Security

Sensitive values are **not hardcoded in the source code** and are read only from the environment:

- The **OpenAI key** is stored exclusively on the server and is never sent to the browser.
- The **privileged internal token** (`INTERNAL_TOKEN`, the `mcp` source in the adapter API),
  when absent from the environment, is **generated randomly** for the lifetime of the process —
  there is no fixed "backdoor" constant in the repository. For a permanent value,
  set `INTERNAL_TOKEN` explicitly.
- **Login credentials** are configured via `AUTH_USER` / `AUTH_PASSWORD`. The default
  password is intended **only for a local demo**; if it is not overridden, a warning is
  printed to the console and the log on startup.

For any network deployment, be sure to set your own `AUTH_PASSWORD` and
(if persistent access is needed) `INTERNAL_TOKEN`. The `.env` file is excluded from
the repository via `.gitignore`.

---

## Deployment

The [`deploy/`](./deploy) directory contains an example **nginx** configuration (HTTPS
termination, proxying of REST and the WebSocket `/ws`, exposing `/mcp` externally) and a **systemd** unit
for running the backend as a service.

> **Note:** in the nginx example, `proxy_pass` points to `127.0.0.1:8085`, while the application
> listens on `8080` by default. Reconcile them: either run with `APP_PORT=8085`, or
> fix `proxy_pass`. Also replace the domain name and certificate paths in the config
> with your own.

---

## License

The project is distributed under the **MIT** license — see the [`LICENSE`](./LICENSE) file.
