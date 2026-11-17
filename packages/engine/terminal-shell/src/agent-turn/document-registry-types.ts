export type AgentDocumentStatus = 'draft' | 'reviewed' | 'archived';
export type AgentDocumentCommentStatus = 'open' | 'resolved';
export type AgentDocumentSuggestionStatus = 'proposed' | 'accepted' | 'rejected';

export interface AgentDocumentVersion {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface AgentDocumentComment {
  readonly id: string;
  readonly body: string;
  readonly status: AgentDocumentCommentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string | undefined;
}

export interface AgentDocumentSuggestion {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  /** The document version the suggestion was written against; accepting it over a later version is refused. */
  readonly baseVersionId?: string | undefined;
  readonly documentStatus?: AgentDocumentStatus | undefined;
  readonly summary: string;
  readonly rationale: string;
  readonly status: AgentDocumentSuggestionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string | undefined;
}

export interface AgentDocumentAttachment {
  readonly id: string;
  readonly artifactId: string;
  readonly label: string;
  readonly note?: string | undefined;
  readonly filename?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly kind?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentDocumentRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly status: AgentDocumentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The newest version. The retained history is read separately (`AgentDocumentRegistry.versions`). */
  readonly versions: readonly AgentDocumentVersion[];
  /** How many versions are retained. */
  readonly versionCount: number;
  readonly comments: readonly AgentDocumentComment[];
  readonly suggestions: readonly AgentDocumentSuggestion[];
  readonly attachments: readonly AgentDocumentAttachment[];
  readonly lastArtifactId?: string | undefined;
}

export interface AgentDocumentCreateInput {
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[] | undefined;
  readonly summary?: string | undefined;
}

export interface AgentDocumentUpdateInput {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly summary?: string | undefined;
  readonly status?: AgentDocumentStatus | undefined;
  readonly lastArtifactId?: string | undefined;
}

export interface AgentDocumentCommentInput {
  readonly body: string;
}

export interface AgentDocumentSuggestionInput {
  readonly title?: string | undefined;
  readonly body: string;
  readonly tags?: readonly string[] | undefined;
  readonly status?: AgentDocumentStatus | undefined;
  readonly summary?: string | undefined;
  readonly rationale?: string | undefined;
}

export interface AgentDocumentAttachmentInput {
  readonly artifactId: string;
  readonly label?: string | undefined;
  readonly note?: string | undefined;
  readonly filename?: string | undefined;
  readonly mimeType?: string | undefined;
  readonly kind?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface AgentDocumentSnapshot {
  readonly path: string;
  readonly documents: readonly AgentDocumentRecord[];
}
