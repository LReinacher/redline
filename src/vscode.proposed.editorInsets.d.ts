// Proposed API, copied from microsoft/vscode src/vscode-dts/vscode.proposed.editorInsets.d.ts.
// Stable builds of VS Code and Cursor need `--enable-proposed-api local.redline` (or the
// same key in argv.json), even in extension development mode.

declare module 'vscode' {
  export interface WebviewEditorInset {
    readonly editor: TextEditor;
    readonly line: number;
    readonly height: number;
    readonly webview: Webview;
    readonly onDidDispose: Event<void>;
    dispose(): void;
  }

  export namespace window {
    export function createWebviewTextEditorInset(
      editor: TextEditor,
      line: number,
      height: number,
      options?: WebviewOptions,
    ): WebviewEditorInset;
  }
}
