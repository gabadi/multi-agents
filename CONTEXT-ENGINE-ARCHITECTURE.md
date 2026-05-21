# Context Engine: Arquitectura de Control Multi-Agente
## cmd-center-v2: pi.dev como Plataforma de Contexto Controlado

**Versión:** 1.0  
**Fecha:** Mayo 2026  
**Autor:** Jose Escobar (Arquitectura de Agentes)  
**Estado:** Sistema operativo en producción (piloto)

---

## 1. Executive Summary

### El Problema que Resolvemos

Los sistemas multi-agente tradicionales fallan porque:
- **Pasan demasiado contexto** → los agentes se confunden y alucinan
- **Agentes "todo-sabedores"** → sin especialización real
- **Sin validación de trabajo** → errores se propagan
- **Planes vagos** → ejecución caótica

### Nuestra Solución: Context Engine con Control Total

Hemos construido un **Context Engine** donde:
- Cada agente recibe **exactamente** el contexto que necesita
- Los agentes son **efímeros y especializados** (no chatbots)
- Cada entrega pasa por **validación estructurada**
- El **plan es el contrato** entre humano y máquina

### Filosofía Central

> *"No es cuánto contexto tienes, es quién controla qué contexto recibe cada agente"*

---

## 2. ¿Qué es un Context Engine?

### Definición

Un **Context Engine** es una arquitectura de software que:
1. **Almacena** conocimiento contextual en capas semánticas
2. **Distribuye** contexto selectivamente a agentes especializados
3. **Persiste** aprendizajes entre sesiones
4. **Valida** la calidad del contexto antes de propagarlo

### Contexto en el Mercado

**Redis Iris** (anunciado Mayo 2026) usa este término para su suite de productos:
- Context Retriever (capa semántica)
- Agent Memory (persistencia de memoria)
- LangCache (caching semántico)

**Nuestro cmd-center-v2** es un Context Engine **complementario pero filosóficamente diferente**:

| Aspecto | Redis Iris | cmd-center-v2 |
|---------|------------|---------------|
| **Enfoque** | Conveniencia (todo automático) | Control (tú decides qué viaja) |
| **Agentes** | Stateful/persistentes | Ephemeros/efímeros |
| **Contexto** | Pull (agente pide) | Push (coordinador inyecta) |
| **Validación** | Implícita por mejor reasoning | Explícita por reviewer gates |
| **Memoria** | Automática/transparente | Controlada/deliberada |

---

## 3. Nuestra Arquitectura: Componentes

### 3.1 Stack Tecnológico

```
┌─────────────────────────────────────────────────────────────────┐
│                     CAPA DE PRESENTACIÓN                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Telegram   │  │  Dashboard  │  │  VS Code Extension      │  │
│  │   Bridge    │  │   (HTTP)    │  │  (pi.dev + cmd-center)  │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
└─────────┼────────────────┼────────────────────┼────────────────┘
          │                │                    │
          └────────────────┴────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────────┐
│                    CONTROL PLANE (cmd-center-v2)               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              Coordinator Principal ("boss")                │  │
│  │  - Recibe misión del humano                              │  │
│  │  - Descompone en subtareas                                │  │
│  │  - Selecciona contexto relevante de SQLite               │  │
│  │  - Inyecta contexto + contrato a workers                │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                  │
│  ┌──────────────────────────▼───────────────────────────────┐  │
│  │              Sub-coordinadores ("sub-boss-{n}")           │  │
│  │  - Contexto más específico                               │  │
│  │  - Validación de plan                                     │  │
│  │  - Re-intenta si falla validación                         │  │
│  └──────────────────────────┬───────────────────────────────┘  │
│                             │                                  │
│  ┌──────────────────────────▼───────────────────────────────┐  │
│  │              Workers Especializados                      │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │  │
│  │  │   dev-1     │  │ reviewer-1  │  │   test-{n}      │   │  │
│  │  │ (escritura) │  │ (validación)│  │ (verificación)  │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
          │
          │ JSONL Mailbox + SIGUSR1 (IPC)
          │
┌─────────▼───────────────────────────────────────────────────────┐
│                    PERSISTENCE LAYER                            │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐  │
│  │   SQLite            │  │   File System                     │  │
│  │   projects.sqlite   │  │   /tmp/fabric-agents/             │  │
│  │   - tasks           │  │   - mailboxes/{id}.jsonl          │  │
│  │   - subtasks        │  │   - pids/{id}.pid                 │  │
│  │   - analyses        │  │   - state/{id}.json               │  │
│  │   - event_log       │  │   - launch-logs/                  │  │
│  └─────────────────────┘  └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
          │
          │ git worktree
          │
┌─────────▼───────────────────────────────────────────────────────┐
│                    EXECUTION ENVIRONMENT                        │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              tmux Sessions                              │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │  │
│  │  │   pane 0    │  │   pane 1    │  │   pane n        │   │  │
│  │  │  (monitor)  │  │  (boss)     │  │  (worker-{n})   │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 pi.dev como Base

**¿Por qué pi.dev?**

pi.dev es una extensión VS Code que permite ejecutar agentes LLM con:
- **Contexto controlado** por archivo (SKILL.md)
- **Herramientas explícitas** (read, write, edit, bash)
- **Modelo configurables** por agente
- **Modos**: interactive (humano presente) vs rpc (autónomo)

**Nuestra extensión sobre pi.dev** (`ENABLE_CMD_CENTER=TRUE`):

```typescript
// src/core/extension.ts - Nuestro valor agregado

// 1. Registro de agentes en runtime compartido
registerAgent(agentId, role, mode, session);

// 2. Mailbox system para mensajería entre agentes
sendMessage(to, type, payload);
receiveMessage(callback);

// 3. Fabric tools para orquestación
fabric_launch_agent(...)      // Spawn new agent
fabric_send_task(...)          // Send structured contract
fabric_send_reviewer_gate_phase(...)  // Validation loop
fabric_report_completion(...)    // Task completion with criteria verification

// 4. Project Management integration
pm_create_task_intelligent(...)
pm_write_analysis(...)
pm_get_project_context(...)
```

---

## 4. Control de Contexto: El Diferenciador

### 4.1 Skill System: La Capa Semántica

**Archivo SKILL.md** = Definición de "qué es este agente"

```yaml
---
# skills/dev/SKILL.md
name: dev
description: Developer worker specialized in implementation
model: fern/gpt-5.3-codex
tools: read,write,edit,bash,grep,find
thinking: medium
mode: rpc
max_retries: 2
---
```

**¿Por qué esto es un Context Retriever?**

Igual que Redis Iris Context Retriever expone "Customer", "Order" como entidades de negocio, nuestro SKILL.md expone roles como entidades operativas:

| Redis Iris | cmd-center-v2 |
|------------|---------------|
| `Customer` entity | `coordinator` role |
| `Order` entity | `dev` role |
| Fields: id, name, total | Fields: tools, model, thinking, mode |
| MCP query: "get_customer_by_id" | Skill loader: "load_profile('dev')" |

### 4.2 Task Contracts: Contexto Estructurado

**Ejemplo real de contrato enviado a un agente:**

```typescript
fabric_send_task({
  to: "dev-1",
  description: "Implement user authentication middleware",
  
  // Contexto INYECTADO (no todo el repo, solo lo relevante)
  files: [
    "src/auth/middleware.ts",      // Contexto específico
    "src/types/user.d.ts",         // Tipos necesarios
    "tests/auth/middleware.test.ts" // Tests de referencia
  ],
  
  // Criterios EXPLÍCITOS (el contrato)
  acceptance_criteria: [
    {
      id: "AC1",
      type: "file_exists",
      required: true,
      description: "Middleware file exists at src/auth/middleware.ts",
      params: { path: "src/auth/middleware.ts" }
    },
    {
      id: "AC2",
      type: "test_passes",
      required: true,
      description: "All auth middleware tests pass",
      params: { test_pattern: "tests/auth/middleware*.test.ts" }
    },
    {
      id: "AC3",
      type: "file_not_contains",
      required: true,
      description: "No console.log statements in production code",
      params: { 
        file_path: "src/auth/middleware.ts",
        search_string: "console.log"
      }
    }
  ]
});
```

**Resultado:** El agente `dev-1` recibe:
- ✅ 3 archivos relevantes (no 500 del monorepo)
- ✅ 3 criterios de validación claros
- ✅ Tipo de verificación explícita
- ❌ Cero contexto irrelevante

### 4.3 Ciclo de Vida: Contexto en Cada Fase

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    CICLO DE VIDA DE UN AGENTE                            │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. CONCEPCIÓN                                                           │
│  ┌─────────────┐                                                         │
│  │ Human       │  "Necesito feature X"                                    │
│  │ Coordinator │                                                         │
│  └──────┬──────┘                                                         │
│         │                                                                │
│         ▼                                                                │
│  2. DECOMPOSICIÓN                                                        │
│  ┌─────────────────────────────────────────┐                             │
│  │ Cargar análisis previos de SQLite      │ ◄── Contexto histórico      │
│  │ Crear subtareas estructuradas           │                             │
│  │ Definir criterios de validación         │                             │
│  └───────────────────┬─────────────────────┘                             │
│                      │                                                   │
│         ┌────────────┼────────────┐                                      │
│         ▼            ▼            ▼                                      │
│  3. DISTRIBUCIÓN DE CONTEXTO                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │
│  │ sub-boss-1  │  │ sub-boss-2  │  │ sub-boss-3  │                      │
│  │ (backend)   │  │ (frontend)  │  │ (tests)     │                      │
│  │             │  │             │  │             │                      │
│  │ Skill: dev  │  │ Skill: dev  │  │ Skill: test │                      │
│  │ Files: API  │  │ Files: UI   │  │ Files: Spec │                      │
│  │ Ctx: DB sch │  │ Ctx: Comp   │  │ Ctx: Req    │                      │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                      │
│         │                │                │                              │
│         ▼                ▼                ▼                              │
│  4. EJECUCIÓN (tmux pane)                                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │
│  │ dev-1       │  │ dev-2       │  │ test-1      │                      │
│  │             │  │             │  │             │                      │
│  │ SÓLO ve:    │  │ SÓLO ve:    │  │ SÓLO ve:    │                      │
│  │ - 3 files   │  │ - 3 files   │  │ - 2 files   │                      │
│  │ - skill dev │  │ - skill dev │  │ - skill test│                      │
│  │ - contrato  │  │ - contrato  │  │ - contrato  │                      │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                      │
│         │                │                │                              │
│         └────────────────┼────────────────┘                              │
│                          ▼                                               │
│  5. VALIDACIÓN                                                           │
│  ┌─────────────────────────────────────────┐                             │
│  │ reviewer-1 revisa contra criterios      │                             │
│  │ Si falla → retry con findings           │                             │
│  │ Si pasa → reporta completion            │                             │
│  └───────────────────┬─────────────────────┘                             │
│                      │                                                   │
│                      ▼                                                   │
│  6. PERSISTENCIA                                                         │
│  ┌─────────────────────────────────────────┐                             │
│  │ Análisis escrito a SQLite               │ ◄── Memoria a largo plazo   │
│  │ Event log para audit trail              │                             │
│  │ Agente muere (tmux pane cierra)         │ ◄── Agente EFÍMERO          │
│  └─────────────────────────────────────────┘                             │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---
## 5. El Sistema de Validación: Reviewer Gates

### 5.1 Filosofía

> *"Un agente no marca su propia tarea como completa. Otro agente la valida contra criterios explícitos."*

Esto previene:
- **Alucinaciones** (el reviewer detecta falsedades)
- **Código roto** (el reviewer corre tests)
- **Contexto contaminado** (el reviewer verifica no regresiones)

### 5.2 Flujo de Reviewer Gate

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    REVIEWER GATE PHASE                                   │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐            │
│  │  Worker     │      │  Reviewer   │      │ Coordinator │            │
│  │ (dev-1)     │      │ (reviewer-1)│     │ (boss)      │            │
│  └──────┬──────┘      └──────┬──────┘      └──────┬──────┘            │
│         │                    │                    │                    │
│         │─── 1. Report completion ────►│                    │            │
│         │    (artifacts, summary)        │                    │            │
│         │                    │                    │                    │
│         │                    │─── 2. Validate ───►│                    │
│         │                    │    criteria        │                    │
│         │                    │                    │                    │
│         │◄── 3. Findings ──│                    │                    │
│         │    (if failed)     │                    │                    │
│         │                    │                    │                    │
│         │─── 4. Retry (max 1)│                    │                    │
│         │    (with findings) │                    │                    │
│         │                    │                    │                    │
│         │                    │─── 5. Re-validate ─┼──► 6. Done/Failed │
│         │                    │                    │                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Ejemplo Real

**Criterio fallido:**
```json
{
  "id": "AC2",
  "type": "test_passes",
  "passed": false,
  "error": "Test 'should handle expired token' failed: 
            Expected 401, got 200. 
            Missing token expiration check in middleware."
}
```

**Retry con contexto inyectado:**
```typescript
fabric_request_reviewer_retry({
  to: "dev-1",
  findings: "El test 'should handle expired token' está fallando. 
            El middleware no verifica expiración del token JWT. 
            Agrega verificación de jwt.exp < Date.now() antes de validar firma."
});
```

**Resultado:** El worker recibe contexto específico del fallo, no tiene que descubrirlo solo.

---

## 6. Comparativa: cmd-center-v2 vs Redis Iris

### 6.1 Tabla Comparativa

| Dimensión | Redis Iris | cmd-center-v2 | Ventaja de cada uno |
|-----------|------------|---------------|---------------------|
| **Filosofía** | Conveniencia | Control | Iris: rápido de adoptar. Nosotros: predecible |
| **Contexto** | Automático/persistente | Inyectado/deliberado | Iris: sin fricción. Nosotros: sin sorpresas |
| **Agentes** | Stateful (recuerdan) | Stateless (efímeros) | Iris: continuidad. Nosotros: isolation |
| **Validación** | Implícita (mejor reasoning) | Explícita (reviewer gates) | Iris: veloz. Nosotros: correcto |
| **Complejidad** | Baja (usa sus servicios) | Alta (tú construyes) | Iris: producto SaaS. Nosotros: IP propia |
| **Debugging** | Difícil (magia) | Fácil (audit trail completo) | Nosotros: todo trazable |
| **Escalabilidad** | Horizontal (su infra) | Vertical (tu infra) | Iris: escala sola. Nosotros: depende de ti |
| **Vendor lock-in** | Sí (servicio Redis) | No (open source stack) | Nosotros: soberanía total |

### 6.2 Posición Estratégica

**No competimos con Iris.** Nos complementamos:

- **Iris** es el "cerebro de contexto" (memoria, caching, retrieval)
- **cmd-center-v2** es el "sistema nervioso" (orquestación, validación, control)

**Analogía:**
> Iris es como tener un asistente que recuerda todo por ti.  
> cmd-center-v2 es como tener un manager de proyecto que decide qué información dar a cada trabajador.

### 6.3 Cuándo Usar Cada Uno

| Escenario | Recomendación |
|-----------|---------------|
| Startup, pocos devs, velocidad > control | Iris (o similar SaaS) |
| Enterprise, compliance, auditoría requerida | cmd-center-v2 |
| Agentes conversacionales (chatbots) | Iris |
| Agentes de software (código crítico) | cmd-center-v2 |
| Necesitas debugging completo | cmd-center-v2 |
| Quieres aprender/iterar rápido | Iris |
| Quieres IP propia y customización | cmd-center-v2 |

---

## 7. Ventajas Competitivas para la Empresa

### 7.1 Diferenciadores Técnicos

#### 1. **Context Ownership Total**
Decidimos EXACTAMENTE qué ve cada agente. No hay "contexto que se filtra" ni "el agente recordó algo que no debía".

#### 2. **Audit Trail Completo**
Cada decisión, cada mensaje, cada ejecución está en SQLite (`event_log`). Podemos reconstruir cualquier ejecución.

#### 3. **Validación Estructurada**
No es "parece correcto". Es "pasa tests, no contiene patrones prohibidos, archivo existe en path correcto".

#### 4. **Especialización por Rol**
Un `dev` no tiene herramientas de `reviewer`. Un `coordinator` no tiene permisos de escritura de código. Separation of concerns.

#### 5. **Resiliencia por Diseño**
Si un agente "se pierde", lo matamos y lanzamos otro. El estado está en SQLite, no en la cabeza del agente.

### 7.2 Diferenciadores de Negocio

#### 1. **IP Propia**
No dependemos de proveedores de context-engine. Nuestro sistema es nuestro.

#### 2. **Compliance-by-Design**
Podemos demostrar (auditablemente) qué información vio cada agente y por qué.

#### 3. **Costos Predecibles**
No hay "sorpresas de billing" por queries de contexto. SQLite es local y gratuito.

#### 4. **Customización Infinita**
Podemos agregar reglas de negocio, integraciones internas, validaciones custom.

### 7.3 Casos de Uso Actuales

| Caso | Descripción | Estado |
|------|-------------|--------|
| Code Review Automatizado | Reviewer gates en cada PR | Operativo |
| Refactoring Asistido | Decomposition de tareas grandes | Piloto |
| Generación de Tests | Test coverage gaps auto-detectados | Piloto |
| Documentación Técnica | Auto-gen de docs desde código | En diseño |
| Migraciones de Código | Cambios estructurados validados | Piloto |

---

## 8. Arquitectura en Código: Ejemplos Reales

### 8.1 Lanzar un Agente con Contexto Controlado

```typescript
// src/core/launcher.ts (simplificado)

async function launchAgent(spec: AgentSpec): Promise<void> {
  // 1. Cargar SKILL.md (contexto semántico del rol)
  const skill = await loadSkill(spec.role);
  
  // 2. Cargar análisis previos relevantes (memoria histórica)
  const context = await pm_read_analyses({
    task_id: spec.task_id,
    keywords: [spec.role, spec.task_type]
  });
  
  // 3. Componer system prompt CON EXACTAMENTE lo que necesita
  const systemPrompt = composeSystemPrompt({
    skill_description: skill.description,
    tools: skill.tools,
    model: skill.model,
    thinking: skill.thinking,
    relevant_context: context,  // <-- NO TODO, SOLO RELEVANTE
    mode: spec.mode
  });
  
  // 4. Lanzar en tmux con contexto inyectado
  await tmuxLaunch({
    session: spec.session,
    pane: spec.pane,
    command: `pi --skill ${spec.role} --system-prompt "${systemPrompt}" --mode ${spec.mode}`,
    env: {
      FABRIC_AGENT_ID: spec.id,
      FABRIC_ROLE: spec.role,
      FABRIC_REPORT_TO: spec.report_to
    }
  });
}
```

### 8.2 Estructura de Contrato

```typescript
// src/core/fabric.ts (simplificado)

interface TaskContract {
  // Qué debe hacer
  description: string;
  
  // Qué archivos puede ver (contexto limitado)
  files: string[];
  
  // Cómo se valida (criterios explícitos)
  acceptance_criteria: AcceptanceCriterion[];
  
  // A quién reporta cuando termine
  report_to: string;
  
  // Cuántos reintentos permite
  max_attempts: number;
}

interface AcceptanceCriterion {
  id: string;
  type: 'file_exists' | 'test_passes' | 'file_contains' | 
        'command_exit_0' | 'manual' | ...;
  required: boolean;
  description: string;
  params: Record<string, unknown>;
}
```

### 8.3 Persistencia de Conocimiento

```typescript
// src/pm/analyses.ts (simplificado)

// Después de cada ejecución, el agente escribe análisis
async function writeAnalysis(analysis: Analysis): Promise<void> {
  // Guardar en SQLite (source of truth)
  const row = await db.insert('task_analyses', {
    task_id: analysis.task_id,
    version: incrementVersion(analysis.task_id),
    analysis_type: analysis.type,  // 'debugging' | 'planning' | 'review' | ...
    keywords: JSON.stringify(analysis.keywords),
    agent_note: analysis.agent_note,  // Denso, para otros agentes
    human_note: analysis.human_note,  // Resumen, para humanos
    confidence: analysis.confidence,
    invalidated: false  // Análisis vigente
  });
  
  // Invalidar análisis previos del mismo tipo
  await db.update('task_analyses', 
    { invalidated: true },
    { task_id: analysis.task_id, analysis_type: analysis.type, id: { not: row.id } }
  );
}
```

---

## 9. Roadmap y Próximos Pasos

### 9.1 Corto Plazo (Q2 2026)

- [ ] Estabilizar reviewer gates (más tipos de criterios)
- [ ] Mejorar análisis automático de fallos (auto-debugging)
- [ ] Dashboard de métricas (tasa de éxito, tiempo por fase)
- [ ] Integración con CI/CD (GitHub Actions, etc.)

### 9.2 Mediano Plazo (Q3-Q4 2026)

- [ ] Evaluación de Redis Iris (si complementa, integrar)
- [ ] Auto-tuning de contexto (qué archivos son realmente relevantes)
- [ ] Aprendizaje de criterios (qué validaciones suelen fallar)
- [ ] Soporte multi-lenguaje (skills específicos por stack)

### 9.3 Largo Plazo (2027+)

- [ ] Migración completa a infraestructura propia (sin pi.dev dependencia)
- [ ] Knowledge graph de la empresa (relaciones entre componentes)
- [ ] Agentes proactivos (detectan oportunidades de refactoring)

---

## 10. Conclusión

Hemos construido un **Context Engine** empresarial con:

1. **Control total** de qué contexto recibe cada agente
2. **Validación estructurada** con reviewer gates
3. **Audit trail completo** en SQLite
4. **Agentes efímeros** (resiliencia por diseño)
5. **IP propia** y customizable

Esto nos posiciona como **arquitectos de agentes**, no como **usuarios de agentes**. 

Mientras otros usan Iris o herramientas similares como caja negra, nosotros **entendemos y controlamos** cada byte de contexto que fluye por el sistema.

---

## Apéndice A: Glosario

| Término | Definición |
|---------|------------|
| **Context Engine** | Sistema que almacena, distribuye y valida contexto para agentes LLM |
| **Skill** | Definición de un rol agente (tools, modelo, comportamiento) en SKILL.md |
| **Task Contract** | Especificación estructurada de trabajo + criterios de validación |
| **Reviewer Gate** | Fase de validación donde un segundo agente verifica el trabajo |
| **Mailbox** | Sistema de mensajería entre agentes via archivos JSONL + señales SIGUSR1 |
| **Context Ownership** | Principio de que cada agente solo recibe el contexto que necesita |
| **Ephemeral Agent** | Agente que no persiste estado; vive solo durante su ejecución |

## Apéndice B: Referencias

- Redis Iris Announcement: https://redis.io/iris/
- pi.dev Documentation: [internal]
- cmd-center-v2 Repository: `github.com/deazuth/multi-agents` (privado)
- Post Original (May 2026): [internal documentation]

---

**Document prepared for internal stakeholder presentation.**  
**Questions: jose@empresa.com**
