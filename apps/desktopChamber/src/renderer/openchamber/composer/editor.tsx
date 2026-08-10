import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import {
  Compartment,
  EditorState,
  type Extension,
  Prec,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
} from "@codemirror/view";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { clipboardFiles } from "./attachments.ts";
import { shouldSubmitComposerKey } from "./keyboard.ts";
import { composerTokens, resolveComposerAutocomplete } from "./language.ts";

export type ChamberEditorHandle = {
  focus: (options?: FocusOptions) => void;
  insertText: (text: string) => void;
};

type ChamberEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onAttachFiles?: ((files: readonly File[]) => void) | undefined;
  onAutocomplete?:
    | ((trigger: ReturnType<typeof resolveComposerAutocomplete>) => void)
    | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  mobile?: boolean | undefined;
  autoFocus?: boolean | undefined;
};

function tokenDecorations(state: EditorState): DecorationSet {
  return Decoration.set(
    composerTokens(state.doc.toString()).map((token) =>
      Decoration.mark({ class: `chamber-composer-token-${token.kind}` }).range(
        token.from,
        token.to,
      ),
    ),
  );
}

const promptLanguage = StateField.define<DecorationSet>({
  create: tokenDecorations,
  update(value, transaction) {
    return transaction.docChanged ? tokenDecorations(transaction.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    minHeight: "100%",
    padding: "0",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    caretColor: "var(--fg)",
  },
  ".cm-line": { padding: "0" },
  ".cm-scroller": {
    overflowX: "hidden",
    fontFamily: "inherit",
    lineHeight: "inherit",
  },
  ".cm-placeholder": { color: "var(--fg-muted)" },
  ".cm-selectionBackground": {
    background: "color-mix(in srgb, var(--accent) 24%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
});

const editableCompartment = new Compartment();

export const ChamberComposerEditor = forwardRef<
  ChamberEditorHandle,
  ChamberEditorProps
>(function ChamberComposerEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handlersRef = useRef(props);
  handlersRef.current = props;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const intercept = Prec.highest(
      keymap.of([
        {
          any: (_view, event) => {
            const current = handlersRef.current;
            if (!shouldSubmitComposerKey(event, current.mobile ?? false))
              return false;
            event.preventDefault();
            if (!current.disabled && current.value.trim()) current.onSubmit();
            return true;
          },
        },
      ]),
    );

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: handlersRef.current.value,
        extensions: [
          history(),
          EditorView.lineWrapping,
          intercept,
          keymap.of([...standardKeymap, ...historyKeymap]),
          promptLanguage,
          editorTheme,
          placeholder(handlersRef.current.placeholder ?? "Prompt the agent…"),
          editableCompartment.of(
            EditorView.editable.of(!handlersRef.current.disabled),
          ),
          EditorView.contentAttributes.of({
            "aria-label": "Message",
            spellcheck: "true",
            autocorrect: "on",
            autocapitalize: "sentences",
          }),
          EditorView.updateListener.of((update) => {
            const current = handlersRef.current;
            if (update.docChanged) {
              const next = update.state.doc.toString();
              current.onChange(next);
            }
            if (update.docChanged || update.selectionSet) {
              current.onAutocomplete?.(
                resolveComposerAutocomplete(
                  update.state.doc.toString(),
                  update.state.selection.main.head,
                ),
              );
            }
          }),
          EditorView.domEventHandlers({
            paste: (event) => {
              const files = clipboardFiles(event.clipboardData);
              if (files.length === 0) return false;
              event.preventDefault();
              handlersRef.current.onAttachFiles?.(files);
              return true;
            },
          }),
        ] satisfies Extension[],
      }),
    });
    viewRef.current = view;
    if (handlersRef.current.autoFocus) {
      requestAnimationFrame(() => view.focus());
    }
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === props.value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: props.value },
      selection: { anchor: props.value.length },
    });
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    });
  }, [props.value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableCompartment.reconfigure(
        EditorView.editable.of(!props.disabled),
      ),
    });
  }, [props.disabled]);

  useImperativeHandle(ref, () => ({
    focus(options) {
      viewRef.current?.contentDOM.focus(options);
    },
    insertText(text) {
      const view = viewRef.current;
      if (!view || !text) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: "input.type",
      });
    },
  }));

  return <div className="chamber-composer-editor" ref={hostRef} />;
});
