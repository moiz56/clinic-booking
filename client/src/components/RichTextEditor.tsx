interface Props {
  defaultValue: string; // initial HTML — this is an uncontrolled component
  onChange: (html: string) => void;
  placeholder?: string;
  rows?: number;
}

const COMMANDS: { cmd: string; label: string; title: string }[] = [
  { cmd: 'bold', label: 'B', title: 'Bold' },
  { cmd: 'italic', label: 'I', title: 'Italic' },
  { cmd: 'underline', label: 'U', title: 'Underline' },
  { cmd: 'insertUnorderedList', label: '•', title: 'Bullet list' },
  { cmd: 'insertOrderedList', label: '1.', title: 'Numbered list' },
];

/**
 * A minimal contentEditable rich-text box (bold/italic/underline/lists) —
 * no editor dependency, matching the rest of the app's hand-rolled UI.
 * Uncontrolled (like a native <textarea defaultValue>) since contentEditable
 * fights React's controlled-value model (cursor jumps on every re-render).
 * Pass a `key` at the call site to force a remount when switching what's
 * being edited (e.g. key={service.id}).
 *
 * Stores/returns HTML; the server sanitizes it to a strict tag allowlist
 * before persisting, since it's rendered back on the public booking page.
 */
export default function RichTextEditor({ defaultValue, onChange, placeholder, rows = 3 }: Props) {
  function exec(e: React.MouseEvent, cmd: string) {
    const editor = e.currentTarget.closest('.rte')?.querySelector<HTMLDivElement>('.rte-editor');
    editor?.focus();
    document.execCommand(cmd);
    if (editor) onChange(editor.innerHTML);
  }

  return (
    <div className="rte">
      <div className="rte-toolbar">
        {COMMANDS.map((c) => (
          <button
            key={c.cmd}
            type="button"
            className="btn btn-ghost btn-xs"
            title={c.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => exec(e, c.cmd)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div
        className="rte-editor rich-text"
        contentEditable
        data-placeholder={placeholder}
        style={{ minHeight: `${rows * 1.5}em` }}
        dangerouslySetInnerHTML={{ __html: defaultValue }}
        onInput={(e) => onChange(e.currentTarget.innerHTML)}
      />
    </div>
  );
}
