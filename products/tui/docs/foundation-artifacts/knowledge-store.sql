CREATE TABLE IF NOT EXISTS native_conversation_captures (project_id TEXT NOT NULL, principal_id TEXT NOT NULL, input_id TEXT NOT NULL, request_id TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, principal_id, input_id), UNIQUE(project_id, principal_id, request_id));

CREATE TABLE IF NOT EXISTS work_ledgers (project_id TEXT PRIMARY KEY NOT NULL, format_version INTEGER NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS native_work_executions (project_id TEXT NOT NULL, key_hash TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, attempt_id TEXT NOT NULL, PRIMARY KEY(project_id, key_hash), UNIQUE(project_id, attempt_id));

CREATE TABLE IF NOT EXISTS native_work_execution_intents (project_id TEXT NOT NULL, attempt_id TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, attempt_id));

CREATE TABLE IF NOT EXISTS native_work_execution_settlements (project_id TEXT NOT NULL, key_hash TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, key_hash));

CREATE INDEX IF NOT EXISTS native_work_settlement_targets ON native_work_execution_settlements(project_id,format_version,json_extract(state_json, '$.target.attemptId'));

CREATE TABLE IF NOT EXISTS native_ci_continuations (project_id TEXT NOT NULL, continuation_id TEXT NOT NULL, format_version INTEGER NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(project_id, continuation_id));

CREATE TABLE IF NOT EXISTS knowledge_sources (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT,
      source_uri TEXT,
      canonical_uri TEXT,
      summary TEXT,
      description TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      folder_path TEXT,
      status TEXT NOT NULL,
      artifact_id TEXT,
      content_hash TEXT,
      last_crawled_at INTEGER,
      crawl_error TEXT,
      session_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      gv_revision TEXT NOT NULL DEFAULT ''
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_canonical_uri ON knowledge_sources(canonical_uri);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_updated_at ON knowledge_sources(updated_at);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_planning_identity
  ON knowledge_sources (CASE WHEN json_valid(metadata) THEN COALESCE(json_extract(metadata, '$.knowledgeSpaceId'), json_extract(metadata, '$.spaceId'), json_extract(metadata, '$.namespace')) END, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.planningArtifactKind') END, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.planningArtifactId') END)
  WHERE connector_id = 'goodvibes-project-planning';

CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      source_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      gv_revision TEXT NOT NULL DEFAULT '',
      gv_content_revision TEXT NOT NULL DEFAULT ''
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_nodes_kind_slug ON knowledge_nodes(kind, slug);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_updated_at ON knowledge_nodes(updated_at);

CREATE TABLE IF NOT EXISTS knowledge_edges (
      id TEXT PRIMARY KEY,
      from_kind TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_kind TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      gv_revision TEXT NOT NULL DEFAULT ''
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_edges_unique ON knowledge_edges(from_kind, from_id, to_kind, to_id, relation);

CREATE TABLE IF NOT EXISTS knowledge_edge_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    edge_id TEXT NOT NULL,
    from_kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_kind TEXT NOT NULL,
    to_id TEXT NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_knowledge_edge_changes_endpoints ON knowledge_edge_changes(from_kind,from_id,to_kind,to_id,sequence);

CREATE TRIGGER IF NOT EXISTS knowledge_edge_change_insert AFTER INSERT ON knowledge_edges BEGIN
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(NEW.id,NEW.from_kind,NEW.from_id,NEW.to_kind,NEW.to_id);
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_edge_change_delete AFTER DELETE ON knowledge_edges BEGIN
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(OLD.id,OLD.from_kind,OLD.from_id,OLD.to_kind,OLD.to_id);
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_edge_change_update AFTER UPDATE ON knowledge_edges
    WHEN OLD.id IS NOT NEW.id OR OLD.from_kind IS NOT NEW.from_kind OR OLD.from_id IS NOT NEW.from_id
      OR OLD.to_kind IS NOT NEW.to_kind OR OLD.to_id IS NOT NEW.to_id OR OLD.relation IS NOT NEW.relation
      OR OLD.weight IS NOT NEW.weight OR OLD.metadata IS NOT NEW.metadata
      OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at BEGIN
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(OLD.id,OLD.from_kind,OLD.from_id,OLD.to_kind,OLD.to_id);
    INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id) VALUES(NEW.id,NEW.from_kind,NEW.from_id,NEW.to_kind,NEW.to_id);
  END;

INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id)
    SELECT id,from_kind,from_id,to_kind,to_id FROM knowledge_edges
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_edge_changes);

CREATE TABLE IF NOT EXISTS knowledge_issues (
      id TEXT PRIMARY KEY,
      severity TEXT NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      source_id TEXT,
      node_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_issues_code ON knowledge_issues(code);

CREATE TABLE IF NOT EXISTS knowledge_extractions (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      artifact_id TEXT,
      extractor_id TEXT NOT NULL,
      format TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      excerpt TEXT,
      sections TEXT NOT NULL DEFAULT '[]',
      links TEXT NOT NULL DEFAULT '[]',
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      structure TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      gv_revision TEXT NOT NULL DEFAULT ''
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_extractions_source_id ON knowledge_extractions(source_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_extractions_format ON knowledge_extractions(format);

CREATE TABLE IF NOT EXISTS knowledge_job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      result TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_job_runs_job_id ON knowledge_job_runs(job_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_job_runs_requested_at ON knowledge_job_runs(requested_at);

CREATE TABLE IF NOT EXISTS knowledge_refinement_tasks (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      subject_kind TEXT,
      subject_id TEXT,
      subject_title TEXT,
      subject_type TEXT,
      gap_id TEXT,
      issue_id TEXT,
      state TEXT NOT NULL,
      priority TEXT NOT NULL,
      trigger TEXT NOT NULL,
      budget TEXT NOT NULL DEFAULT '{}',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT,
      trace TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_refinement_space_state ON knowledge_refinement_tasks(space_id, state);

CREATE INDEX IF NOT EXISTS idx_knowledge_refinement_gap ON knowledge_refinement_tasks(gap_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_refinement_subject ON knowledge_refinement_tasks(subject_kind, subject_id);

CREATE TABLE IF NOT EXISTS knowledge_usage_records (
      id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      usage_kind TEXT NOT NULL,
      task TEXT,
      session_id TEXT,
      score REAL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_usage_target ON knowledge_usage_records(target_kind, target_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_usage_created_at ON knowledge_usage_records(created_at);

CREATE TABLE IF NOT EXISTS knowledge_consolidation_candidates (
      id TEXT PRIMARY KEY,
      candidate_type TEXT NOT NULL,
      status TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      score REAL NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      suggested_memory_class TEXT,
      suggested_scope TEXT,
      decided_at INTEGER,
      decided_by TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_subject ON knowledge_consolidation_candidates(subject_kind, subject_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_status ON knowledge_consolidation_candidates(status);

CREATE TABLE IF NOT EXISTS knowledge_consolidation_reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      highlights TEXT NOT NULL DEFAULT '[]',
      metrics TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_reports_kind ON knowledge_consolidation_reports(kind);

CREATE TABLE IF NOT EXISTS knowledge_schedules (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      schedule TEXT NOT NULL,
      last_run_at INTEGER,
      next_run_at INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_knowledge_schedules_job_id ON knowledge_schedules(job_id);

CREATE TABLE IF NOT EXISTS knowledge_node_revisions (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      change_kind TEXT NOT NULL,
      changed_fields TEXT NOT NULL DEFAULT '[]',
      kind TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      source_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      node_created_at INTEGER NOT NULL,
      node_updated_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_node_revisions_unique ON knowledge_node_revisions(node_id, revision);

CREATE INDEX IF NOT EXISTS idx_knowledge_node_revisions_node ON knowledge_node_revisions(node_id);

CREATE TABLE IF NOT EXISTS knowledge_semantic_enrichment_state (
      source_id TEXT PRIMARY KEY,
      text_hash TEXT,
      enriched_at INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

PRAGMA recursive_triggers = OFF;

CREATE TRIGGER IF NOT EXISTS knowledge_sources_revision_insert AFTER INSERT ON knowledge_sources BEGIN
    UPDATE knowledge_sources SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_sources_revision_update AFTER UPDATE ON knowledge_sources BEGIN
    UPDATE knowledge_sources SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_nodes_revision_insert AFTER INSERT ON knowledge_nodes BEGIN
    UPDATE knowledge_nodes SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_nodes_revision_update AFTER UPDATE ON knowledge_nodes BEGIN
    UPDATE knowledge_nodes SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_extractions_revision_insert AFTER INSERT ON knowledge_extractions BEGIN
    UPDATE knowledge_extractions SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_extractions_revision_update AFTER UPDATE ON knowledge_extractions BEGIN
    UPDATE knowledge_extractions SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_edges_revision_insert AFTER INSERT ON knowledge_edges BEGIN
    UPDATE knowledge_edges SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END;

CREATE TRIGGER IF NOT EXISTS knowledge_edges_revision_update AFTER UPDATE ON knowledge_edges BEGIN
    UPDATE knowledge_edges SET gv_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END;

CREATE TRIGGER knowledge_nodes_content_revision_insert AFTER INSERT ON knowledge_nodes BEGIN
    UPDATE knowledge_nodes SET gv_content_revision = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
  END;

CREATE TRIGGER knowledge_nodes_content_revision_update AFTER UPDATE ON knowledge_nodes
  WHEN NEW.gv_content_revision = '' OR (OLD.kind IS NOT NEW.kind OR OLD.slug IS NOT NEW.slug OR OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary OR OLD.aliases IS NOT NEW.aliases OR OLD.confidence IS NOT NEW.confidence OR OLD.source_id IS NOT NEW.source_id OR json_remove(OLD.metadata, '$.reviewProvenance', '$.nodeActivation', '$.nodeObservation') IS NOT json_remove(NEW.metadata, '$.reviewProvenance', '$.nodeActivation', '$.nodeObservation')) OR OLD.gv_content_revision IS NOT NEW.gv_content_revision BEGIN
    UPDATE knowledge_nodes SET gv_content_revision = CASE WHEN (OLD.kind IS NOT NEW.kind OR OLD.slug IS NOT NEW.slug OR OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary OR OLD.aliases IS NOT NEW.aliases OR OLD.confidence IS NOT NEW.confidence OR OLD.source_id IS NOT NEW.source_id OR json_remove(OLD.metadata, '$.reviewProvenance', '$.nodeActivation', '$.nodeObservation') IS NOT json_remove(NEW.metadata, '$.reviewProvenance', '$.nodeActivation', '$.nodeObservation')) OR OLD.gv_content_revision IS NOT NEW.gv_content_revision
      THEN lower(hex(randomblob(16))) ELSE OLD.gv_revision END WHERE rowid = NEW.rowid;
  END;

CREATE TABLE knowledge_node_activation_dependencies (
  node_id TEXT NOT NULL PRIMARY KEY,
  receipt_reference TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL
);

CREATE TRIGGER knowledge_node_activation_dependencies_delete AFTER DELETE ON knowledge_nodes BEGIN
  DELETE FROM knowledge_node_activation_dependencies WHERE node_id = OLD.id;
END;

CREATE UNIQUE INDEX idx_knowledge_sources_generated_projection_identity
  ON knowledge_sources (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.projectionScopeKind') END, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.projectionSpaceId') END, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.targetKind') END, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.targetId') END) WHERE connector_id = 'knowledge-projection' AND json_valid(metadata);

CREATE INDEX idx_knowledge_sources_artifact_reference ON knowledge_sources(artifact_id) WHERE artifact_id IS NOT NULL;

CREATE INDEX idx_knowledge_extractions_artifact_reference ON knowledge_extractions(artifact_id) WHERE artifact_id IS NOT NULL;

CREATE INDEX idx_knowledge_edges_artifact_target_reference ON knowledge_edges(to_id) WHERE to_kind = 'artifact';

CREATE UNIQUE INDEX idx_knowledge_nodes_semantic_fact_identity ON knowledge_nodes (coalesce(nullif(trim(json_extract(metadata, '$.knowledgeSpaceId')), ''), nullif(trim(json_extract(metadata, '$.spaceId')), ''), nullif(trim(json_extract(metadata, '$.namespace')), ''), 'default'), json_extract(metadata, '$.factKind'), title, json_array(summary), json_array(json_extract(metadata, '$.value')), coalesce(json_extract(metadata, '$.semanticIdentityScope'), ''), coalesce(json_extract(metadata, '$.semanticIdentitySourceId'), ''), coalesce(json_extract(metadata, '$.subjectIds'), '[]'), CASE WHEN json_extract(metadata, '$.semanticIdentityVersion') = 1 THEN 1 END) WHERE kind = 'fact' AND json_valid(metadata);

CREATE INDEX idx_knowledge_nodes_semantic_role_scope ON knowledge_nodes (kind, CASE WHEN json_extract(metadata, '$.gapKind') = 'intrinsic_features' THEN 'subject' ELSE 'source' END, CASE WHEN json_extract(metadata, '$.gapKind') = 'intrinsic_features' THEN json_extract(metadata, '$.linkedObjectIds[0]') ELSE source_id END) WHERE json_valid(metadata) AND kind IN ('knowledge_entity', 'knowledge_gap', 'wiki_page');

CREATE INDEX idx_knowledge_nodes_homegraph_object ON knowledge_nodes (kind, json_extract(metadata, '$.homeAssistant.objectId')) WHERE json_valid(metadata) AND json_type(metadata, '$.homeAssistant.objectId') = 'text';

CREATE UNIQUE INDEX idx_knowledge_nodes_homegraph_object_v1 ON knowledge_nodes (kind, json_extract(metadata, '$.homeGraphIdentitySpace'), json_extract(metadata, '$.homeAssistant.objectId')) WHERE json_valid(metadata) AND json_type(metadata, '$.homeAssistant.objectId') = 'text' AND json_extract(metadata, '$.homeGraphIdentityVersion') = 1 AND json_type(metadata, '$.homeGraphIdentitySpace') = 'text';

CREATE INDEX idx_knowledge_sources_homegraph_uri ON knowledge_sources (connector_id, source_uri) WHERE source_uri IS NOT NULL;

CREATE INDEX idx_knowledge_sources_homegraph_capture ON knowledge_sources (last_crawled_at) WHERE connector_id = 'homeassistant' AND json_valid(metadata) AND json_extract(metadata, '$.homeGraphSourceKind') = 'snapshot';

CREATE INDEX idx_knowledge_sources_homegraph_page ON knowledge_sources (json_extract(metadata, '$.projectionKind'), CASE json_extract(metadata, '$.projectionKind') WHEN 'device-passport' THEN json_extract(metadata, '$.deviceId') WHEN 'room-page' THEN COALESCE(json_extract(metadata, '$.areaId'), '') WHEN 'packet' THEN json_extract(metadata, '$.packetKind') END, CASE WHEN json_extract(metadata, '$.homeGraphSourceKind') = 'generated-page' AND json_extract(metadata, '$.projectionKind') = 'packet' THEN json_extract(metadata, '$.sharingProfile') ELSE '' END) WHERE connector_id = 'homeassistant' AND json_valid(metadata) AND json_extract(metadata, '$.homeGraphSourceKind') = 'generated-page';

CREATE UNIQUE INDEX idx_knowledge_sources_homegraph_identity_v1 ON knowledge_sources (json_extract(metadata, '$.homeGraphIdentitySpace'), json_extract(metadata, '$.homeGraphSourceKind'), CASE json_extract(metadata, '$.homeGraphSourceKind') WHEN 'snapshot' THEN CASE WHEN json_type(metadata, '$.capturedAt') = 'integer' THEN 'supplied-time' END WHEN 'generated-page' THEN json_extract(metadata, '$.projectionKind') ELSE json_extract(metadata, '$.homeGraphSourceLocator') END, CASE json_extract(metadata, '$.homeGraphSourceKind') WHEN 'snapshot' THEN CAST(json_extract(metadata, '$.capturedAt') AS TEXT) WHEN 'generated-page' THEN CASE json_extract(metadata, '$.projectionKind') WHEN 'device-passport' THEN json_extract(metadata, '$.deviceId') WHEN 'room-page' THEN COALESCE(json_extract(metadata, '$.areaId'), '') WHEN 'packet' THEN json_extract(metadata, '$.packetKind') END ELSE CASE json_extract(metadata, '$.homeGraphSourceLocator') WHEN 'uri' THEN source_uri WHEN 'artifact' THEN artifact_id END END, CASE WHEN json_extract(metadata, '$.homeGraphSourceKind') = 'generated-page' AND json_extract(metadata, '$.projectionKind') = 'packet' THEN json_extract(metadata, '$.sharingProfile') ELSE '' END) WHERE connector_id = 'homeassistant' AND json_valid(metadata) AND json_extract(metadata, '$.homeGraphSourceIdentityVersion') = 1;
