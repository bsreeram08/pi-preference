import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

function isEditorBorder(line: string): boolean {
  const plain = stripTerminalSequences(line);
  return /^─+$/.test(plain) || /^─── [↑↓] \d+ more /.test(plain);
}

export class ReferenceEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings, {
      paddingX: 2,
      autocompleteMaxVisible: 7,
    });
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 3) return lines;

    const bottomBorder = lines.findIndex((line, index) => index > 0 && isEditorBorder(line));
    if (bottomBorder <= 1) return lines;

    const firstInputLine = lines[1]!;
    const padding = firstInputLine.match(/^ +/)?.[0].length ?? 0;
    if (padding === 0) return lines;

    const prompt = padding >= 2 ? `${this.borderColor("❯")} ` : this.borderColor("❯");
    lines[1] = prompt + firstInputLine.slice(Math.min(2, padding));
    return lines;
  }
}

export default function piLook(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new ReferenceEditor(tui, theme, keybindings),
    );

    ctx.ui.setWorkingIndicator({
      frames: [
        ctx.ui.theme.fg("dim", "·"),
        ctx.ui.theme.fg("muted", "•"),
        ctx.ui.theme.fg("accent", "●"),
        ctx.ui.theme.fg("muted", "•"),
      ],
      intervalMs: 110,
    });
  });
}
