# Agent Launcher Skill Rollout Plan

## Summary

We now have **two skills** to ensure consistent agent launching across all roles:

1. **`skills/secretary/SKILL.md`** - Updated with comprehensive launching guidance
2. **`skills/agent_launcher/SKILL.md`** - New shared reference skill for all roles

## The Problem We Solved

Previous issues encountered:
- Secretary didn't ask about tmux layout before launching
- Coordinator launched in wrong mode (RPC instead of interactive)
- Working directory was incorrect (cmd-center-v2 vs worktree)
- No validation after launch - reported success before confirming
- Confusion about `fabric_launch_agent` vs manual tmux approaches

## The Solution

### 1. Clarifying Questions (Secretary Responsibility)

Before launching ANY agent, ask:

| Question | Why It Matters |
|----------|----------------|
| "What agent_id?" | Unique identifier for tracking |
| "What role?" | Determines mode (interactive vs RPC) |
| "Specific tmux layout? (lazygit, terminal windows)" | Determines approach (Pattern A vs B) |
| "What working directory?" | Ensures agent operates in correct context |
| "Interactive coordinator - correct?" | Confirms mode for coordinators |

### 2. Two Launch Patterns

**Pattern A: `fabric_launch_agent` (Simple)**
- Use when: Just need agent running, layout doesn't matter
- Cannot control: Session name, window names, pane layout
- Best for: Background workers, quick RPC agents

**Pattern B: Manual tmux (Full Control)**  
- Use when: Human wants specific windows (lazygit, terminal)
- You control: Session name, window names, directory
- Best for: Human-facing coordinator sessions

### 3. Role-to-Mode Mapping (ALWAYS)

```
COORDINATORS = interactive (TTY needed)
- coordinator
- sub-coordinator  
- chat
- secretary

WORKERS = RPC (no TTY needed)
- dev
- reviewer
- test
- git
- devops
- security
```

### 4. Post-Launch Validation (MANDATORY)

After EVERY launch:

```bash
# 1. Registry check
sqlite3 /tmp/fabric-agents/registry.sqlite "SELECT agent_id, status FROM agents WHERE agent_id='AGENT_ID';"

# 2. tmux session check
tmux list-windows -t SESSION_NAME
tmux list-panes -s -t SESSION_NAME

# 3. Directory check (for manual tmux)
tmux capture-pane -pt SESSION_NAME:WINDOW
tmux list-panes -s -t SESSION_NAME:WINDOW -F '#{pane_current_path}'
```

**DO NOT report success until all checks pass.**

## Rollout Steps

### Phase 1: Secretary (DONE) ✅
- Updated `skills/secretary/SKILL.md`
- Added "AGENT LAUNCHING - CRITICAL RULES" section
- Added context gathering questions
- Added validation requirements
- Added Pattern A vs Pattern B decision tree

### Phase 2: Coordinator (DONE) ✅
**File:** `skills/coordinator/SKILL.md`

**Additions:**
- Reference to shared `skills/agent_launcher/SKILL.md`
- "Agent Launching" section with Pattern A (`fabric_launch_agent`) for workers
- Pattern B (manual tmux) for sub-coordinators with `env -u TMUX`
- Role-to-Mode Mapping table
- Launch Validation Checklist (MANDATORY)
- Kill and Recreate Pattern

### Phase 3: Sub-coordinator (DONE) ✅
**File:** `skills/sub-coordinator/SKILL.md`

**Additions:**
- Reference to `skills/agent_launcher/SKILL.md`
- Role-to-Mode Mapping for workers vs coordinators
- Launch Validation requirements
- Worker mode requirements (RPC only)

### Phase 4: All Worker Roles (DONE) ✅
**Files updated:**
- `skills/dev/SKILL.md` - Added RPC mode note and agent_launcher reference
- `skills/reviewer/SKILL.md` - Added RPC mode note and agent_launcher reference
- `skills/tester/SKILL.md` - Added RPC mode note and agent_launcher reference
- `skills/git/SKILL.md` - Added RPC mode note and agent_launcher reference
- `skills/devops/SKILL.md` - Added RPC mode note and agent_launcher reference
- `skills/security/SKILL.md` - Added RPC mode note and agent_launcher reference
- `skills/chat/SKILL.md` - Added RPC mode note and agent_launcher reference
- `skills/architect/SKILL.md` - Added RPC mode note and agent_launcher reference
- `skills/orchestrator/SKILL.md` - Added RPC mode note and agent_launcher reference

### Phase 5: Testing & Validation

**Test cases:**

1. **Secretary launches coordinator with layout**
   - Ask: agent_id, role, layout, directory
   - Use Pattern B
   - Validate: session exists, windows correct, directory correct

2. **Secretary launches RPC worker**
   - Use Pattern A
   - Validate: agent registered, running

3. **Coordinator launches sub-coordinator**
   - Use Pattern B with env -u TMUX
   - Validate: session separate, not nested

4. **Coordinator launches worker**
   - Use Pattern A
   - Validate: agent registered, reports to coordinator

## Reference Skill Contents

The `skills/agent_launcher/SKILL.md` contains:

1. **Role-to-Mode Mapping Table** - Canonical reference
2. **Two Launch Approaches** - Decision tree for when to use each
3. **Pattern A: fabric_launch_agent** - Simple approach template
4. **Pattern B: Manual tmux** - Full control template with examples
5. **Post-Launch Validation** - Mandatory checklist
6. **Common Mistakes** - What to avoid
7. **Environment Setup** - Node path, launcher path discovery
8. **Kill and Recreate Pattern** - Clean replacement
9. **Quick Reference Card** - At-a-glance decision guide

## Success Criteria

After rollout, these scenarios should work flawlessly:

| Scenario | Before | After |
|----------|--------|-------|
| "Launch coordinator with lazygit and terminal" | ❌ Wrong directory, wrong mode, no validation | ✅ Asks layout, uses Pattern B, validates all |
| "Launch dev worker for task" | ❌ May use wrong mode | ✅ Uses Pattern A, RPC mode, validates |
| "Replace crashed coordinator" | ❌ Leaves zombie sessions | ✅ Kill+recreate pattern, clean slate |
| "Launch in worktree" | ❌ Opens in cmd-center-v2 | ✅ Correct `-c` directory or `cd` |

## Maintenance

Keep `skills/agent_launcher/SKILL.md` as the **single source of truth** for:
- Role-to-mode mappings
- Launch patterns
- Validation procedures
- Common mistakes

Other skills should reference it, not duplicate it.

## Files Modified/Created

```
skills/secretary/SKILL.md          # UPDATED - Added launching guidance
skills/agent_launcher/SKILL.md     # NEW - Shared reference
AGENT_LAUNCHER_ROLLOUT_PLAN.md     # NEW - This document
```

## Next Actions

1. ✅ Update secretary skill (DONE)
2. ✅ Create agent_launcher skill (DONE)
3. ⬜ Update coordinator skill with reference + sub-coordinator launch section
4. ⬜ Update/create sub-coordinator skill
5. ⬜ Update dev/reviewer/test/git skills with brief mode notes
6. ⬜ Test all scenarios
7. ⬜ Close rollout plan when complete
