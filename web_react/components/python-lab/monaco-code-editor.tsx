'use client';

import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor';
import '../../node_modules/monaco-editor/min/vs/editor/editor.main.css';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: () => Worker };
  }
}

type MonacoCodeEditorProps = {
  path: string;
  value: string;
  language?: string;
  compact?: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onRun?: () => void;
  onSave?: () => void;
};

export function MonacoCodeEditor({
  path,
  value,
  language = 'python',
  compact = false,
  readOnly = false,
  onChange,
  onRun,
  onSave,
}: MonacoCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const initialValueRef = useRef(value);
  const changeRef = useRef(onChange);
  const runRef = useRef(onRun);
  const saveRef = useRef(onSave);
  const applyingRef = useRef(false);

  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    runRef.current = onRun;
  }, [onRun]);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    let disposed = false;
    let subscription: Monaco.IDisposable | undefined;
    window.MonacoEnvironment = {
      getWorker: () =>
        new Worker(
          new URL(
            '../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
            import.meta.url,
          ),
          { type: 'module', name: 'skyview-monaco-editor' },
        ),
    };
    void import('monaco-editor').then((monaco) => {
      if (disposed || !hostRef.current) return;
      monaco.editor.defineTheme('skyview-python', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '8193ad', fontStyle: 'italic' },
          { token: 'keyword', foreground: '73a7ff' },
          { token: 'string', foreground: 'a8db8f' },
          { token: 'number', foreground: 'f6c177' },
          { token: 'identifier', foreground: 'e8eef8' },
        ],
        colors: {
          'editor.background': '#081321',
          'editor.foreground': '#e8eef8',
          'editorLineNumber.foreground': '#60708b',
          'editorLineNumber.activeForeground': '#c9d7ed',
          'editorCursor.foreground': '#42d8e8',
          'editor.selectionBackground': '#2457a760',
          'editor.inactiveSelectionBackground': '#1d3b5a80',
          'editor.lineHighlightBackground': '#10243a',
          'editorIndentGuide.background1': '#1d3048',
          'editorIndentGuide.activeBackground1': '#3b5e85',
          'editorWidget.background': '#101d2f',
          'editorWidget.border': '#36506f',
          'input.background': '#0d1b2c',
          'input.foreground': '#f4f7fb',
          focusBorder: '#42d8e8',
        },
      });
      const uri = monaco.Uri.parse(
        `inmemory://skyview/${encodeURIComponent(path)}`,
      );
      const existing = monaco.editor.getModel(uri);
      const model =
        existing ||
        monaco.editor.createModel(initialValueRef.current, language, uri);
      modelRef.current = model;
      const editor = monaco.editor.create(hostRef.current, {
        model,
        theme: 'skyview-python',
        readOnly,
        automaticLayout: true,
        fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
        fontSize: compact ? 13 : 14,
        lineHeight: compact ? 20 : 22,
        minimap: { enabled: !compact },
        padding: { top: compact ? 9 : 14, bottom: compact ? 9 : 14 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        folding: !compact,
        wordWrap: compact ? 'on' : 'off',
        tabSize: 4,
        insertSpaces: true,
        overviewRulerBorder: false,
        fixedOverflowWidgets: true,
        ariaLabel: compact ? 'Notebook 代码单元编辑器' : 'Python 代码编辑器',
      });
      editorRef.current = editor;
      subscription = editor.onDidChangeModelContent(() => {
        if (!applyingRef.current) changeRef.current(editor.getValue());
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
        runRef.current?.(),
      );
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
        saveRef.current?.(),
      );
    });
    return () => {
      disposed = true;
      subscription?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
      modelRef.current?.dispose();
      modelRef.current = null;
    };
  }, [compact, language, path, readOnly]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.getValue() === value) return;
    applyingRef.current = true;
    model.setValue(value);
    applyingRef.current = false;
  }, [value]);

  return <div className="pylab-monaco" ref={hostRef} data-path={path} />;
}
