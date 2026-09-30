/**
 * Types for the JSX wrapper that `flute init` generates. It ships without
 * declarations, and this project compiles with `strict`, so the shape is
 * stated here rather than loosening the compiler for everything else.
 */
import type { ReactNode } from "react";

export declare function FluteProjectPreview(props: {
  children?: ReactNode;
  enabled?: boolean;
  active?: boolean;
}): JSX.Element;
