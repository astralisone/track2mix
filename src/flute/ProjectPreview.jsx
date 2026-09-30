"use client";
import React from "react";
import { ProjectPreview } from "@webprodigies/flute/preview";
import { sceneModules } from "./catalog";
// Host-owned development flag: no process, Vite or Electron globals in this adapter.
export function FluteProjectPreview({ children, enabled, active, ...props }) {
  if (!enabled) return children;
  return <ProjectPreview {...props} projectId="34a57929-b980-49ab-be76-55b25944666a" enabled={enabled} active={active} sceneModules={sceneModules}>{children}</ProjectPreview>;
}
