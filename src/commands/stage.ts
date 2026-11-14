// What the commands need of the stage while it is there: the slide editor in its preview, the
// view's zoom and the editor's own actions. The stage hands them over as it mounts (see
// `useStageCommands`) and takes them back as it goes, so a command never reaches a stage that left.
import { useEffect } from "react";

import type { EditMenuAction } from "../components/EditContextMenu";
import type { AgentInsert } from "../lib/editTools";

/** The stage's part of the commands. */
export interface StageTarget {
  /** Sends a message to the slide editor in the preview. */
  post: (message: Record<string, unknown>) => void;
  /** Does what a choice of the editor's context menu does (see `EditMenuAction`). */
  menuAction: (action: EditMenuAction) => void;
  /** Picks image files to put on the slide. */
  pickImage: (replace: boolean) => void | Promise<void>;
  /** Asks the agent for a table, chart or icon on the slide. */
  askForInsert: (kind: AgentInsert) => void;
  /** Zooms the view by `factor` around its middle. */
  zoomBy: (factor: number) => void;
  /** The whole slide again, centered. */
  resetView: () => void;
}

let target: StageTarget | null = null;

/** The stage, while it is there. */
export const stageTarget = (): StageTarget | null => target;

/** Hands the stage over to the commands for as long as the caller is mounted; its functions should not change. */
export function useStageCommands(stage: StageTarget) {
  const { post, menuAction, pickImage, askForInsert, zoomBy, resetView } = stage;
  useEffect(() => {
    const handed = { post, menuAction, pickImage, askForInsert, zoomBy, resetView };
    target = handed;
    return () => {
      if (target === handed) target = null;
    };
  }, [post, menuAction, pickImage, askForInsert, zoomBy, resetView]);
}

/** Sets the stage directly (for tests). */
export function setStageTarget(stage: StageTarget | null) {
  target = stage;
}
