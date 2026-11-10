import type { WorkspaceInfo } from "../lib/api";
import { basename } from "../lib/utils";

/** `absolute` relative to the workspace folder, `/`-separated; null when outside it. */
export function relativePath(workspace: WorkspaceInfo | null, absolute: string): string | null {
  if (!workspace) return null;
  const root = workspace.path.replaceAll("\\", "/").replace(/\/$/, "");
  const path = absolute.replaceAll("\\", "/");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/** How the app names the file at `absolute`: by its workspace-relative path, or its name when outside the workspace. */
export function workspaceName(workspace: WorkspaceInfo | null, absolute: string): string {
  return relativePath(workspace, absolute) ?? basename(absolute);
}
