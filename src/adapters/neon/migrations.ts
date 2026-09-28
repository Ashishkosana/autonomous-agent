/**
 * Versioned schema for Neon (Postgres). Append a new version; do not edit a
 * version that has been applied. The JSON body of a memory record stays the
 * source of truth, matching SQLite (ADR-005): these tables are the index,
 * the vectors, and the run-metric rows.
 *
 * Statements run in one transaction. Each statement is a single command
 * because the Postgres driver does not accept several commands in one query.
 */
export interface SqlMigration {
  readonly version: number;
  readonly statements: readonly string[];
}

export const NEON_SCHEMA_VERSION = 1;

const MEMORY_PUT = `
CREATE OR REPLACE FUNCTION agent_memory_put(
  p_record_id text,
  p_kind text,
  p_run_id text,
  p_goal_id text,
  p_task_id text,
  p_created_at text,
  p_summary text,
  p_body text,
  p_tags text[]
) RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  owner text;
BEGIN
  SELECT run_id INTO owner
  FROM agent_memory_records
  WHERE record_id = p_record_id
  FOR UPDATE;
  IF owner IS NOT NULL AND owner IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'memory_conflict:%', p_record_id USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO agent_memory_records (
    record_id, kind, run_id, goal_id, task_id, created_at, summary, body, seq
  ) VALUES (
    p_record_id, p_kind, p_run_id, p_goal_id, p_task_id, p_created_at, p_summary, p_body,
    nextval('agent_memory_record_seq')
  )
  ON CONFLICT (record_id) DO UPDATE SET
    kind = EXCLUDED.kind,
    run_id = EXCLUDED.run_id,
    goal_id = EXCLUDED.goal_id,
    task_id = EXCLUDED.task_id,
    created_at = EXCLUDED.created_at,
    summary = EXCLUDED.summary,
    body = EXCLUDED.body;
  DELETE FROM agent_memory_record_tags WHERE record_id = p_record_id;
  INSERT INTO agent_memory_record_tags (record_id, tag)
  SELECT p_record_id, tag
  FROM unnest(COALESCE(p_tags, ARRAY[]::text[])) AS tag
  ON CONFLICT DO NOTHING;
END;
$fn$
`;

export const MIGRATIONS: readonly SqlMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE SEQUENCE IF NOT EXISTS agent_memory_record_seq`,
      `CREATE SEQUENCE IF NOT EXISTS agent_memory_embedding_seq`,
      `CREATE TABLE IF NOT EXISTS agent_memory_records (
        record_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('knowledge', 'experience', 'decision', 'lesson')),
        run_id TEXT NOT NULL,
        goal_id TEXT,
        task_id TEXT,
        created_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        seq BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS agent_memory_records_order ON agent_memory_records (created_at, seq)`,
      `CREATE INDEX IF NOT EXISTS agent_memory_records_kind ON agent_memory_records (kind, created_at, seq)`,
      `CREATE INDEX IF NOT EXISTS agent_memory_records_run ON agent_memory_records (run_id)`,
      `CREATE INDEX IF NOT EXISTS agent_memory_records_goal ON agent_memory_records (goal_id)`,
      `CREATE TABLE IF NOT EXISTS agent_memory_record_tags (
        record_id TEXT NOT NULL REFERENCES agent_memory_records (record_id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (record_id, tag)
      )`,
      `CREATE INDEX IF NOT EXISTS agent_memory_record_tags_tag ON agent_memory_record_tags (tag)`,
      `CREATE TABLE IF NOT EXISTS agent_memory_embeddings (
        record_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        text_hash TEXT NOT NULL,
        vector BYTEA NOT NULL,
        seq BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS agent_memory_embeddings_model ON agent_memory_embeddings (provider, model, seq)`,
      `CREATE TABLE IF NOT EXISTS agent_run_metrics (
        run_id TEXT PRIMARY KEY,
        goal_statement TEXT NOT NULL,
        status TEXT NOT NULL,
        succeeded BOOLEAN NOT NULL,
        iterations INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL,
        model_calls INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        retrieval_hit_rate DOUBLE PRECISION,
        retrieval_hit_count INTEGER NOT NULL,
        signals_used TEXT NOT NULL,
        cited_record_ids TEXT NOT NULL,
        retrieved_record_ids TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS agent_run_metrics_goal ON agent_run_metrics (goal_statement, recorded_at DESC)`,
      MEMORY_PUT,
    ],
  },
];
