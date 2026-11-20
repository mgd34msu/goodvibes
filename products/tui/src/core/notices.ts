import { createNoticePublisher } from '@goodvibes/engine/terminal-shell/notice-publication';
export {
  noticeParts,
  type NoticeParts,
  type NoticeOptions,
  type NoticeSink,
} from '@goodvibes/engine/terminal-shell/notice-publication';
export const publishNotice = createNoticePublisher({});
