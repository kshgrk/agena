import type { ReactNode } from "react";

export type ChamberComposerAttachment = {
  id: string;
  name: string;
  mimeType: string;
  previewUrl?: string;
};

export type ChamberAutocompleteKind =
  | "command"
  | "skill"
  | "snippet"
  | "mention";

export type ChamberAutocomplete = {
  kind: ChamberAutocompleteKind;
  query: string;
  from: number;
  to: number;
};

export type ChamberComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onAbort?: () => void;
  onNewSession?: () => void;
  onAttachFiles?: (files: readonly File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onAutocomplete?: (trigger: ChamberAutocomplete | null) => void;
  attachments?: readonly ChamberComposerAttachment[];
  placeholder?: string;
  disabled?: boolean;
  running?: boolean;
  uploading?: boolean;
  mobile?: boolean;
  autoFocus?: boolean;
  leadingActions?: ReactNode;
  modelControl?: ReactNode;
  thinkingControl?: ReactNode;
  fastModeIndicator?: ReactNode;
  usage?: ReactNode;
  menuControl?: ReactNode;
  className?: string;
};

export type ChamberComposerHandle = {
  focus: () => void;
};
