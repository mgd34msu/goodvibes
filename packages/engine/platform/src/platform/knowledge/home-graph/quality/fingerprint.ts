/** Read compatibility only. A stored digest cannot establish whether current
 * meaning changed, so a format upgrade cannot remove explicit review authority. */
import type { KnowledgeIssueRecord } from '../../types.js';
import { readRecord } from '../helpers.js';
export function preserveLegacyQualityAuthority(issue: KnowledgeIssueRecord | undefined): boolean {
  return Boolean(issue && (issue.metadata.homeGraphQualityRevisionVersion !== 1 || issue.metadata.qualitySubjectState === null)
    && (issue.status === 'resolved' || typeof readRecord(issue.metadata.review).action === 'string'));
}
