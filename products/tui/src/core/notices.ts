import { createNoticePublisher } from '@goodvibes-jev/engine/terminal-shell/notice-publication';
export {
  noticeParts,
  type NoticeParts,
  type NoticeOptions,
  type NoticeSink,
} from '@goodvibes-jev/engine/terminal-shell/notice-publication';
export const publishNotice = createNoticePublisher({
  severity: 'notice',
  screenBeforeLocalPublication: true,
  retainOnDecorationError: false,
});
