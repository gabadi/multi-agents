import { DatabaseSync } from 'node:sqlite';

export function generateBranchName(taskId: number, projectCode: string | null, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const prefix = projectCode ? projectCode : `t${taskId}`;
  const baseName = `${prefix}-${slug}`;

  return baseName.length > 50 ? baseName.substring(0, 50).replace(/-+$/, '') : baseName;
}

export function prepareWorktree(db: DatabaseSync, taskId: number, baseBranch: string = "main") {
  const taskStmt = db.prepare('SELECT project_id, title FROM tasks WHERE id = ?');
  const task = taskStmt.get(taskId) as { project_id: number; title: string } | undefined;

  if (!task) {
    throw new Error(`Task with id ${taskId} not found`);
  }

  const projectStmt = db.prepare('SELECT code, repo_local_path FROM projects WHERE id = ?');
  const project = projectStmt.get(task.project_id) as { code: string | null; repo_local_path: string | null } | undefined;

  if (!project?.repo_local_path) {
    throw new Error('Project missing repo_local_path; cannot create worktree');
  }

  const branchName = generateBranchName(taskId, project.code, task.title);
  const repoName = project.repo_local_path.split('/').filter(Boolean).pop() || 'repo';
  const worktreePath = `${project.repo_local_path}/../worktrees/${repoName}/${branchName}`;

  const updateStmt = db.prepare(`
    UPDATE tasks 
    SET branch_name = ?, 
        base_branch = ?, 
        worktree_path = ?, 
        worktree_status = 'active', 
        updated_at = datetime('now') 
    WHERE id = ?
  `);
  updateStmt.run(branchName, baseBranch, worktreePath, taskId);

  return { taskId, branchName, worktreePath, baseBranch };
}

export function archiveWorktree(db: DatabaseSync, taskId: number) {
  const checkStmt = db.prepare('SELECT worktree_status FROM tasks WHERE id = ?');
  const task = checkStmt.get(taskId) as { worktree_status: string | null } | undefined;

  if (!task) {
    throw new Error(`Task with id ${taskId} not found`);
  }

  if (task.worktree_status === 'archived' || task.worktree_status === 'deleted') {
    throw new Error(`Worktree already in status: ${task.worktree_status}`);
  }

  const updateStmt = db.prepare(`
    UPDATE tasks 
    SET worktree_status = 'archived', 
        updated_at = datetime('now') 
    WHERE id = ?
  `);
  updateStmt.run(taskId);

  return { taskId, worktreeStatus: 'archived' };
}

export function deleteWorktree(db: DatabaseSync, taskId: number) {
  const checkStmt = db.prepare('SELECT id FROM tasks WHERE id = ?');
  if (!checkStmt.get(taskId)) {
    throw new Error(`Task with id ${taskId} not found`);
  }

  const updateStmt = db.prepare(`
    UPDATE tasks 
    SET worktree_status = 'deleted', 
        worktree_path = NULL, 
        branch_name = NULL, 
        tmux_session = NULL, 
        tmux_pane = NULL, 
        updated_at = datetime('now') 
    WHERE id = ?
  `);
  updateStmt.run(taskId);

  return { taskId, worktreeStatus: 'deleted' };
}
