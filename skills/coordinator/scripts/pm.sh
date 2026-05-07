#!/bin/bash
# Project Management CLI — Helper para el Coordinator
# Opera sobre /tmp/fabric-agents/projects.sqlite

DB="${PM_DB:-/tmp/fabric-agents/projects.sqlite}"
set -euo pipefail

cmd_help() {
  cat <<EOF
Fabric PM CLI
Usage: pm.sh <command> [args]

Commands:
  project-create <name> <code> [description] [status]   Crear proyecto
  project-list                                         Listar proyectos
  project-tree <project_id>                            Ver arbol completo
  task-create <project_id> <title> [desc] [status]     Crear tarea
  task-list <project_id>                               Listar tareas
  subtask-create <task_id> <title> [desc] [status]     Crear subtarea
  task-assign <agent_id> <task_id> [type]              Asignar agente a tarea
  status-update <entity> <id> <new_status> [reason]   Cambiar estado
  dashboard                                            Resumen de proyectos

Entities: project, task, subtask
Statuses:
  project: planned, active, blocked, completed, cancelled, failed, archived
  task:    planned, backlog, ready, in_progress, ready_for_validation, validated,
           ready_for_pr, pr_open, pr_merged, done, blocked, failed, cancelled, archived
  subtask: planned, backlog, ready, in_progress, ready_for_validation, validated,
           done, blocked, failed, cancelled, archived
EOF
}

cmd_project_create() {
  local name="$1" code="$2" desc="${3:-}" status="${4:-active}"
  sqlite3 "$DB" "INSERT INTO projects (name, code, description, status)
    VALUES ('$name', '$code', '${desc:-}', '$status');"
  echo "Project created: $(sqlite3 "$DB" 'SELECT last_insert_rowid();')"
}

cmd_project_list() {
  sqlite3 "$DB" -header -column \
    "SELECT id, name, code, status, created_at FROM projects ORDER BY created_at DESC;"
}

cmd_project_tree() {
  local pid="$1"
  echo "=== PROJECT ==="
  sqlite3 "$DB" -header -column \
    "SELECT * FROM projects WHERE id = $pid;"
  echo ""
  echo "=== TASKS ==="
  sqlite3 "$DB" -header -column \
    "SELECT id, title, status, sequence_order FROM tasks WHERE project_id = $pid ORDER BY sequence_order;"
  echo ""
  echo "=== SUBTASKS ==="
  sqlite3 "$DB" -header -column \
    "SELECT s.id, s.task_id, s.title, s.status, s.sequence_order
     FROM subtasks s JOIN tasks t ON s.task_id = t.id
     WHERE t.project_id = $pid ORDER BY t.sequence_order, s.sequence_order;"
}

cmd_task_create() {
  local project_id="$1" title="$2" desc="${3:-}" status="${4:-planned}"
  sqlite3 "$DB" "INSERT INTO tasks (project_id, title, description, status, sequence_order)
    VALUES ($project_id, '$title', '${desc:-}', '$status', COALESCE((SELECT MAX(sequence_order)+1 FROM tasks WHERE project_id=$project_id), 0));"
  echo "Task created: $(sqlite3 "$DB" 'SELECT last_insert_rowid();')"
}

cmd_task_list() {
  local project_id="$1"
  sqlite3 "$DB" -header -column \
    "SELECT id, title, status, sequence_order, branch_name FROM tasks WHERE project_id = $project_id ORDER BY sequence_order;"
}

cmd_subtask_create() {
  local task_id="$1" title="$2" desc="${3:-}" status="${4:-planned}"
  sqlite3 "$DB" "INSERT INTO subtasks (task_id, title, description, status, sequence_order)
    VALUES ($task_id, '$title', '${desc:-}', '$status', COALESCE((SELECT MAX(sequence_order)+1 FROM subtasks WHERE task_id=$task_id), 0));"
  echo "Subtask created: $(sqlite3 "$DB" 'SELECT last_insert_rowid();')"
}

cmd_task_assign() {
  local agent_id="$1" task_id="$2" type="${3:-worker}"
  sqlite3 "$DB" "INSERT INTO agent_associations (agent_id, task_id, association_type, agent_status)
    VALUES ('$agent_id', $task_id, '$type', 'active');"
  echo "Agent $agent_id assigned to task $task_id as $type"
}

cmd_status_update() {
  local entity="$1" id="$2" new_status="$3" reason="${4:-}"
  local table="${entity}s"
  local completed=""
  if [[ "$new_status" == "done" || "$new_status" == "completed" || "$new_status" == "failed" || "$new_status" == "cancelled" || "$new_status" == "archived" ]]; then
    completed=", completed_at = datetime('now')"
  fi
  sqlite3 "$DB" "UPDATE $table SET status = '$new_status', updated_at = datetime('now') $completed WHERE id = $id;"
  sqlite3 "$DB" "INSERT INTO event_log (entity_type, entity_id, actor_type, actor_id, previous_state, new_state, reason)
    VALUES ('$entity', $id, 'agent', 'coordinator', (SELECT status FROM ${table} WHERE id=$id), '$new_status', '${reason:-}');"
  echo "$entity $id updated to $new_status"
}

cmd_dashboard() {
  sqlite3 "$DB" -header -column \
    "SELECT p.id, p.name, p.status, COUNT(t.id) as tasks,
      SUM(CASE WHEN t.status IN ('pr_merged','done') THEN 1 ELSE 0 END) as done
     FROM projects p LEFT JOIN tasks t ON p.id = t.project_id
     GROUP BY p.id ORDER BY p.created_at DESC;"
}

COMMAND="${1:-help}"
shift || true

case "$COMMAND" in
  project-create) cmd_project_create "$@" ;;
  project-list) cmd_project_list ;;
  project-tree) cmd_project_tree "$@" ;;
  task-create) cmd_task_create "$@" ;;
  task-list) cmd_task_list "$@" ;;
  subtask-create) cmd_subtask_create "$@" ;;
  task-assign) cmd_task_assign "$@" ;;
  status-update) cmd_status_update "$@" ;;
  dashboard) cmd_dashboard ;;
  help|*) cmd_help ;;
esac
