"use client";

import { createContext, useContext } from "react";

export const WorkspaceFileContext = createContext<((path: string) => void) | null>(null);
export const useWorkspaceFileOpener = () => useContext(WorkspaceFileContext);
