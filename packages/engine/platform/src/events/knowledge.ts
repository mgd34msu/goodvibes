/**
 * KnowledgeEvent, structured knowledge ingest, extraction, packet, projection, and job lifecycle events.
 */

export type KnowledgeEvent =
  /** Reading a source into the knowledge store began: `connectorId` is the connector reading it, `sourceType` its kind and `uri` where it is, when it has an address. */
  | {
      type: 'KNOWLEDGE_INGEST_STARTED';
      sourceId: string;
      connectorId: string;
      sourceType: string;
      uri?: string | undefined;
    }
  /** A source was read into the knowledge store; `status` is the source's stored status, and `artifactId` and `title` name what was kept, when there is one. */
  | {
      type: 'KNOWLEDGE_INGEST_COMPLETED';
      sourceId: string;
      status: string;
      artifactId?: string | undefined;
      title?: string | undefined;
    }
  /** Reading a source into the knowledge store failed; `error` says why. */
  | {
      type: 'KNOWLEDGE_INGEST_FAILED';
      sourceId: string;
      error: string;
    }
  /** The text of an ingested source was extracted and stored: `format` is what it was read as and `estimatedTokens` its size. */
  | {
      type: 'KNOWLEDGE_EXTRACTION_COMPLETED';
      sourceId: string;
      extractionId: string;
      format: string;
      estimatedTokens: number;
    }
  /** Extracting the text of an ingested source failed; nothing from it was stored. */
  | {
      type: 'KNOWLEDGE_EXTRACTION_FAILED';
      sourceId: string;
      error: string;
    }
  /** An extracted source was compiled into the knowledge graph: `nodeCount` nodes and `edgeCount` edges. */
  | {
      type: 'KNOWLEDGE_COMPILE_COMPLETED';
      sourceId: string;
      nodeCount: number;
      edgeCount: number;
    }
  /** A knowledge store check finished; `issueCount` is the number of issues it recorded. */
  | {
      type: 'KNOWLEDGE_LINT_COMPLETED';
      issueCount: number;
    }
  /** A packet of knowledge was assembled for a task (`task` is a preview of it): `itemCount` items, `estimatedTokens` in size, at `detail` level. */
  | {
      type: 'KNOWLEDGE_PACKET_BUILT';
      task: string;
      itemCount: number;
      estimatedTokens: number;
      detail: 'compact' | 'standard' | 'detailed';
    }
  /** Knowledge was rendered as Markdown pages for a projection target, without saving them; `pageCount` is how many. */
  | {
      type: 'KNOWLEDGE_PROJECTION_RENDERED';
      targetId: string;
      pageCount: number;
    }
  /** A Markdown projection was rendered and saved as an artifact (`artifactId`), `pageCount` pages. */
  | {
      type: 'KNOWLEDGE_PROJECTION_MATERIALIZED';
      targetId: string;
      artifactId: string;
      pageCount: number;
    }
  /** A knowledge maintenance job was queued to run, either `inline` (now, in the caller) or in the `background`. */
  | {
      type: 'KNOWLEDGE_JOB_QUEUED';
      jobId: string;
      runId: string;
      mode: 'inline' | 'background';
    }
  /** A queued knowledge job began running. */
  | {
      type: 'KNOWLEDGE_JOB_STARTED';
      jobId: string;
      runId: string;
      mode: 'inline' | 'background';
    }
  /** A knowledge job finished; `durationMs` is how long it ran. */
  | {
      type: 'KNOWLEDGE_JOB_COMPLETED';
      jobId: string;
      runId: string;
      durationMs: number;
    }
  /** A knowledge job failed after `durationMs`; `error` says why. */
  | {
      type: 'KNOWLEDGE_JOB_FAILED';
      jobId: string;
      runId: string;
      error: string;
      durationMs: number;
    };

export type KnowledgeEventType = KnowledgeEvent['type'];
