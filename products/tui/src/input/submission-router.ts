import { createSubmissionRouter } from '@goodvibes-jev/engine/terminal-shell/submission-router';
export type { SubmissionRouterInput } from '@goodvibes-jev/engine/terminal-shell/submission-router';
export const routeSubmissionIntent = createSubmissionRouter([
  {
    "commands": [
      "project-plan",
      "planning"
    ],
    "kind": "plan",
    "label": "plan"
  },
  {
    "commands": [
      "review"
    ],
    "kind": "review",
    "label": "review"
  },
  {
    "commands": [
      "panel"
    ],
    "kind": "view-action",
    "label": "open view"
  },
  {
    "commands": [
      "wrfc",
      "orchestration",
      "teamwork",
      "tasks",
      "agents",
      "remote",
      "bridge",
      "teleport",
      "sandbox"
    ],
    "kind": "orchestration",
    "label": "orchestration"
  }
]);
