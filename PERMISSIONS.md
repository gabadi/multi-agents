# Análisis de permisos en cmd-center-v2

Fecha: 2026-05-19
Branch objetivo: `explore/permisos`

## Resumen ejecutivo

`cmd-center-v2` hoy opera principalmente con un modelo de confianza local y de disciplina por rol, no con un sistema fuerte de autorización técnica por capacidad. Sí existen algunos mecanismos concretos de control (Telegram con `allowedUserId`, enrutamiento sólo a roles coordinadores, bind local del monitor, protección de auto-cleanup para coordinadores), pero varios límites importantes siguen siendo sociales o documentales.

Conclusión corta: el repositorio tiene controles útiles para operación local, pero todavía no implementa un modelo de permisos consistente de tipo RBAC/capabilities. El gap principal es que las restricciones declaradas en skills no equivalen a enforcement real.

## Mecanismos actuales de permisos y control de acceso

### 1. Restricciones declarativas por rol en `skills/*/SKILL.md`

La intención de permisos por rol existe y está documentada en los skills.

Evidencia:
- `skills/git/SKILL.md:3` declara: `Only this role should perform push and PR operations.`
- `src/core/skill-loader.ts` construye el prompt con `Tools: ...` para cada rol.

Qué aporta:
- Define expectativas operativas.
- Limita comportamiento a nivel de instrucción/prompt.

Límite actual:
- No es enforcement técnico por sí solo.

### 2. Gate opcional de usuario autorizado para Telegram

El bridge de Telegram soporta una allowlist simple por `allowedUserId`.

Evidencia:
- `src/core/telegram-bridge.ts:188-189`
- `src/core/monitor.ts:3392-3394`

Qué aporta:
- Si `allowedUserId` está configurado, mensajes de otros usuarios son rechazados con `Not authorized`.

Límite actual:
- Es opcional; si no se configura, el bot no falla en modo cerrado.

### 3. Enrutamiento Telegram sólo hacia coordinadores autorizados

El sistema limita los destinos válidos para routing de Telegram a `secretary`, `coordinator`, y `sub-coordinator`.

Evidencia:
- `src/core/telegram-bridge.ts:402-409`
- `src/core/telegram-bridge.ts:421-422`
- `src/core/monitor.ts:2341-2348`

Qué aporta:
- Evita enrutar directamente mensajes humanos a workers arbitrarios.
- Mantiene una frontera básica entre entrada humana y ejecución operativa.

### 4. Protección de auto-cleanup para coordinadores

El cleanup automático protege ciertos roles para no destruir coordinadores por accidente.

Evidencia:
- `src/core/rpc-worker-cleanup.ts:5`
- `src/core/rpc-worker-cleanup.ts:74-91`

Qué aporta:
- `coordinator` y `sub-coordinator` están excluidos del auto-cleanup automático.

Límite actual:
- Es una protección operacional, no un sistema general de permisos.

### 5. El monitor escucha sólo en localhost

El monitor HTTP/SSE está atado a `127.0.0.1`.

Evidencia:
- `src/core/monitor.ts:61-62`
- `src/core/monitor.ts:3620-3624`

Qué aporta:
- Reduce exposición remota por red.
- Es una mitigación útil para un control plane local-first.

Límite actual:
- No evita abuso desde procesos locales ni desde páginas web locales/navegador si CORS queda abierto.

### 6. Existe opción para desactivar auto-descubrimiento de skills del workspace

El launcher soporta `--no-workspace-skills` y selección explícita de skills.

Evidencia:
- `src/core/launcher.ts:421-445`
- `src/core/launcher.ts:268-272`

Qué aporta:
- Permite reducir superficie cuando el coordinador decide un conjunto mínimo de skills.

Límite actual:
- El comportamiento por defecto todavía puede ampliar la frontera de confianza al workspace.

## Trust boundaries actuales

1. Local machine boundary: el diseño asume confianza razonable en la máquina local.
2. Role boundary: existe fuerte a nivel documental/prompt, pero débil a nivel técnico.
3. Telegram boundary: parcialmente protegido si `allowedUserId` está configurado.
4. Monitor HTTP boundary: local-only, pero con endpoints de lectura y escritura sin autenticación propia.
5. Workspace boundary: skills locales del repo/workspace pueden entrar al contexto del agente.

## Gaps, problems e issues identificados

### issue identified: las restricciones de herramientas por rol son principalmente documentales

Evidencia:
- `src/core/launcher.ts:388-392` dice explícitamente que no se pasa `--tools` y que las restricciones por rol quedan documentadas en el prompt.
- `src/core/extension.ts:1664-1674` activa automáticamente todas las herramientas `fabric_*` y `pm_*` al iniciar sesión.

Impacto:
- Se rompe el principio de mínimo privilegio.
- Un rol con tools declaradas como `read,write,edit,bash` puede terminar con acceso real a acciones de malla/PM adicionales.
- La separación entre roles como `git`, `dev`, `reviewer` y `sub-coordinator` queda apoyada en obediencia del modelo, no en policy enforcement.

Recommendation:
- Introducir una matriz de capacidades por rol (`allowed_tools`, `sensitive_tools`, `requires_role`).
- Hacer enforcement en runtime antes de activar herramientas, no sólo en el prompt.
- Separar herramientas observacionales de herramientas mutativas.

### issue identified: el monitor HTTP expone endpoints mutativos sin autenticación propia

Evidencia:
- `src/core/monitor.ts:3185-3257` enruta endpoints de lectura y escritura.
- `src/core/monitor.ts:1800-1836` acepta `POST /api/agents/:id/message` para encolar mensajes.
- `src/core/monitor.ts:2191-2235` expone kill y cleanup de agentes.
- `src/core/monitor.ts:1091-1112` y múltiples respuestas usan `Access-Control-Allow-Origin: *`.

Impacto:
- Cualquier proceso local puede leer estado y accionar operaciones de control.
- Una página abierta en el navegador podría alcanzar endpoints locales si el navegador permite la conexión y el usuario la visita.
- Endpoints como message/kill/cleanup/telegram-outbound son sensibles para operación.

Mitigación actual:
- `src/core/monitor.ts:62` fija `HOST = "127.0.0.1"`.

Recommendation:
- Agregar autenticación para API mutativa (token local, socket Unix, mTLS local, o shared secret por header).
- Separar puertos o namespaces para lectura y escritura.
- Eliminar `Access-Control-Allow-Origin: *` en endpoints mutativos.
- Añadir allowlist de orígenes para dashboard.

### gap identified: el control de acceso de Telegram es fail-open si `allowedUserId` no está presente

Evidencia:
- `src/core/telegram-bridge.ts:188-189` sólo carga `allowedUserId` si existe.
- `src/core/monitor.ts:3392-3394` rechaza usuarios no autorizados sólo cuando esa opción está configurada.

Impacto:
- Un bot habilitado sin `allowedUserId` puede aceptar input de cualquier usuario/chats alcanzables por el bot.
- Esto permite inyección de trabajo u operaciones no deseadas desde Telegram.

Recommendation:
- Cambiar a fail-closed cuando Telegram está habilitado y no existe allowlist.
- Soportar allowlist de múltiples `user_id` y/o `chat_id`.
- Registrar explícitamente en startup si Telegram corre en modo abierto y marcarlo como warning severo.

### gap identified: la propiedad de Git/PR está documentada pero no endurecida técnicamente

Evidencia:
- `skills/git/SKILL.md:3` declara que sólo ese rol debería hacer push/PR.
- No hay evidencia equivalente de enforcement técnico de esa restricción en launcher/extension.

Impacto:
- La política puede incumplirse por accidente o por instrucciones conflictivas.
- La auditoría por rol pierde valor si cualquier agente con shell puede ejecutar git/gh.

Recommendation:
- Mover acciones sensibles de GitOps a herramientas privilegiadas con validación de rol.
- O bien introducir un policy layer central para `push`, `pr create`, `cleanup`, `launch`, `task mutation`.

### problem identified: el auto-descubrimiento de skills del workspace amplía la frontera de confianza

Evidencia:
- `src/core/launcher.ts:268-272` busca skills en `.pi/skills`, `skills`, `.agents/skills`, `.claude/skills`.
- `src/core/launcher.ts:440-445` permite auto-discovery al entrar al workspace.

Impacto:
- Un repo externo o worktree con skills locales puede inyectar instrucciones operativas adicionales en agentes.
- Esto no es necesariamente una vulnerabilidad en el escenario local controlado, pero sí un riesgo de trust-boundary cuando el workspace no es totalmente confiable.

Recommendation:
- Para workspaces externos, default a `--no-workspace-skills`.
- Requerir opt-in explícito para cargar skills del workspace.
- Mostrar en logs/UI exactamente qué skills externos fueron cargados.

### gap identified: los mensajes de mailbox son JSONL sin firma ni ACL fuerte por remitente

Evidencia:
- `src/core/extension.ts:1059-1069` escribe mensajes directos al mailbox del agente destino y despierta el PID con `SIGUSR1`.
- `src/core/extension.ts:1122-1133` parsea líneas JSON y las entrega a `handleMessage` sin validación criptográfica del remitente.
- `AGENTS.md` documenta un runtime por defecto en `/tmp/fabric-agents`, lo que deja claro que la malla usa artefactos locales compartidos.

Impacto:
- Un proceso local con acceso al runtime puede suplantar mensajes entre agentes.
- La confianza en `from`, `type` y payload depende del sistema de archivos local, no de autenticidad verificable.

Recommendation:
- Firmar/envelopar mensajes sensibles con HMAC por sesión/agente.
- Endurecer permisos del runtime (`0700` directorios, `0600` mailboxes/state).
- Validar remitente y freshness (`nonce`, timestamp) antes de ejecutar acciones sensibles.

## Evaluación general

Estado actual: controles parciales, útiles para operación local, insuficientes para afirmar aislamiento fuerte entre roles.

Fortalezas:
- Telegram ya tiene un mecanismo de allowlist.
- El routing humano está restringido a coordinadores.
- El monitor no expone por defecto a red remota.
- Hay opciones para reducir skills del workspace.

Debilidades principales:
- Falta enforcement técnico de capacidades por rol.
- Falta autenticación en el plano HTTP local.
- Varias políticas sensibles viven sólo en prompts o convenciones.

## Propuestas priorizadas

### Prioridad alta

1. Implementar capabilities reales por rol en runtime.
2. Proteger endpoints mutativos del monitor con autenticación local.
3. Hacer obligatorio `allowedUserId` o equivalente cuando Telegram está activo.

### Prioridad media

4. Separar herramientas observacionales vs mutativas.
5. Registrar y mostrar en dashboard qué capacidades efectivas tiene cada agente.
6. Default seguro para workspace skills en repos externos.

### Prioridad baja

7. Documentar modelo de confianza del sistema en README/AGENTS.
8. Añadir tests de autorización negativa para tool activation, monitor API y Telegram config abierta.

## Diseño propuesto para una mejora concreta

### Opción recomendada: capability matrix

Modelo sugerido:
- `role_capabilities` estático por rol.
- Clasificación de tools en:
  - read-only
  - mutate_runtime
  - mutate_pm
  - launch_agents
  - gitops
  - external_delivery
- Chequeo central antes de ejecutar tools sensibles.

Ejemplo mínimo:
- `dev`: read-only + repo-edit local
- `reviewer`: read-only + report
- `git`: gitops
- `sub-coordinator`: launch_agents + mutate_pm + report + selective git handoff
- `secretary/coordinator`: orchestration amplia

## Criterio práctico

Si el objetivo del proyecto sigue siendo local-first y low-friction, no hace falta una plataforma compleja de IAM. Pero sí hace falta endurecer tres cosas para hablar de permisos reales:

1. enforcement de tools/capabilities por rol,
2. auth para endpoints mutativos del monitor,
3. fail-closed en Telegram.

Sin eso, el sistema tiene políticas de permiso, pero no un sistema fuerte de permisos.
