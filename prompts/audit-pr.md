---
description: Audit pull request with security, performance and architecture focus
argument-hint: "<PR-URL>"
---

Audit this PR: $1

## Focus areas
1. **Security**: SQL injection, XSS, secrets leaked, auth bypass, path traversal
2. **Performance**: N+1 queries, unbounded loops, memory leaks, blocking I/O sin timeout
3. **Architecture**: Coupling alto, violaciones de SRP, falta de abstraccion

## Output format
```markdown
### 🔴 Blockers
- [ ] Descripcion + linea

### 🟡 Warnings
- [ ] Descripcion + linea

### 🟢 Suggestions
- [ ] Descripcion

### Summary
TL;DR de riesgo y accion recomendada
```
