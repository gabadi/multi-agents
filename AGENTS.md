# AGENTS.md — Guía de Supervivencia para cmd-center-v2

> Si acabas de entrar a este repo y no entiendes por qué las tools no aparecen, lee esto primero.
>
> **English quick context (startup + messaging architecture):** `docs/lazy/extensions-startup-and-messaging.md`

## 1. ¿Qué es este repo?

**cmd-center-v2** es un centro de comandos para correr múltiples agentes AI cooperativos sobre `pi.dev`.  
No usa brokers, Redis ni Docker. La comunicación es P2P via archivos mailbox + señales `SIGUSR1` dentro de una sesión tmux.

Componentes principales:
- **Fabric Core** (`src/core/`): extensión pi, launcher, monitor SSE, skill-loader y tests.
- **Project Management** (`src/pm/`): schema SQLite + queries para trackear planes, tareas, subtasks, dependencias y eventos.
- **Agentes Standalone** (`src/agents/`): workers headless (Gemini, Telegram Gateway) que corren fuera de pi.dev pero se registran en el mismo registry.
- **Telegram Bridge** (dentro de `src/core/monitor.ts`): bridge dedicado entre Telegram y los coordinadores. Es el único componente con derecho a tocar Telegram.
- **Dashboard** (`dashboard/index.html`): UI vanilla que se conecta al monitor SSE en `localhost:7474`.
- **Skills** (`skills/`): personalidades por rol definidas en `SKILL.md` con frontmatter técnico (model, tools, thinking, mode). Cargadas dinámicamente por el launcher.
- **Prompts** (`prompts/`): templates reutilizables.

## 2. Regla de Oro: La extensión y las tools son invisibles por diseño

La extensión de Fabric (`src/core/extension.ts`) **solo se activa** si existe la variable de entorno:

```bash
export ENABLE_CMD_CENTER=TRUE
```

Si no está seteada **antes** de arrancar `pi`:
- No se registra ningún comando (`/fabric-list`, `/fabric-send`, etc.).
- No se registran las tools del LLM (`fabric_send_message`, `fabric_list_agents`).
- No hay footer de estado ni handlers de SIGUSR1.
- El paquete es completamente transparente.

### Troubleshooting: "No veo las tools"

| Síntoma | Causa probable | Fix |
|---------|---------------|-----|
| `/fabric-list` no existe | Extensión no cargada o `ENABLE_CMD_CENTER` ausente | `export ENABLE_CMD_CENTER=TRUE` y reiniciar pi |
| Las tools no aparecen en el contexto del LLM | Lo mismo arriba | Verificar que la sesión de pi se abrió con la env var |
| El paquete no aparece en `pi list` | No está instalado | `pi install /Users/jescobar/code/cmd-center-v2` (local) o `pi install git:github.com/jescobar/cmd-center-v2` |
| `src/core/extension.ts` tiene errores | Syntax/TS error en la extensión | Revisar con `pi -e ./src/core/extension.ts` para test rápido |
| `fabric_launch_agent` falla o inyecta texto en el coordinador | Mecanismo `send-keys` obsoleto en uso | Verificar `src/core/launcher.ts` usa `split-window -P -F` (no `send-keys`). Ver lección: `docs/lessons/launcher-send-keys-race-condition.md` |

### Verificar carga de la extensión

Desde dentro de una sesión `pi` interactiva:
```
/reload
```
Si la extensión cargó correctamente, verás notificaciones tipo:
> `🧠 Fabric Agent: boss | role=coordinator | pid=...`

## 3. Cómo lanzar el ecosistema completo

### Paso 1: Variables de entorno (en el shell ANTES de todo)

```bash
export ENABLE_CMD_CENTER=TRUE
```

### Paso 2: Instalar el paquete (una sola vez)

```bash
pi install /Users/jescobar/code/cmd-center-v2
```

O para desarrollo con hot-reload via symlink:
```bash
ln -s /Users/jescobar/code/cmd-center-v2 ~/.pi/agent/extensions/cmd-center
```

### Paso 3: Lanzar el monitor (dashboard SSE)

```bash
npx tsx src/core/monitor.ts --port=7474
```

Abre `http://localhost:7474` (o sirve `dashboard/index.html` desde cualquier servidor).

### Paso 4: Lanzar agentes en tmux

```bash
# Coordinador (TUI visible, jefe) — YA NO conecta Telegram
npx tsx src/core/launcher.ts --role=coordinator --agent-id=boss --mode=interactive

# Workers headless
npx tsx src/core/launcher.ts --role=reviewer --agent-id=alice --mode=rpc
npx tsx src/core/launcher.ts --role=devops --agent-id=bob --mode=rpc
```

Esto crea una sesión tmux `fabric-default` con panes. Puedes attachar con:
```bash
tmux attach -t fabric-default
```

### Paso 5: Telegram Bridge (dentro del monitor)

El bridge de Telegram vive **dentro del monitor** (`src/core/monitor.ts`). No hay proceso separado.

```bash
# Lanzar monitor — el bridge de Telegram arranca automáticamente si hay config
npx tsx src/core/monitor.ts --port=7474
```

**Nota:** el monitor es el **único** proceso que toca Telegram. Los coordinadores (`boss`, `sub-coordinator`) ya no auto-conectan Telegram. El monitor:
- Hace polling de Telegram API cada 2s
- Reenvía mensajes al coordinador activo (`boss` por default) vía mailbox + SIGUSR1
- Recibe respuestas del coordinador vía HTTP POST a `/api/telegram/outbound`
- Envía la respuesta al chat correcto de Telegram

**Requisito previo:** configurar Telegram una sola vez dentro de pi:
```
/telegram-setup
```
Pega el token de @BotFather. Envía `/start` a tu bot. El monitor lee `~/.pi/agent/telegram-config.json`.

## 4. Estructura de carpetas (la única fuente de verdad)

```
cmd-center-v2/
├── AGENTS.md                 # ← ESTE ARCHIVO
├── package.json              # Manifest Pi Package (apunta a src/core/extension.ts)
├── README.md                 # Overview humano
│
├── src/
│   ├── core/
│   │   ├── extension.ts      # Entry point de la extensión pi.dev
│   │   ├── launcher.ts       # Crea panes tmux y lanza pi con env vars
│   │   ├── skill-loader.ts   # Parser dinámico de SKILL.md (frontmatter)
│   │   ├── monitor.ts        # HTTP+SSE server (puerto 7474), lee registry SQLite
│   │   └── test-core.ts      # Tests unitarios de mailbox/SIGUSR1 sin pi
│   │
│   ├── agents/               # Reservado para agentes standalone futuros
│   │
│   └── pm/                   # Project Management domain
│       ├── db.ts             # initDb() — schema completo SQLite
│       ├── monitor-db.ts     # Queries usadas por monitor.ts (proviene de pm-db.ts)
│       ├── events.ts         # appendProjectEvent() — JSONL event log
│       ├── queries.ts        # Queries tipadas para projects/tasks/subtasks
│       ├── commands.ts       # Comandos CLI para PM (si aplica)
│       ├── transitions.ts    # Lógica de cambio de estado con validación
│       ├── dependencies.ts   # Grafo de dependencias task/subtask
│       ├── worktree.ts       # Gestión de git worktrees
│       ├── attachments.ts    # Asociación de archivos/PRs
│       ├── agents.ts         # Asociación agente ↔ task
│       ├── dashboard.ts      # Resumen para dashboard
│       ├── seed.ts           # Datos de seed/demo
│       ├── cleanup.ts        # Limpieza de worktrees/agentes muertos
│       ├── enums.ts          # Status enums
│       └── integration.test.ts # Tests de integración PM
│
├── skills/                   # Skills pi.dev auto-descubiertos (rol → frontmatter)
│   ├── coordinator/SKILL.md      # Manual del coordinador principal
│   ├── sub-coordinator/SKILL.md  # Sub-coordinador federado (worktree externo)
│   ├── dev/SKILL.md              # Implementación
│   ├── reviewer/SKILL.md         # Code review + QA gate
│   ├── tester/SKILL.md           # QA/tests/evidencia reproducible
│   ├── security/SKILL.md         # Threat modeling + seguridad
│   ├── devops/SKILL.md
│   ├── git/SKILL.md              # GitOps / PRs
│   ├── architect/SKILL.md
│   ├── setup/SKILL.md
│   └── chat/SKILL.md
│
├── prompts/
│   └── audit-pr.md           # Prompt template /audit-pr
│
├── dashboard/
│   └── index.html            # Dashboard vanilla SSE (conéctalo al monitor)
│
├── plans/                    # Planes ejecutados y por ejecutar
│   ├── README.md             # Índice y convenciones
│   ├── fabric-from-scratch.md        # ✅ Implementado
│   ├── fabric-monitor-dashboard.md   # 🚧 Planificado
│   ├── project_management.md         # 🚧 En progreso
│   ├── project-dashboard-integration.md # 🚧 Planificado
│   └── federated-sub-coordinators.md  # 🚧 En progreso (sub-coordinadores en worktrees)
│
├── docs/
│   ├── TELEGRAM-BOSS-PERSISTENT.md   # Integración Telegram bridge
│   └── lessons/
│       ├── README.md
│       └── fabric-coordination-postmortem.md
│
└── patches/
    └── pi-telegram-autoconnect.patch   # Patch para auto-connect de Telegram
```

## 4b. Sub-coordinadores Federados (nuevo)

Una tarea compleja puede tener su **propio sub-coordinador** en un worktree de otro repo:

```
Principal (cmd-center-v2, session fabric-default)
  └── Sub-coord-42 (worktree proyecto-A, session fabric-task-42)
       ├── Worker reviewer-42
       ├── Worker devops-42
       └── Chat con humano en TUI del sub-coord
```

### Lanzar sub-coordinador desde el principal

```bash
cd ../worktrees/task-42-proyecto-A
ENABLE_CMD_CENTER=TRUE \
FABRIC_PARENT_AGENT_ID=boss \
npx tsx /ruta/a/cmd-center-v2/src/core/launcher.ts \
  --role=sub-coordinator \
  --agent-id=sub-boss-42 \
  --mode=interactive \
  --session=fabric-task-42 \
  --workspace-dir="$(pwd)"
```

### Características clave
- **Zero install**: todo se carga via la extensión Fabric global + `pi`.
- **Skills híbridos controlados**: carga skills de `cmd-center-v2/skills/` + skills locales del repo (`./skills/`, `.pi/skills/`, `.agents/skills/`, `.claude/skills/`). En monorepos, el sub-coordinador debe lanzar workers con `workspace_skills` o `no_workspace_skills` para evitar cargar todo.
- **Registry compartido**: usa `/tmp/fabric-agents/registry.sqlite` → el principal ve a todos.
- **Reporte lazy**: `/fabric-report` envía resumen al `FABRIC_PARENT_AGENT_ID` solo al finalizar.
- **Efímero**: muere cuando la tarea termina (`tmux kill-session -t fabric-task-42`).

## 4b. Tools Determinísticas del Fabric Mesh

Todas las custom tools están definidas en `src/core/extension.ts` y son **visibles para todos los roles** (coordinator, sub-coordinator, dev, reviewer, tester, security, chat, devops, architect, git). Pero **quién las invoca** depende del rol y del momento del workflow.

### Tabla de Tools × Rol × Contexto

| Tool | Descripción | Principal Usuario | Cuándo se usa | Quién NO debería usarla |
|------|-------------|-------------------|---------------|--------------------------|
| `fabric_send_message` | Enviar mensaje P2P genérico a otro agente | Cualquier agente | Chat ad-hoc entre workers, respuestas que no son reportes de tarea | — (universal) |
| `fabric_launch_agent` | Lanzar nuevo agente (crea pane, espera ACK, soporta `workspace_dir`, `workspace_skills`, `no_workspace_skills`) | `coordinator`, `sub-coordinator` | Cuando se necesita un nuevo worker para una tarea. En monorepos, el sub-coordinador DEBE escoger skills locales mínimas | Workers autónomos (deben pedir al coordinator) |
| `fabric_send_task` | Enviar contrato de trabajo estructurado | `coordinator`, `sub-coordinator` | Después de lanzar un worker, para decirle QUÉ hacer y a QUIÉN reportar | Workers (ellos reciben, no envían) |
| `fabric_report_completion` | Reportar resultado de tarea (`done` / `failed` / `blocked`) | Cualquier worker (`dev`, `reviewer`, `chat`, `devops`, etc.) | Al terminar un contrato recibido vía `fabric_send_task`. **Siempre** en lugar de bash→mailbox | Coordinators (ellos reciben el reporte) |
| `fabric_list_agents` | Listar todos los agentes del registry | Cualquier agente | Para descubrir quién está vivo, qué rol tiene, y en qué estado | — (universal) |
| `pm_write_analysis` | Guardar análisis/contexto de una tarea | Workers y coordinadores | Después de iteraciones, errores, decisiones o revisiones | — |
| `pm_read_analyses` / `pm_inject_task_context` | Recuperar contexto histórico | Coordinadores y workers | Antes de reasignar o continuar tareas | — |

### Flujo Típico Coordinator → Worker

```
1. boss (coordinator, interactive)
   → invoca fabric_launch_agent(role="dev", agent_id="worker-1", report_to="boss", workspace_dir="/repo", workspace_skills=["skill-necesaria"])
      → extension spawnea launcher.ts en background (async, no bloquea)
      → launcher crea pane vía split-window -P -F (thread-safe, sin race condition)
      → launcher espera ACK (healthcheck) 20s
      → worker arranca (zsh -i carga ~/.zshrc naturalmente) y envía healthcheck a boss mailbox

2. boss
   → invoca fabric_send_task(to="worker-1", description="fix bug X", report_to_when_done="boss")
      → escribe contract en mailbox de worker-1
      → envía SIGUSR1 para despertar al worker
      → worker lee contract → renderiza prompt estructurado para su LLM

3. worker-1 (dev, rpc)
   → LLM hace el trabajo (lee archivos, edita código, etc.)
   → LLM invoca fabric_report_completion(to="boss", status="done", summary="...")
      → extensión escribe response en mailbox de boss
      → envía SIGUSR1 a boss

4. boss
   → recibe response en mailbox
   → actualiza estado del proyecto/task en PM DB
```

### Reglas de Oro

1. **Si eres worker y terminaste un contrato → usa `fabric_report_completion`.** Nunca uses `bash` para escribir a `/tmp/fabric-agents/mailboxes/boss.jsonl`.
2. **Si eres coordinator y necesitas un worker → usa `fabric_launch_agent` + `fabric_send_task`.** No lances `pi` manualmente en tmux.
3. **Si necesitas saber quién está vivo → usa `fabric_list_agents`.** No consultes SQLite directamente con `bash`.
4. **Si necesitas chatear con otro agente → usa `fabric_send_message`.** No reinventes el protocolo.

### Visibilidad de Tools: Cómo Funciona

Las tools `fabric_*` se registran en `session_start` de la extensión. Para que el LLM las vea:
- Deben tener `promptSnippet` + `promptGuidelines` (Pi las inyecta en el system prompt)
- En modo `rpc`, el launcher **no debe pasar `--tools read,bash`** (eso filtraría las custom tools)
- La extensión auto-activa las tools `fabric_*` y `pm_*` vía `pi.setActiveTools()` si faltan

Ver lecciones detalladas en `docs/lessons/pi-tool-visibility.md` y `docs/lessons/fabric-tools-determinism.md`.

### Contract Schema — Acceptance Criteria Estructurados

Todo `fabric_send_task` DEBE incluir `acceptance_criteria` como array de objetos verificables. No se aceptan strings genéricos.

```json
{
  "to": "worker-1",
  "description": "Implementar validación de input",
  "acceptance_criteria": [
    {
      "id": "c1-existe",
      "description": "Archivo src/api/users.ts contiene función validateUser",
      "type": "file_contains",
      "params": { "path": "src/api/users.ts", "pattern": "function validateUser" },
      "required": true
    },
    {
      "id": "c2-tests",
      "description": "Tests pasan",
      "type": "test_passes",
      "params": { "command": "npx tsx src/api/users.test.ts" },
      "required": true
    }
  ],
  "report_to_when_done": "boss",
  "task_id": "subtask-42"
}
```

**Tipos de criterio válidos:** `file_exists`, `file_contains`, `file_not_contains`, `test_passes`, `db_query`, `http_status`, `command_exit_0`, `command_output_contains`, `command_output_not_contains`, `manual`.

**El worker DEBE:**
1. Implementar la tarea.
2. Verificar cada criterio antes de reportar.
3. Solo reportar `done` si TODOS los `required: true` pasan.
4. Reportar `failed` con detalle de qué criterio falló.
5. Incluir siempre `verification_results` en `fabric_report_completion`; el coordinator ahora los recibe y los ve en el TUI.

**El coordinator DEBE:**
- NUNCA enviar contrato sin `acceptance_criteria` estructurados.
- Si no sabe cómo verificar algo, usar `type: "manual"` con `params.instructions`.

Ver `src/pm/contract-schema.ts` para el validador y `skills/dev/SKILL.md` / `skills/coordinator/SKILL.md` para instrucciones detalladas.

## 5. Runtime efímero (todo vive en `/tmp`)

```
/tmp/fabric-agents/
├── registry.sqlite         # Agentes registrados + estado semántico
├── mailboxes/{id}.jsonl    # Cola P2P por agente
├── pids/{id}.pid           # PID para SIGUSR1 wakeup
├── state/{id}.json         # Offset de lectura del mailbox
├── agents.jsonl            # Eventos globales Fabric
├── projects.sqlite         # DB de Project Management (ahora vive aquí también)
└── projects.jsonl          # Event stream de PM
```

**Importante:** todo es efímero excepto que el monitor o los agentes escriban a rutas persistentes. Reiniciar la máquina borra `/tmp`. Si quieres persistencia, cambia `FABRIC_DIR` a un path fuera de `/tmp`.

## 6. Planes ejecutados y estado

| Plan | Estado | Notas |
|------|--------|-------|
| `fabric-from-scratch.md` | ✅ Implementado | Extensión, launcher, mailbox, SIGUSR1, registry SQLite |
| `project_management.md` | 🚧 En progreso | Schema + queries listos. Falta integración con extension commands/tools |
| `fabric-monitor-dashboard.md` | 🚧 Planificado | Monitor HTTP+SSE ya existe pero faltan widgets PM |
| `project-dashboard-integration.md` | 🚧 Planificado | Unificar eventos PM en el dashboard |
| `federated-sub-coordinators.md` | 🚧 En progreso | Fase 1: skill + launcher dinámico. Falta: cleanup auto, PM integration, testing E2E |
| `telegram-gateway-agent.md` | 🚧 En progreso (Fase 1) | Gateway scaffold implementado. Falta: polish engine, buffer/approval modes, routing federado, PM integration |

### Por qué "no se ven resultados" después de ejecutar planes

1. **Los planes son documentación.** Ejecutar un plan significa que el código fue escrito, pero no que el sistema está corriendo.
2. **La extensión pi requiere instalación + env var + reinicio.** Si solo editaste archivos pero no reiniciaste `pi` con `ENABLE_CMD_CENTER=TRUE`, no hay cambios visibles.
3. **Las tools del LLM no se auto-inyectan.** Son registradas por la extensión en `session_start`. Si la extensión no cargó, el LLM no sabe que existen.
4. **Los schemas de tools (TypeBox) se cachean en la sesión pi.** Si editaste `src/core/extension.ts` (ej: agregaste un nuevo parámetro a `fabric_send_task`), DEBÉS ejecutar `/reload` dentro de pi o reiniciar la sesión. Los skills (`skills/*.md`) se leen fresh de disco en cada `launchWorker()`, pero los schemas de extensión requieren recarga.

## 7. Comandos útiles para diagnosticar

```bash
# Ver si la extensión está cargada
pi list

# Ver agentes registrados (desde fuera de pi)
sqlite3 /tmp/fabric-agents/registry.sqlite "SELECT agent_id, role, fabric_status, active_tool, last_seen_at FROM agents;"

# Ver últimos eventos
tail -f /tmp/fabric-agents/agents.jsonl

# Ver mailbox de un agente
tail -f /tmp/fabric-agents/mailboxes/boss.jsonl

# Matar un agente zombie
kill -9 <PID> && rm /tmp/fabric-agents/pids/<agent-id>.pid

# Reset completo (⚠️ borra todo)
rm -rf /tmp/fabric-agents && tmux kill-session -t fabric-default
```

## 8. Convenciones de código

- **Zero external deps**: usamos solo Node.js builtins (`node:sqlite`, `node:fs`, etc.).
- **TypeScript con shebang**: los scripts CLI usan `#!/usr/bin/env npx tsx` para ejecutar directo.
- **Import relativos**: dentro de `src/`, usa rutas relativas (`../pm/monitor-db.js`).
- **SQLite sync**: `DatabaseSync` (no async/await) para simplicidad.
- **JSONL append-only**: eventos y mailboxes son siempre append-only; nunca truncar en caliente.
- **Env vars**: toda la config pasa por `process.env`; no hardcodear paths.

## 9. Qué hacer si entras como agente nuevo

1. **Leer `plans/README.md`** para ver qué plan está activo.
2. **Verificar `ENABLE_CMD_CENTER=TRUE`** en el entorno antes de arrancar pi.
3. **Correr `npx tsx src/core/monitor.ts`** si necesitas observabilidad.
4. **Usar `npx tsx src/core/launcher.ts --role=...`** para crear agentes, no invocar `pi` manualmente en tmux.
5. **Nunca editar directamente `src/core/extension.ts`** sin entender el lifecycle de Pi (ver docs de Pi en `~/.local/share/mise/installs/node/.../pi-coding-agent/docs/`).

## 10. Decisiones arquitectónicas clave (no romper)

- **Sin polling**: los workers duermen hasta `SIGUSR1`. Si cambias esto a polling, matarás la batería/latencia.
- **Coordinator en interactive mode**: solo el jefe tiene TUI. Los workers deben ser `rpc`.
- **Mailbox files antes que sockets**: los archivos son más resistentes a crashes que sockets o pipes.
- **PM DB separado del registry**: `registry.sqlite` (agentes) y `projects.sqlite` (trabajo) son dos DBs distintas.
- **Solo el gateway toca Telegram**: los coordinadores y workers nunca conocen Telegram. El gateway es el único owner del bridge. Esto permite que el coordinador muera y renazca sin perder el contacto con el humano.

---

**Última actualización:** 2026-05-04 (sesión de reorganización post-4-planes).  
**Si algo falla:** revisar `plans/README.md` → `README.md` → este `AGENTS.md` → código fuente.
