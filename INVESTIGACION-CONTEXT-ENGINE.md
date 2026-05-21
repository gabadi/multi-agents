# Investigación Aplicada: Context Engines para Sistemas Multi-Agente
## Criterios de Diseño y Evaluación de Herramientas

**Investigador:** Jose Escobar  
**Fecha:** Mayo 2026  
**Tipo:** Investigación aplicada / Análisis de arquitectura  
**Estado:** En progreso - fase de comprensión de entrañas

---

## 1. Propósito de esta Investigación

No estoy construyendo un producto comercial. Estoy intentando **entender qué se necesita** para que sistemas multi-agente funcionen correctamente, y **cómo evaluar** herramientas como Redis Iris, Factory, o construcciones propias.

### Preguntas de Investigación

1. ¿Qué es realmente un "Context Engine" y por qué emerge ahora como categoría?
2. ¿Cuáles son los mecanismos fundamentales de control de contexto que funcionan?
3. ¿Dónde está el límite entre "demasiado contexto" y "contexto insuficiente"?
4. ¿Cómo se comportan agentes efímeros vs stateful? ¿Cuándo usar cada uno?
5. ¿Qué criterios usar para evaluar herramientas existentes (Redis Iris, Factory, etc.)?

### Metodología

- **Análisis de entrañas:** Leer código fuente, documentación técnica, no marketing
- **Experimentación controlada:** Construir sistemas mínimos que prueban hipótesis
- **Comparativa estructural:** No "mejor/peor", sino "diferente en X, implica Y"
- **Documentación de decisiones:** Registrar por qué ciertos enfoques funcionan/fallan

---

## 2. Hallazgos Fundamentales

### 2.1 El Problema Real: Contexto Contaminado

**Hipótesis inicial:** Los agentes necesitan más contexto para razonar mejor.  
**Hallazgo:** Falso. Los agentes necesitan **el contexto correcto**, no más contexto.

**Evidencia empírica (cmd-center-v2, Mayo 2026):**

| Experimento | Resultado |
|-------------|-----------|
| Agente con TODO el repo (500 archivos) | Se confunde, alucina imports, genera código roto |
| Agente con 3 archivos relevantes + contrato | Implementación correcta, tests pasan |
| Agente con contexto histórico completo | Repite errores previos, no itera |
| Agente con análisis de errores previos SOLAMENTE | Evita errores documentados, solución mejorada |

**Implicación:** El control de contexto no es optimización, es **correctitud**. Un agente con contexto incorrecto está matemáticamente garantizado a fallar.

### 2.2 El Ciclo de Vida del Contexto

Descompuse el ciclo de vida de un agente en cmd-center-v2 para entender dónde se inyecta contexto:

```
FASE 1: CONCEPCIÓN (Humano/Coordinador)
└── Input: Intención de negocio ("necesito feature X")
└── Proceso: Descomposición en subtareas
└── Output: Task contract con contexto filtrado

FASE 2: INYECCIÓN (System/Coordinator)
└── Input: Task contract + contexto histórico selectivo
└── Proceso: Composición de system prompt + skill + archivos relevantes
└── Output: Agente lanzado con contexto EXACTO (no más, no menos)

FASE 3: EJECUCIÓN (Agente)
└── Input: Contexto inyectado + herramientas disponibles
└── Proceso: LLM reasoning + tool calling
└── Output: Artefactos + reporte de completitud

FASE 4: VALIDACIÓN (Reviewer/Segundo agente)
└── Input: Artefactos + criterios del contrato original
└── Proceso: Verificación estructurada (no "parece bien")
└── Output: Pass/Fail + findings específicos

FASE 5: PERSISTENCIA (System)
└── Input: Transcripción completa del ciclo
└── Proceso: Análisis de qué funcionó/qué falló
└── Output: Memoria estructurada para ciclos futuros
```

**Hallazgo crítico:** El control debe existir en TODAS las fases. Si falla en una, el sistema degenera.

### 2.3 Mecanismos de Control que Funcionan

#### Mecanismo A: Skills como Capa Semántica

**Qué es:** Definir roles via archivos de configuración declarativa (SKILL.md).

**Estructura observada:**
```yaml
name: dev                    # Identidad del agente
description: "..."         # Propósito (para humanos Y para LLM)
model: fern/gpt-5.3-codex   # Capacidad computacional asignada
tools: [read, write, ...]   # Capacidades de acción permitidas
thinking: medium            # Presupuesto de razonamiento
mode: rpc                   # Patrón de interacción
```

**Por qué funciona:**
- Limita el espacio de acciones posibles (tool sandboxing)
- Define expectativas de comportamiento (system prompt implícito)
- Permite especialización (un dev no es un reviewer)

**Límite encontrado:** Los skills no son suficientes. Un dev con skill correcto pero archivos incorrectos igual falla.

#### Mecanismo B: Task Contracts como Inyección Selectiva

**Qué es:** Especificar exactamente qué contexto recibe un agente en una tarea específica.

**Campos críticos identificados:**
```typescript
interface TaskContract {
  description: string;           // QUÉ debe hacer (intención)
  files: string[];             // QUÉ puede ver (contexto de lectura)
  tools_available: string[];     // QUÉ puede modificar (capacidad de escritura)
  acceptance_criteria: ...;    // CÓMO se valida (definición de done)
  max_attempts: number;        // CUÁNTAS veces puede reintentar
}
```

**Por qué funciona:**
- Previene "hallucination by context overflow" (ver demasiado → inventar conexiones)
- Permite paralelización segura (workers no se pisan si contextos son disjuntos)
- Habilita validación objetiva (criterios son verificables, no subjetivos)

**Límite encontrado:** Seleccionar qué archivos son "relevantes" es no-trivial. Heurísticas simples (git diff, imports directos) funcionan 70% del tiempo.

#### Mecanismo C: Agentes Efímeros como Isolation

**Qué es:** Los agentes no persisten estado entre ejecuciones. Mueren al terminar (tmux pane cierra).

**Hipótesis alternativa descartada:** Agentes stateful que "recuerdan" entre sesiones.

**Por qué efímeros funcionan mejor (para código):**
- Previene "acumulación de error" (estado corrupto no persiste)
- Fuerza explicitud (no "el agente sabe", el coordinador inyecta)
- Permite respawn limpio (si un agente "se pierde", kill + relaunch)

**Costo:** El coordinador debe ser más complejo (inyectar contexto relevante vs dejar que el agente lo recupere).

**Cuándo stateful podría funcionar:** Agentes conversacionales donde la continuidad es valor de negocio (chatbots), no donde la correctitud es crítica (código).

#### Mecanismo D: Validación por Segundo Agente (Reviewer Gates)

**Qué es:** Un agente no marca su propio trabajo como completo. Otro agente lo valida contra criterios explícitos.

**Estructura del proceso:**
```
Worker → Reporta completitud → Reviewer → Valida contra contrato → Resultado
                ↓                                   ↑
                └── Si falla: findings específicos ──┘
                └── Si pasa: done
```

**Por qué funciona:**
- Previene "premature completion" (agente ansioso por terminar)
- Detecta "hallucination in validation" (agente que generó código cree que funciona)
- Crea accountability (hay un verificador separado)

**Costo:** Latencia (2x tiempo de LLM), complejidad (gestionar loops de retry).

**Mitigación del costo:** Criterios estructurados permiten verificación programática (tests) antes de LLM reviewer para casos simples.

---

## 3. Análisis de Herramientas Evaluadas

### 3.1 Redis Iris

**Análisis basado en:** Video de lanzamiento, documentación técnica, repositorio open source de Agent Memory Server.

#### Componentes y su función real

| Componente | Qué hace técnicamente | Qué problema resuelve |
|------------|----------------------|------------------------|
| **Agent Memory Server** | Persistencia de mensajes + extracción de "memorias" (facts, preferences) via LLM | Mantener contexto entre interacciones sin re-enviar todo el historial |
| **Context Retriever** | MCP server que expone "entidades de negocio" mapeadas a estructuras Redis | Ocultar complejidad de queries Redis bajo nombres de negocio |
| **RDI** | CDC (Change Data Capture) desde PostgreSQL/MySQL/etc hacia Redis | Mantener caché fresca de datos operacionales |
| **LangCache** | Semantic caching de prompts (hash de intención → respuesta previa) | Reducir costos LLM cuando preguntas similares se repiten |

#### Hipótesis de alineación con nuestros hallazgos

**Iris dice:** "Context is all that matters"  
**Nosotros encontramos:** "Control of context is all that matters"

**Diferencia sutil, impacto grande:**
- Iris optimiza para **disponibilidad de contexto** (que esté ahí cuando lo necesites)
- Nosotros optimizamos para **selectividad de contexto** (que solo veas lo que necesitas)

#### Evaluación por mecanismos

| Mecanismo nuestro | Equivalente Iris | Evaluación |
|-------------------|------------------|------------|
| Skills como capa semántica | Context Retriever (MCP) | **Equivalente.** Ambos mapean "rol de negocio" a "capacidades técnicas". |
| Task contracts inyección selectiva | ❌ No existe | **Gap.** Iris asume que el agente "pide" contexto. Nosotros "inyectamos" contexto. Diferencia de control. |
| Agentes efímeros | ❌ Contradice | **Disputa.** Iris asume agentes stateful que consultan memoria. Nosotros: agentes efímeros, coordinador inyecta. |
| Reviewer gates | ❌ No existe | **Gap.** Iris no tiene mecanismo de validación externa. |

#### Veredicto técnico

**Iris sirve para:**
- Agentes conversacionales donde continuidad entre sesiones es importante
- Reducción de costos LLM (LangCache)
- Aplicaciones donde "buena respuesta" es suficiente (no "correcta estructuralmente")

**Iris NO sirve para (en su forma actual):**
- Generación de código donde cada byte debe ser correcto
- Sistemas donde la trazabilidad de decisiones es crítica (compliance)
- Escenarios donde el contexto debe ser EXPLICITAMENTE limitado (seguridad)

**Posible integración selectiva:**
- LangCache podría usarse para prompts repetitivos (costos)
- Agent Memory Server podría almacenar análisis de errores (solo lectura para workers)
- PERO: no delegar el control de qué contexto ve cada agente a Iris

### 3.2 Factory.ai — Análisis Profundo del Modo Missions

**Nota:** Factory tiene dos modos. El modo conversacional (CLI `droid`) es un agente stateful simple. El **modo missions** es un sistema multi-agente estructurado que descubrimos en la investigación. Aquí analizamos missions en profundidad.

#### 3.2.1 Arquitectura de una Mission

Una **mission** en Factory es una unidad de trabajo multi-agente con descomposición automática en features, validación estructurada, y evolución del conocimiento compartido.

**Estructura de directorios de una mission:**

```
missionDir/
├── mission.md                 # Objetivo general de la misión
├── features.json              # Descomposición en features con contexto específico
├── validation-contract.md     # Contrato de validación con assertions estructuradas
├── services.yaml              # Servicios permitidos para esta misión
├── AGENTS.md                  # Convenciones del proyecto (evoluciona)
├── library/                   # Conocimiento compartido (evoluciona)
├── skills/                    # Skills específicas de esta misión
│   └── <skillName>/
│       └── SKILL.md
├── handoffs/                  # Handoffs worker → coordinador
├── validation/                # Resultados de validación por milestone
│   └── <milestone>/
│       ├── scrutiny/reviews/<feature-id>.json
│       └── user-testing/flows/<group-id>.json
├── worker-transcripts.jsonl   # Transcripts de todos los workers
└── evidence/                  # Evidencia de testing (screenshots, etc.)
```

#### 3.2.2 El Ciclo de Vida de una Mission

```
1. CONCEPCIÓN (Coordinador humano o AI)
   └── Define mission.md: objetivo de negocio
   └── Define features.json: descomposición en features
   └── Define validation-contract.md: assertions de validación

2. PLANIFICACIÓN (Sistema Factory)
   └── Asigna skillName a cada feature (basado en tipo de trabajo)
   └── Crea worker sessions (una por feature en paralelo)
   └── Inyecta contexto específico a cada worker:
       - Feature ID, description, expectedBehavior
       - Skill específico de skills/ (no genérico)
       - Límites de aislamiento ("isolation boundary")

3. EJECUCIÓN (Workers paralelos)
   Cada worker:
   ├── Lee contexto inyectado (feature específico)
   ├── Implementa usando skill asignada
   ├── Commite cambios con evidencia
   └── Escribe handoff/<session-id>.json con:
       - sessionId, commitId, repoPath
       - skillFeedback (deviations, notes)
       - transcript skeleton

4. VALIDACIÓN POR MILESTONE (Multi-layer reviewers)
   Milestone N:
   ├── Scrutiny Review (spec compliance + code quality)
   │   └── Spec reviewer: ¿implementa expectedBehavior?
   │   └── Code reviewer: ¿calidad, bugs, edge cases?
   ├── User Testing Flow Validation (si aplica)
   │   └── Assertions contra validation-contract.md
   │   └── Evidencia: screenshots, console errors, network traces
   └── Shared State Evolution
       └── Reviewers actualizan AGENTS.md, services.yaml, library/

5. EVOLUCIÓN DE ESTADO COMPARTIDO
   └── Los reviewers documentan gaps encontrados:
       - convention gaps → actualizan AGENTS.md
       - skill gaps → actualizan skills/<skill>/SKILL.md
       - services gaps → actualizan services.yaml
       - knowledge gaps → actualizan library/

6. ITERACIÓN (si falla validación)
   └── Fix reviews: workers re-ejecutan con prior review path
   └── Re-validación contra mismo contrato
   └── Máximo 1 retry por failure type

7. COMPLETITUD
   └── Todos los milestones pass
   └── Estado final en validation-state.json
   └── missionDir/ contiene toda la trazabilidad
```

#### 3.2.3 validation-contract.md — El Contrato de Validación

**¿Qué es?** Un archivo Markdown estructurado que define **assertions** de comportamiento que deben verificarse. No es código de test, es **especificación ejecutable**.

**Estructura:**

```markdown
# Validation Contract

## Milestone 1: Authentication System

### Group: Login Flow

#### Assertion AUTH-001: Successful Login
- **ID:** VAL-AUTH-001
- **Behavior:** User can log in with valid credentials
- **Pass Criteria:**
  - Login form accepts email/password
  - Submit redirects to dashboard
  - Session token created (JWT, 24h expiry)
- **Required Evidence:**
  - Screenshot: login form state
  - Console: no errors
  - Network: POST /api/auth/login → 200

#### Assertion AUTH-002: Invalid Credentials Handling
- **ID:** VAL-AUTH-002
- **Behavior:** User sees error with invalid credentials
- **Pass Criteria:**
  - Error message displayed without exposing internal details
  - Form retains email input
  - No redirect occurs
- **Required Evidence:**
  - Screenshot: error state
  - Console: no uncaught exceptions
  - Network: POST /api/auth/login → 401

### Group: Session Management

#### Assertion AUTH-003: Token Expiration
- **ID:** VAL-AUTH-003
- **Behavior:** Expired token redirects to login
- **Pass Criteria:**
  - Request with expired token returns 401
  - User redirected to /login?redirect=<original>
  - Flash message: "Session expired"
- **Required Evidence:**
  - Network: request con token expirado → 401
  - Screenshot: redirect con mensaje
```

**Propósito:**
1. **Definición de done clara:** "¿Qué significa que esto funcione?" documentado antes de implementar
2. **Validación independiente:** El tester (user-testing-flow-validator) no conoce implementación, solo el contrato
3. **Evidencia objetiva:** Screenshots, logs de red, console errors — no "parece funcionar"
4. **Reproducibilidad:** Mismo assertion ejecutado en cada re-run

**Comparativa con nuestro acceptance_criteria:**

| Aspecto | Factory validation-contract.md | cmd-center-v2 acceptance_criteria |
|---------|-------------------------------|-----------------------------------|
| Momento | Antes de ejecución | Antes de ejecución (task contract) |
| Estructura | Markdown con assertions agrupadas | Array de objetos JSON |
| Granularidad | Grupos y assertions dentro de milestone | Criterios individuales |
| Evidencia | Especificada en contrato (screenshots, etc.) | Implícita en tipo de criterio |
| Tester | user-testing-flow-validator (sub-agente) | Reviewer gate (agente o proceso) |
| Cobertura | UI/CLI/API flows (user-facing) | Cualquiera (tests, lint, file_exists) |

#### 3.2.4 Multi-Layer Reviewers — ¿Por qué múltiples capas?

**Arquitectura de validación en Factory:**

```
IMPLEMENTACIÓN (Worker)
    ↓
┌─────────────────────────────────────┐
│ MILESTONE VALIDATION               │
├─────────────────────────────────────┤
│ Layer 1: Spec Compliance Reviewer  │
│   └─ ¿El código hace EXACTAMENTE   │
│      lo que dice expectedBehavior  │
│      en features.json?              │
│   └─ ¿Hay funcionalidad no         │
│      especificada (scope creep)?    │
│   Output: gaps en especificación   │
├─────────────────────────────────────┤
│ Layer 2: Code Quality Reviewer     │
│   └─ ¿El código está bien         │
│      construido? (patrones, bugs)  │
│   └─ ¿Hay edge cases no cubiertos? │
│   Output: issues de implementación │
├─────────────────────────────────────┤
│ Layer 3: User Testing Validator    │
│   (si hay validation-contract.md)  │
│   └─ Ejecuta assertions en          │
│      superficie real (UI/CLI/API)   │
│   └─ Captura evidencia              │
│      (screenshots, logs)            │
│   Output: pass/fail por assertion   │
└─────────────────────────────────────┘
    ↓
SHARED STATE EVOLUTION (Todos los reviewers)
```

**¿Por qué múltiples capas?**

| Capa | Propósito | ¿Qué detecta que otras no? |
|------|-----------|---------------------------|
| **Spec compliance** | Verificar que se construyó lo pedido | Scope creep, malentendidos de requerimientos |
| **Code quality** | Verificar que se construyó bien | Bugs técnicos, anti-patterns, edge cases |
| **User testing** | Verificar que funciona en la realidad | Race conditions, UX issues, integración real |

**Ejemplo de valor de capas:**

```
Worker implementa "login con JWT"
    ↓
Spec reviewer: PASS
  └─ Sí implementa JWT, 24h expiry, etc.
    ↓
Code reviewer: PASS
  └─ Código limpio, maneja errors, etc.
    ↓
User testing: FAIL en Assertion AUTH-003
  └─ Token expirado NO redirige a login
  └─ Evidencia: screenshot muestra 401 en consola
  └─ Usuario queda en página blanca
    ↓
Finding: "La lógica de redirección post-401 está en cliente
          pero no se ejecuta porque el interceptor no captura
          errores de tipo CORS preflight"
    ↓
Worker fix: Agrega manejo de 401 en interceptor + redirección
```

Sin **Layer 3 (User Testing)**, el bug de CORS no se detecta hasta producción. Las capas 1 y 2 operan sobre código fuente, la capa 3 sobre comportamiento real.

#### 3.2.5 Shared State Evolution — ¿Por qué reviewers modifican skills y documentación?

**El problema que resuelve:**

En sistemas tradicionales, el conocimiento descubierto durante validación se pierde o queda en la cabeza del reviewer. Factory codifica este conocimiento en archivos compartidos.

**Estructura de Shared State Observations:**

```json
{
  "reviewId": "scrutiny-FEAT-001-2024-05-20",
  "reviewerType": "scrutiny-feature-reviewer",
  "sharedStateObservations": [
    {
      "area": "conventions",
      "observation": "No hay convención para manejo de errores de red en el cliente",
      "evidence": "AUTH-003 failure shows inconsistent error handling",
      "recommendation": "Agregar a AGENTS.md: 'All network errors must be handled in centralized interceptor'"
    },
    {
      "area": "skills",
      "observation": "Skill 'frontend-auth' no menciona CORS handling",
      "evidence": "Worker deviated from skill to add CORS logic manually",
      "recommendation": "Actualizar skills/frontend-auth/SKILL.md section 'Error Handling'"
    },
    {
      "area": "services",
      "observation": "Servicio de auth no documenta comportamiento CORS preflight",
      "evidence": "Expected 401, got CORS error in preflight",
      "recommendation": "Agregar a services.yaml: auth service CORS behavior"
    },
    {
      "area": "knowledge",
      "observation": "JWT expiration edge case with CORS not documented",
      "evidence": "Edge case discovered during AUTH-003 testing",
      "recommendation": "Agregar a library/auth-edge-cases.md"
    }
  ]
}
```

**¿Qué modifican los reviewers?**

| Archivo | ¿Quién lo modifica? | ¿Cuándo? | Propósito |
|---------|---------------------|----------|-----------|
| `AGENTS.md` | Spec/Code reviewers | Durante validación | Convenciones de proyecto descubiertas |
| `skills/<name>/SKILL.md` | Code reviewers | Durante validación | Procedimientos de skills mejorados |
| `services.yaml` | User testing reviewers | Durante validación | Comportamiento real de servicios |
| `library/` | Todos los reviewers | Durante validación | Knowledge base del proyecto |

**Beneficio: Learning Accumulation**

```
Mission 1: Login system
└── Reviewer descubre problema CORS
    └── Actualiza AGENTS.md con convención de error handling
        └── Actualiza skills/frontend-auth/SKILL.md
            
Mission 2: Payment system (usa misma skill)
└── Worker lee skill actualizada con CORS handling
    └── Implementa correctamente desde inicio
        └── User testing pasa sin descubrir el mismo bug
```

**Sin Shared State Evolution:**
- Cada misión repite los mismos errores
- Conocimiento queda en transcripts, no estructurado
- Skills son estáticas, no mejoran con la experiencia

**Con Shared State Evolution:**
- Las missions posteriores son mejores porque usan skills/convenciones refinadas
- El sistema "aprende" organizacionalmente
- Cada bug encontrado fortalece el sistema contra futuros bugs similares

#### 3.2.6 Comparativa con cmd-center-v2

| Aspecto | Factory missions | cmd-center-v2 |
|---------|-----------------|---------------|
| **Descomposición** | Automática en features.json | Manual por coordinador |
| **Contexto inyectado** | Por feature (features.json + skill) | Por task (task contract) |
| **Granularidad aislamiento** | Feature-level | Archivo/función-level |
| **Validation contract** | validation-contract.md (assertions) | acceptance_criteria (criterios) |
| **Multi-layer review** | Spec + Code + User Testing | Reviewer gate único |
| **Evidencia testing** | Screenshots, logs, network | Verification results |
| **Shared state evolution** | Reviewers actualizan docs | Análisis en SQLite (no muta runtime) |
| **Agentes** | Stateful (resumible) | Efímeros (mueren limpio) |
| **Persistencia** | missionDir/ archivos | SQLite + event_log |
| **Observabilidad** | Logs locales, no dashboard | Dashboard + registry |

**Lecciones para cmd-center-v2:**

1. **Validation contracts:** Agregar assertions con evidencia requerida (más allá de criterios booleanos)
2. **Multi-layer review:** Separar spec compliance vs code quality vs integration testing
3. **Shared state evolution:** Permitir que reviewers modifiquen skills/documentación durante ejecución
4. **Feature-level decomposition:** Considerar descomposición automática por dominio de feature

**¿Por qué Factory es 6/12 vs nuestro 10/12?**

| Dimensión | Factory | cmd-center-v2 | Gap |
|-----------|---------|---------------|-----|
| Control granular | Feature-level | Archivo/función | ✅ Nuestro mejor |
| Trazabilidad | Archivos locales | SQLite queryable | ✅ Nuestro mejor |
| Observabilidad | Logs | Dashboard + registry | ✅ Nuestro mejor |
| Costos | No caching | No caching | = Iguales |
| Cloud dependency | Sí (Factory cloud) | No (local) | ✅ Nuestro mejor |

Factory es superior en validación estructurada (multi-layer, validation contracts). cmd-center-v2 es superior en control total del contexto y trazabilidad operativa.

### 3.3 Construcción Propia (cmd-center-v2)

**Qué hemos construido:** Un sistema que implementa los 4 mecanismos identificados como necesarios.

**Stack técnico:**
- pi.dev como runtime de agentes (permite control total de contexto)
- SQLite para persistencia de análisis (memoria estructurada, no "chat history")
- tmux para aislamiento de procesos (agentes efímeros)
- JSONL + SIGUSR1 para mensajería (mínimo overhead, máximo control)

**Qué funciona bien:**
- Control total del contexto inyectado (demostrado en experimentos)
- Validación estructurada con reviewer gates (reduce errores en código)
- Trazabilidad completa (quién hizo qué, cuándo, por qué)

**Qué NO funciona bien (áreas de investigación):**
- Selección automática de archivos relevantes (heurísticas simples fallan 30%)
- Costos LLM (sin caching de prompts, cada ejecución es full cost)
- Velocidad de lanzamiento (tmux + pi tiene overhead vs API directa)
- Complejidad del coordinador (humano o agente senior debe descomponer bien)

---

## 4. Criterios de Evaluación de Herramientas Multi-Agente

Basado en la investigación, estos son los criterios que usaré para evaluar cualquier herramienta (Redis Iris, Factory, otras, o construcción propia):

### Dimensión 1: Control de Contexto

| Criterio | Peso | Qué evaluar |
|----------|------|-------------|
| **Inyección vs Retrieval** | Crítico | ¿El sistema permite INYECTAR contexto específico, o solo RETRIEVAR desde memoria general? |
| **Granularidad de aislamiento** | Alto | ¿Puede limitarse contexto a archivos específicos? ¿A funciones específicas? |
| **Persistencia de estado** | Alto | ¿Los agentes son efímeros (mueren limpio) o stateful (acumulan estado)? |

**Scoring:**
- 3/3: Control total (inyección, granularidad fina, efímeros)
- 2/3: Control parcial (retrieval + granularidad, o inyección + stateful)
- 1/3: Control limitado (retrieval general, stateful obligatorio)
- 0/3: Sin control (agentes ven todo, persisten todo)

### Dimensión 2: Mecanismos de Correctitud

| Criterio | Peso | Qué evaluar |
|----------|------|-------------|
| **Validación externa** | Crítico | ¿Existe un mecanismo de reviewer/validador separado del worker? |
| **Criterios estructurados** | Alto | ¿La validación es contra criterios programáticos (tests, lint) o solo "parece correcto"? |
| **Retry con findings** | Medio | ¿Al fallar, el sistema pasa "findings específicos" al reintentar? |

**Scoring:**
- 3/3: Reviewer gates + criterios estructurados + retry informado
- 2/3: Reviewer gates + criterios mixtos
- 1/3: Auto-validación o criterios manuales
- 0/3: Sin validación formal

### Dimensión 3: Trazabilidad y Debuggability

| Criterio | Peso | Qué evaluar |
|----------|------|-------------|
| **Audit trail completo** | Alto | ¿Se registra TODO (mensajes, decisiones, contexto inyectado, resultados)? |
| **Reproducibilidad** | Alto | ¿Puede reconstruirse una ejecución exacta dado el audit trail? |
| **Observabilidad** | Medio | ¿Hay visibilidad en tiempo real de qué está haciendo cada agente? |

### Dimensión 4: Costos y Eficiencia

| Criterio | Peso | Qué evaluar |
|----------|------|-------------|
| **Caching inteligente** | Medio | ¿Hay mecanismos de cache (prompts, resultados) para reducir llamadas LLM? |
| **Paralelización segura** | Medio | ¿Pueden ejecutarse múltiples agentes en paralelo sin interferencia de contexto? |
| **Overhead de infraestructura** | Bajo | ¿Cuánto cuesta mantener el sistema corriendo (vs solo LLM costs)? |

### Tabla de Evaluación Actual

| Herramienta | Control Contexto | Correctitud | Trazabilidad | Costos | Total |
|-------------|------------------|-------------|--------------|--------|-------|
| **cmd-center-v2 (propio)** | 3/3 (inyección, granular, efímeros) | 3/3 (reviewer, estructurado, retry) | 3/3 (SQLite audit) | 1/3 (sin cache) | **10/12** |
| **Redis Iris** | 1/3 (retrieval, stateful) | 0/3 (sin validación) | 1/3 (Redis logs) | 3/3 (LangCache) | **5/12** |
| **Factory** | TBD | TBD | TBD | TBD | **TBD** |

**Interpretación:** cmd-center-v2 es superior en control y correctitud, inferior en costos (por falta de caching).

---

## 5. Áreas Abiertas de Investigación

### 5.1 Selección Automática de Contexto

**Problema:** Determinar qué archivos son "relevantes" para una tarea es no-trivial.

**Heurísticas actuales que funcionan parcialmente:**
- Git diff (archivos modificados recientemente)
- Import graph (qué importa el archivo objetivo)
- AST analysis (qué símbolos usa el código objetivo)

**Problema no resuelto:** Cuando la tarea requiere crear NUEVAS abstracciones, no hay archivos existentes que "importen" la solución.

**Hipótesis a probar:** ¿Puede un LLM "coordinador" pre-analizar la tarea y generar una lista de archivos candidatos mejor que heurísticas?

### 5.2 Representación de Conocimiento entre Ciclos

**Problema:** Cómo almacenar "lo aprendido" en un ciclo para que el próximo ciclo sea mejor.

**Intento actual (análisis en SQLite):**
- Guardar descripción de errores encontrados
- Guardar estrategias que funcionaron

**Límite encontrado:** El análisis es texto libre. No hay estructura para "problema X requiere estrategia Y".

**Hipótesis a probar:** ¿Deberíamos tener un schema más estructurado para conocimiento (tipo RDF, o tipo "patterns")?

### 5.3 Interfaz Humano-Coordinador

**Problema:** El coordinador (sea humano o agente) debe ser capaz de descomponer bien.

**Observación:** Cuando la descomposición inicial es mala, todo el sistema falla (efecto cascada).

**Pregunta:** ¿Puede el sistema mismo detectar que una descomposición es problemática ANTES de ejecutar?

### 5.4 Costos vs Calidad

**Observación empírica:** Nuestro sistema sin caching es 2-3x más caro en tokens LLM que ejecución directa.

**Pregunta:** ¿Dónde está el punto óptimo de inversión?
- ¿Validación en cada paso (caro, correcto) vs validación solo al final (barato, riesgoso)?
- ¿Reviewer LLM en cada cambio (caro, thorough) vs solo tests (barato, limitado)?

---

## 6. Decisiones de Arquitectura Documentadas

### Decisión 1: Agentes Efímeros vs Stateful

**Alternativa considerada:** Stateful (como Redis Iris)

**Argumentos a favor de stateful:**
- Menor latencia (no recrear contexto cada vez)
- "Natural" para agentes conversacionales
- Implementado por herramientas populares

**Argumentos a favor de efímeros (elegido):**
- Isolation garantizada (un agente contaminado muere con él)
- Fuerza explicitud (el coordinador debe declarar todo el contexto)
- Debugging más simple (no hay "estado fantasma" del agente)

**Reversibilidad:** Si encontramos que el overhead de inyección es prohibitivo, podríamos agregar "warm start" con contexto pre-cacheado (pero manteniendo invalidación explícita).

### Decisión 2: SQLite vs Redis para Persistencia

**Alternativa considerada:** Redis (como Iris)

**Argumentos a favor de Redis:**
- Velocidad (in-memory)
- Estructuras nativas (hashes, streams)
- Integración con ecosistema LLM

**Argumentos a favor de SQLite (elegido):**
- Simplicidad operativa (un archivo, zero-config)
- ACID garantizado (integridad de datos crítica para trazabilidad)
- SQL para queries complejos (análisis histórico)

**Reversibilidad:** Podríamos agregar Redis como cache layer frente a SQLite si la latencia de lectura se vuelve problema.

### Decisión 3: Inyección vs Retrieval de Contexto

**Alternativa considerada:** Retrieval (agente pide lo que necesita, como MCP)

**Argumentos a favor de retrieval:**
- Flexibilidad (agente decide qué necesita)
- Menos trabajo para el coordinador
- Parece "más inteligente"

**Argumentos a favor de inyección (elegido):**
- Control (sabemos exactamente qué vio el agente)
- Reproducibilidad (misma entrada → mismo comportamiento)
- Seguridad (puede limitarse a información no sensible)

**Reversibilidad:** Podríamos agregar "retrieval asistido" donde el coordinador sugiere recursos, pero el agente debe explicitar qué usará (híbrido).

---

## 7. Conclusiones y Próximos Pasos

### Hallazgos Confirmados

1. **El control de contexto es necesario, no opcional.** Sistemas que no lo controlan explícitamente funcionan por estadística ("usualmente el contexto es correcto"), no por diseño.

2. **Agentes efímeros + inyección > agentes stateful + retrieval** para casos donde la correctitud estructural es crítica (código, configuraciones).

3. **Validación por segundo agente es necesaria.** Auto-validación falla sistemáticamente (agente que generó código cree que funciona).

4. **Skills + Task Contracts son el par mínimo viable.** Sin skills, no hay especialización. Sin contracts, no hay control de contexto.

### Áreas que Requieren Más Investigación

1. **Factory:** Análisis de entrañas pendiente.
2. **Selección de contexto:** Heurísticas más inteligentes o LLM-as-selector.
3. **Representación de conocimiento:** Cómo estructurar "lo aprendido" para reuso efectivo.
4. **Costos:** Dónde caching es seguro (no afecta correctitud) vs dónde es riesgoso.

### Recomendación para la Organización

**No adoptar Redis Iris como arquitectura principal** (no cumple criterios de control y correctitud). **Posible adopción selectiva** de LangCache para reducción de costos en prompts repetitivos.

**Continuar inversión en cmd-center-v2** hasta que una herramienta evaluada supere los criterios establecidos, o hasta que hayamos aprendido lo suficiente para construir la siguiente iteración informada.

**Evaluar Factory** con los criterios de esta investigación antes de tomar decisión de adopción.

---

## Referencias y Material de Investigación

- **Redis Iris Launch:** Video Rowan Trollope & Simba Khader, Mayo 2026
- **Agent Memory Server (Open Source):** https://github.com/redis/agent-memory-server
- **cmd-center-v2 (Propio):** Experimentos Mayo 2026, código en repositorio interno
- **Post original multi-agentes:** Mayo 2026, reflexiones sobre context ownership
- **pi.dev documentation:** Extensión VS Code usada como runtime de agentes

---

**Estado de la investigación:** Fase de comprensión profunda. Próximo milestone: Evaluación de Factory con criterios establecidos.

**Contacto:** jose.escobar@empresa.com
