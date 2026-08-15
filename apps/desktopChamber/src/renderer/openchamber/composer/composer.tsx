import {
  ArrowUp,
  ImagePlus,
  LoaderCircle,
  Plus,
  Square,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { clipboardFiles, hasFiles } from "./attachments.ts";
import { ChamberComposerEditor, type ChamberEditorHandle } from "./editor.tsx";
import type { ChamberComposerHandle, ChamberComposerProps } from "./types.ts";
import "./composer.css";

export const ChamberComposer = forwardRef<
  ChamberComposerHandle,
  ChamberComposerProps
>(function ChamberComposer(props, forwardedRef) {
  const {
    value,
    onChange,
    onSubmit,
    onAbort,
    onNewSession,
    onAttachFiles,
    onRemoveAttachment,
    onAutocomplete,
    attachments = [],
    placeholder = "Prompt the agent…",
    disabled = false,
    running = false,
    uploading = false,
    mobile = false,
    autoFocus = false,
    leadingActions,
    modelControl,
    thinkingControl,
    fastModeIndicator,
    usage,
    menuControl,
    className,
  } = props;
  const editorRef = useRef<ChamberEditorHandle | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [mobileExpanded, setMobileExpanded] = useState(!mobile);
  const [dragging, setDragging] = useState(false);
  const canSend =
    !disabled &&
    !uploading &&
    (value.trim().length > 0 || attachments.length > 0);
  useImperativeHandle(
    forwardedRef,
    () => ({ focus: () => editorRef.current?.focus() }),
    [],
  );

  const attach = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) onAttachFiles?.(files);
    event.target.value = "";
  };
  const expandMobile = () => {
    setMobileExpanded(true);
    requestAnimationFrame(() =>
      editorRef.current?.focus({ preventScroll: true }),
    );
  };
  const onDrag = (event: DragEvent<HTMLFieldSetElement>) => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (
      event.type === "dragleave" &&
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setDragging(event.type !== "dragleave" && event.type !== "drop");
    if (event.type === "drop") {
      const files = clipboardFiles(event.dataTransfer);
      if (files.length > 0) onAttachFiles?.(files);
    }
  };

  if (mobile && !mobileExpanded) {
    return (
      <div className={`chamber-mobile-composer-row ${className ?? ""}`}>
        <div className="chamber-mobile-pill-shell">
          <button
            className="chamber-mobile-pill"
            type="button"
            onClick={expandMobile}
            aria-label="Open message composer"
          >
            <ImagePlus aria-hidden="true" />
            <span className={value.trim() ? "" : "is-placeholder"}>
              {value.trim() || placeholder}
            </span>
          </button>
          {running ? (
            <button
              className="chamber-mobile-pill-stop"
              type="button"
              onClick={onAbort}
              disabled={!onAbort}
              aria-label="Stop generating"
            >
              <Square aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {usage}
        {onNewSession ? (
          <button
            className="chamber-mobile-new"
            type="button"
            onClick={onNewSession}
            aria-label="New session"
          >
            <Plus aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <fieldset
      className={`chamber-composer ${mobile ? "is-mobile" : ""} ${dragging ? "is-dragging" : ""} ${className ?? ""}`}
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={onDrag}
      onDrop={onDrag}
      data-composer-bound="true"
      aria-label="Message composer"
    >
      <input
        ref={inputRef}
        className="chamber-composer-file-input"
        type="file"
        multiple
        accept="image/*"
        onChange={attach}
        tabIndex={-1}
      />

      {attachments.length > 0 ? (
        <div className="chamber-composer-attachments">
          {attachments.map((attachment) => (
            <div className="chamber-composer-attachment" key={attachment.id}>
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" />
              ) : (
                <ImagePlus aria-hidden="true" />
              )}
              <span>{attachment.name}</span>
              <button
                type="button"
                onClick={() => onRemoveAttachment?.(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <ChamberComposerEditor
        ref={editorRef}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onAttachFiles={onAttachFiles}
        onAutocomplete={onAutocomplete}
        placeholder={placeholder}
        disabled={disabled}
        mobile={mobile}
        autoFocus={autoFocus || (mobile && mobileExpanded)}
      />

      <div className="chamber-composer-footer">
        <div className="chamber-composer-footer-start">
          <button
            className="chamber-composer-icon-button"
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || uploading}
            aria-label="Attach image"
          >
            {uploading ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : (
              <Plus aria-hidden="true" />
            )}
          </button>
          {leadingActions}
        </div>

        <div className="chamber-composer-footer-end">
          {fastModeIndicator}
          {modelControl}
          {thinkingControl}
          {usage}
          {menuControl}
          {running ? (
            <button
              className="chamber-composer-primary is-stop"
              type="button"
              onClick={onAbort}
              disabled={!onAbort}
              aria-label="Stop generating"
            >
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button
              className="chamber-composer-primary"
              type="button"
              onClick={onSubmit}
              disabled={!canSend}
              aria-label="Send message"
            >
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {dragging ? (
        <div className="chamber-composer-drop-target">
          Drop images to attach
        </div>
      ) : null}
    </fieldset>
  );
});
