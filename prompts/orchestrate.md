---
description: Orquesta un flujo de trabajo multi-agente: crea proyecto, lanza workers, delega tareas, monitorea resultados y actualiza estados.
argument-hint: "<descripcion-de-la-tarea>"
---

## Instrucciones de Orquestacion

Objetivo: $1

### Paso 1 — Planificar
1. Lee la estructura del repo si es necesario (`find`, `ls`, `read`).
2. Determina que roles necesitas (reviewer, devops, architect, etc.).
3. Crea un proyecto y tareas en la DB de PM si el trabajo es complejo (>1 hora o >1 agente).

### Paso 2 — Preparar Infraestructura
1. Verifica agentes activos: `/fabric-list` o `fabric_list_agents`.
2. Lanza workers faltantes con `scripts/launch-agent.sh` o `src/core/launcher.ts`.
   - `--role=<rol> --agent-id=<nombre> --mode=rpc`
3. Crea worktrees/branches si es necesario (`git worktree add`).

### Paso 3 — Delegar
1. Asigna cada worker a su tarea (`INSERT INTO agent_associations ...`).
2. Envia contrato detallado via `/fabric-send <id>` o `fabric_send_message`:
   - Contexto y archivos relevantes
   - Criterios de aceptacion
   - Formato de respuesta esperado (bloques markdown con codigo)

### Paso 4 — Monitorear
1. Revisa mailbox del coordinator (`/fabric-inbox`).
2. Espera respuestas de workers (indicadores de estado en `/fabric-list`).
3. Si un worker esta en `error` o `tool_blocked`, interviene.

### Paso 5 — Consolidar
1. Valida entregables del worker.
2. Si hay dependencias entre tareas, verifica que esten resueltas antes de avanzar.
3. Actualiza estados en PM: `ready_for_validation` → `validated` → `ready_for_pr` → `pr_open` → `pr_merged` → `done`.
4. Escribe resumen al usuario y registra decisiones en `event_log`.

### Formato de Contrato al Worker
```
[Tarea]: <titulo>

Contexto:
- Archivos relevantes: <rutas>
- Estado actual: <resumen>

Criterios de aceptacion:
1. <criterio 1>
2. <criterio 2>

Restricciones:
- <regla especifica del proyecto>

Responde con:
- Codigo en bloques markdown con nombre de archivo
- Tests si aplica
- Notas de decisiones (ADRs)
```
