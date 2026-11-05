import { createSubmissionRouter } from '@goodvibes-jev/engine/terminal-shell/submission-router';
export type { SubmissionRouterInput } from '@goodvibes-jev/engine/terminal-shell/submission-router';
export const routeSubmissionIntent = createSubmissionRouter([
  {
    "commands": [
      "plan"
    ],
    "kind": "plan",
    "label": "plan"
  },
  {
    "commands": [
      "delegate",
      "build",
      "review",
      "wrfc",
      "agents",
      "remote"
    ],
    "kind": "delegation",
    "label": "delegation"
  },
  {
    "commands": [
      "orchestration",
      "tasks",
      "bridge",
      "teleport"
    ],
    "kind": "orchestration",
    "label": "orchestration"
  }
]);
