-- Migration: Make task_analyses survive task deletion
-- Changes ON DELETE CASCADE to ON DELETE SET NULL
-- Adds project_id column for orphaned analyses

-- SQLite requires recreating the table to change FK behavior
BEGIN TRANSACTION;

-- Create new table with updated FK constraints
CREATE TABLE task_analyses_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  version TEXT NOT NULL DEFAULT 'v1',
  keywords TEXT DEFAULT '[]',
  human_note TEXT,
  agent_note TEXT NOT NULL DEFAULT '',
  analysis_type TEXT NOT NULL DEFAULT 'general'
    CHECK(analysis_type IN ('debugging','root_cause','planning','review','validation','evaluation','retro','decision','general')),
  confidence_score INTEGER DEFAULT 50
    CHECK(confidence_score >= 0 AND confidence_score <= 100),
  author_id TEXT,
  author_type TEXT CHECK(author_type IN ('agent','user','system')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  invalidated_at TEXT DEFAULT NULL,
  superseded_by_id INTEGER DEFAULT NULL,
  is_active INTEGER DEFAULT 1 CHECK(is_active IN (0,1))
);

-- Copy existing data with project_id lookup
INSERT INTO task_analyses_new (id, task_id, project_id, version, keywords, human_note, agent_note, analysis_type, confidence_score, author_id, author_type, created_at, invalidated_at, superseded_by_id, is_active)
SELECT 
  a.id,
  a.task_id,
  t.project_id as project_id,  -- Extract project_id from the task
  a.version,
  a.keywords,
  a.human_note,
  a.agent_note,
  a.analysis_type,
  a.confidence_score,
  a.author_id,
  a.author_type,
  a.created_at,
  a.invalidated_at,
  a.superseded_by_id,
  a.is_active
FROM task_analyses a
LEFT JOIN tasks t ON a.task_id = t.id;

-- Drop old table
DROP TABLE task_analyses;

-- Rename new table
ALTER TABLE task_analyses_new RENAME TO task_analyses;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_analyses_task_active ON task_analyses(task_id, is_active);
CREATE INDEX IF NOT EXISTS idx_analyses_project ON task_analyses(project_id);
CREATE INDEX IF NOT EXISTS idx_analyses_project_active ON task_analyses(project_id, is_active);
CREATE INDEX IF NOT EXISTS idx_analyses_type ON task_analyses(analysis_type);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON task_analyses(created_at);

COMMIT;

-- Verify
SELECT 'Migration complete' as status, 
       (SELECT COUNT(*) FROM task_analyses) as analyses_count,
       (SELECT COUNT(*) FROM task_analyses WHERE project_id IS NOT NULL) as with_project_id;
