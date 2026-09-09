CREATE TABLE IF NOT EXISTS assemble_persistence_records (
  id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Apply these grants with the database migration owner after creating the
-- separately scoped runtime role. The app role needs no DDL permission.
-- GRANT USAGE ON SCHEMA public TO <runtime_role>;
-- GRANT SELECT, INSERT ON TABLE assemble_persistence_records TO <runtime_role>;
