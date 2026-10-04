import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TerminalIOCoordinator } from '../../../../terminals/TerminalIOCoordinator';
import { TerminalInstance } from '../../../../types/shared';
import { ActiveTerminalManager } from '../../../../utils/common';
import { ICliAgentDetectionService } from '../../../../interfaces/CliAgentService';

describe('Win32 Input Mode Handling for TerminalIOCoordinator', () => {
  let terminals: Map<string, TerminalInstance>;
  let activeTerminalManager: ActiveTerminalManager;
  let cliAgentService: ICliAgentDetectionService;
  let coordinator: TerminalIOCoordinator;
  let mockPtyProcess: { write: ReturnType<typeof vi.fn> };
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    mockPtyProcess = { write: vi.fn() };
    terminals = new Map();
    const terminal: TerminalInstance = {
      id: 'term-1',
      name: 'Terminal 1',
      isActive: true,
      ptyProcess: mockPtyProcess as any,
    };
    terminals.set('term-1', terminal);

    activeTerminalManager = {
      getActive: vi.fn().mockReturnValue('term-1'),
    } as unknown as ActiveTerminalManager;

    cliAgentService = {
      handleInputChunk: vi.fn(),
    } as unknown as ICliAgentDetectionService;

    coordinator = new TerminalIOCoordinator(terminals, activeTerminalManager, cliAgentService);

    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  const setPlatform = (platform: string) => {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  };

  it('Win32 Input Modeが無効な場合、入力はそのままPtyに渡されること', () => {
    setPlatform('win32');
    coordinator.sendInput('・', 'term-1');
    expect(mockPtyProcess.write).toHaveBeenCalledWith('・');
  });

  it('非Windows環境では、Win32 Input Modeが有効でも変換されないこと', () => {
    setPlatform('darwin');
    coordinator.notifyPtyOutput('term-1', '\x1b[?9001h');
    coordinator.sendInput('・', 'term-1');
    expect(mockPtyProcess.write).toHaveBeenCalledWith('・');
  });

  it('Windows環境でWin32 Input Modeが有効な場合、「・」がWin32 Inputシーケンスに変換されること', () => {
    setPlatform('win32');
    // agyなどが送信するCSI ? 9001 hを検知
    coordinator.notifyPtyOutput('term-1', '\x1b[?9001h');

    coordinator.sendInput('・', 'term-1');

    // U+30FB = 12539
    const expectedSequence = '\x1b[0;0;12539;1;0;1_\x1b[0;0;12539;0;0;1_';
    expect(mockPtyProcess.write).toHaveBeenCalledWith(expectedSequence);
  });

  it('Windows環境でWin32 Input Modeが有効な場合、日本語とASCII混在文字列が正しく変換されること', () => {
    setPlatform('win32');
    coordinator.notifyPtyOutput('term-1', '\x1b[?9001h');

    coordinator.sendInput('・テスト\r', 'term-1');

    // 「・」= 12539, 「テ」= 12486, 「ス」= 12473, 「ト」= 12488, \rはそのまま
    const dot = '\x1b[0;0;12539;1;0;1_\x1b[0;0;12539;0;0;1_';
    const te = '\x1b[0;0;12486;1;0;1_\x1b[0;0;12486;0;0;1_';
    const su = '\x1b[0;0;12473;1;0;1_\x1b[0;0;12473;0;0;1_';
    const to = '\x1b[0;0;12488;1;0;1_\x1b[0;0;12488;0;0;1_';
    expect(mockPtyProcess.write).toHaveBeenCalledWith(`${dot}${te}${su}${to}\r`);
  });

  it('エスケープシーケンスが含まれている入力は変換されずにそのまま渡されること', () => {
    setPlatform('win32');
    coordinator.notifyPtyOutput('term-1', '\x1b[?9001h');

    // 矢印キー上 (\x1b[A)
    coordinator.sendInput('\x1b[A', 'term-1');
    expect(mockPtyProcess.write).toHaveBeenCalledWith('\x1b[A');
  });

  it('Win32 Input Mode解除シーケンス(CSI ? 9001 l)を受信した後は通常の送信に戻ること', () => {
    setPlatform('win32');
    coordinator.notifyPtyOutput('term-1', '\x1b[?9001h');
    coordinator.notifyPtyOutput('term-1', '\x1b[?9001l');

    coordinator.sendInput('・', 'term-1');
    expect(mockPtyProcess.write).toHaveBeenCalledWith('・');
  });
});
