import { DatabaseSync } from "node:sqlite";
import { initDb } from "./db.js";
import { createProject, createTask, createSubtask, listSubtasks } from "./commands.js";
import { updateStatus } from "./transitions.js";
import { prepareWorktree } from "./worktree.js";
import { attachPR, markPRMerged } from "./attachments.js";
import { addSubtaskDependency } from "./dependencies.js";
import { assignTaskAgents, assignSubtaskAgents } from "./agents.js";
import { cleanupTask, cleanupStaleWorktrees } from "./cleanup.js";
import { getDashboard, getProjectTree, getTaskWithDetails } from "./queries.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function runIntegrationTest(dbPath: string = ":memory:"): { passed: boolean; steps: string[]; error?: string } {
  const steps: string[] = [];
  try {
    const db = initDb(dbPath);
    steps.push("Database initialized");

    // Step 1: Create project
    const project = createProject(db, {
      name: "Fabric Coordination",
      code: "fab-coord",
      repo_url: "https://github.com/jescobar/cmd-center-v2",
      repo_local_path: "/Users/jescobar/code/cmd-center-v2"
    });
    const projectId = project.id;
    steps.push("Project created");

    // Step 2: Create two tasks
    const task1 = createTask(db, {
      project_id: projectId,
      title: "Implement Mailbox",
      status: "draft",
      coordinator_agent_id: "boss",
    });
    const task2 = createTask(db, {
      project_id: projectId,
      title: "Build Dashboard",
      status: "draft",
    });
    const taskId1 = task1.id;
    const taskId2 = task2.id;
    steps.push("Tasks created");

    // Step 3: Create subtasks for task1
    const subtask1 = createSubtask(db, {
      task_id: taskId1,
      title: "Design schema",
      status: "backlog",
      validation_criteria: "Schema covers all message types",
      worker_agent_id: "worker-1",
    });
    const subtask2 = createSubtask(db, {
      task_id: taskId1,
      title: "Write queries",
      status: "backlog",
      validation_criteria: "All queries return within 10ms",
    });
    steps.push("Subtasks created");

    // Step 4: Prepare worktree for task1
    prepareWorktree(db, taskId1, "main");
    steps.push("Worktree prepared");

    // Step 5: Assign agents via direct columns
    assignTaskAgents(db, taskId1, { orchestrator_agent_id: "orchestrator-1" });
    assignSubtaskAgents(db, subtask1.id, { worker_agent_id: "worker-1", qa_agent_id: "qa-1" });
    steps.push("Agents assigned");

    // Step 6: Add subtask dependency (subtask2 depends on subtask1)
    addSubtaskDependency(db, subtask2.id, subtask1.id, "blocking");
    steps.push("Subtask dependencies added");

    // Step 7: Attach PR to task1
    attachPR(db, taskId1, "https://github.com/jescobar/cmd-center-v2/pull/1", 1);
    steps.push("PR attached");

    // Step 8: Mark PR merged
    markPRMerged(db, taskId1);
    steps.push("PR marked merged");

    // Step 9: Transition subtasks
    updateStatus(db, { entityType: "subtask", id: subtask1.id, newState: "running", actorType: "agent", agentId: "worker-1" });
    updateStatus(db, { entityType: "subtask", id: subtask1.id, newState: "validating", actorType: "agent", agentId: "worker-1" });
    updateStatus(db, { entityType: "subtask", id: subtask1.id, newState: "done", actorType: "agent", agentId: "qa-1" });
    // subtask2 is blocked by subtask1, so it should stay backlog or move to running only after dependency resolved
    // Since dependencies are not auto-enforced in transitions, we manually move it after subtask1 is done
    updateStatus(db, { entityType: "subtask", id: subtask2.id, newState: "running", actorType: "agent", agentId: "worker-1" });
    updateStatus(db, { entityType: "subtask", id: subtask2.id, newState: "done", actorType: "agent", agentId: "qa-1" });
    steps.push("Subtasks updated");

    // Step 10: Transition task1
    updateStatus(db, { entityType: "task", id: taskId1, newState: "in_progress", actorType: "user" });
    updateStatus(db, { entityType: "task", id: taskId1, newState: "completed", actorType: "agent", agentId: "orchestrator-1" });
    steps.push("Task1 completed");

    // Step 11: Transition task2
    updateStatus(db, { entityType: "task", id: taskId2, newState: "in_progress", actorType: "user" });
    steps.push("Task2 started");

    // Step 12: Verify dashboard
    const summary = getDashboard(db);
    assert(summary.length >= 1, "Dashboard summary length incorrect");
    assert(summary[0].task_count === 2, "Task count in dashboard incorrect");
    assert(summary[0].tasks_completed === 1, "Completed task count incorrect");
    steps.push("Dashboard verified");

    // Step 13: Verify project tree
    const tree = getProjectTree(db, projectId);
    assert(tree.tasks.length === 2, "Project tree task count mismatch");
    steps.push("Project tree verified");

    // Step 14: Verify task details
    const details = getTaskWithDetails(db, taskId1);
    assert(details.subtasks.length === 2, "Task details subtask count mismatch");
    assert(details.blocked_by.length === 1, "Task details subtask dependency count mismatch");
    steps.push("Task details verified");

    // Step 15: Verify subtask dependencies
    const subtask2Deps = db.prepare("SELECT * FROM subtask_dependencies WHERE subtask_id = ?").all(subtask2.id) as any[];
    assert(subtask2Deps.length === 1, "Subtask dependency count mismatch");
    assert(subtask2Deps[0].depends_on_subtask_id === subtask1.id, "Subtask dependency target mismatch");
    steps.push("Subtask dependencies verified");

    // Step 16: Verify event log
    const events = db.prepare("SELECT COUNT(*) as c FROM event_log").get() as any;
    assert(events.c > 5, "Event log entries too low");
    steps.push("Event log verified");

    // Step 17: Cleanup task1
    cleanupTask(db, taskId1, "user", "me", "end of sprint");
    const task1After = db.prepare("SELECT status, worktree_status FROM tasks WHERE id = ?").get(taskId1) as any;
    assert(task1After.status === "completed", "Task status should remain completed after cleanup");
    assert(task1After.worktree_status === "deleted", "Worktree status not deleted");
    steps.push("Task cleaned up");

    // Step 18: Cleanup stale worktrees
    const cleaned = cleanupStaleWorktrees(db);
    assert(cleaned.cleaned >= 0, "Cleanup count mismatch");
    steps.push("Cleanup finished");

    return { passed: true, steps };
  } catch (e: any) {
    return { passed: false, steps, error: e.message };
  }
}
