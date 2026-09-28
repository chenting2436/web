'use client';

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type XtermConsoleProps = {
  output: string;
  running: boolean;
  onCommand: (command: string) => Promise<void> | void;
};

export function XtermConsole({
  output,
  running,
  onCommand,
}: XtermConsoleProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const outputRef = useRef('');
  const commandRef = useRef(onCommand);
  const runningRef = useRef(running);
  const bufferRef = useRef('');

  useEffect(() => {
    commandRef.current = onCommand;
  }, [onCommand]);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.38,
      scrollback: 2500,
      theme: {
        background: '#050d18',
        foreground: '#dce8f7',
        cursor: '#45d8e7',
        cursorAccent: '#07111d',
        selectionBackground: '#2457a780',
        black: '#07111d',
        red: '#ff7b83',
        green: '#62d59a',
        yellow: '#f6c177',
        blue: '#73a7ff',
        magenta: '#c49bff',
        cyan: '#45d8e7',
        white: '#edf4ff',
        brightBlack: '#72839c',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    terminalRef.current = terminal;
    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(hostRef.current);
    const input = terminal.onData((data) => {
      if (runningRef.current) return;
      if (data === '\r') {
        const command = bufferRef.current.trim();
        terminal.write('\r\n');
        bufferRef.current = '';
        if (command) void commandRef.current(command);
        return;
      }
      if (data === '\u007f') {
        if (!bufferRef.current) return;
        bufferRef.current = bufferRef.current.slice(0, -1);
        terminal.write('\b \b');
        return;
      }
      if (data === '\u0003') {
        bufferRef.current = '';
        terminal.write('^C\r\n');
        return;
      }
      if (data >= ' ' && data !== '\u007f') {
        bufferRef.current += data;
        terminal.write(data);
      }
    });
    return () => {
      input.dispose();
      resize.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (!output.startsWith(outputRef.current)) {
      terminal.clear();
      outputRef.current = '';
    }
    const delta = output.slice(outputRef.current.length);
    if (delta) terminal.write(delta.replace(/\n/g, '\r\n'));
    outputRef.current = output;
  }, [output]);

  return <div className="pylab-xterm" ref={hostRef} aria-label="Python 终端" />;
}
