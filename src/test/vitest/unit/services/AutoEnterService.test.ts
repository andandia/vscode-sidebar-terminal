import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoEnterService } from '../../../../services/AutoEnterService';

describe('AutoEnterService', () => {
  let autoEnterService: AutoEnterService;
  let mockTerminalManager: any;
  let mockVscode: any;
  let activeTerminalId: string | undefined;
  let terminalRemovedListener: ((id: string) => void) | undefined;
  let terminalFocusListener: ((id: string) => void) | undefined;
  let configChangeListener: ((e: any) => void) | undefined;
  let autoEnterInterval = 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    activeTerminalId = 'terminal-1';
    autoEnterInterval = 1000;

    mockTerminalManager = {
      getActiveTerminalId: vi.fn(() => activeTerminalId),
      hasActiveTerminal: vi.fn(() => Boolean(activeTerminalId)),
      writeToTerminal: vi.fn(() => true),
      onTerminalRemoved: vi.fn((listener: (id: string) => void) => {
        terminalRemovedListener = listener;
        return { dispose: vi.fn() };
      }),
      onTerminalFocus: vi.fn((listener: (id: string) => void) => {
        terminalFocusListener = listener;
        return { dispose: vi.fn() };
      }),
    };

    mockVscode = {
      commands: {
        executeCommand: vi.fn(),
      },
      workspace: {
        getConfiguration: vi.fn(() => ({
          get: vi.fn((key: string, defaultValue: any) => {
            if (key === 'autoEnterInterval') {
              return autoEnterInterval;
            }
            return defaultValue;
          }),
        })),
        onDidChangeConfiguration: vi.fn((listener: (e: any) => void) => {
          configChangeListener = listener;
          return { dispose: vi.fn() };
        }),
      },
      window: {
        showWarningMessage: vi.fn(),
      },
    };

    autoEnterService = new AutoEnterService(mockTerminalManager, mockVscode);
  });

  afterEach(() => {
    autoEnterService.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('基本動作: トグルと定期送信', () => {
    it('アクティブなターミナルでトグルをONにすると、定期的にEnter(\\r)が送信される', () => {
      // トグルをONにする
      const isEnabled = autoEnterService.toggleAutoEnter();
      expect(isEnabled).toBe(true);
      expect(autoEnterService.isAutoEnterActive('terminal-1')).toBe(true);

      // 初期状態ではまだ送信されない
      expect(mockTerminalManager.writeToTerminal).not.toHaveBeenCalled();

      // 1000ms経過で1回目のEnter送信
      vi.advanceTimersByTime(1000);
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledTimes(1);
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledWith('terminal-1', '\r');

      // さらに1000ms経過で2回目のEnter送信
      vi.advanceTimersByTime(1000);
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledTimes(2);
    });

    it('トグルを再度実行するとOFFになり、Enter送信が停止する', () => {
      // ONにする
      autoEnterService.toggleAutoEnter();
      vi.advanceTimersByTime(1000);
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledTimes(1);

      // OFFにする
      const isEnabled = autoEnterService.toggleAutoEnter();
      expect(isEnabled).toBe(false);
      expect(autoEnterService.isAutoEnterActive('terminal-1')).toBe(false);

      // 時間が経過しても追加送信されない
      vi.advanceTimersByTime(3000);
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledTimes(1);
    });

    it('アクティブターミナルが存在しない状態でトグルを実行した場合、警告を表示し開始しない', () => {
      activeTerminalId = undefined;
      mockTerminalManager.getActiveTerminalId.mockReturnValue(undefined);
      mockTerminalManager.hasActiveTerminal.mockReturnValue(false);

      const isEnabled = autoEnterService.toggleAutoEnter();
      expect(isEnabled).toBe(false);
      expect(mockVscode.window.showWarningMessage).toHaveBeenCalled();
    });
  });

  describe('マルチタブ対応: 別のタブを選択していてもONのタブに送信される', () => {
    it('タブ1でONにした後、タブ2に切り替えてもタブ1に対してEnterが送信され続ける', () => {
      // タブ1がアクティブの状態でONにする
      autoEnterService.toggleAutoEnter('terminal-1');
      expect(autoEnterService.isAutoEnterActive('terminal-1')).toBe(true);

      // ユーザーがタブ2にフォーカスを切り替える
      activeTerminalId = 'terminal-2';
      if (terminalFocusListener) {
        terminalFocusListener('terminal-2');
      }

      // タブ2のアクティブ状態はOFFであることを確認
      expect(autoEnterService.isAutoEnterActive('terminal-2')).toBe(false);

      // 1000ms経過時、アクティブなタブ2ではなく、ONにしたタブ1にEnterが送信される
      vi.advanceTimersByTime(1000);
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledWith('terminal-1', '\r');
      expect(mockTerminalManager.writeToTerminal).not.toHaveBeenCalledWith('terminal-2', '\r');

      // さらに2000ms経過
      vi.advanceTimersByTime(2000);
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledTimes(3);
    });

    it('複数タブでそれぞれ個別にON/OFFできる', () => {
      // タブ1とタブ2の両方でONにする
      autoEnterService.startAutoEnter('terminal-1');
      autoEnterService.startAutoEnter('terminal-2');

      expect(autoEnterService.isAutoEnterActive('terminal-1')).toBe(true);
      expect(autoEnterService.isAutoEnterActive('terminal-2')).toBe(true);

      // 1000ms経過で両方のターミナルにEnterが送信される
      vi.advanceTimersByTime(1000);
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledWith('terminal-1', '\r');
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledWith('terminal-2', '\r');

      // タブ1のみ停止する
      autoEnterService.stopAutoEnter('terminal-1');
      expect(autoEnterService.isAutoEnterActive('terminal-1')).toBe(false);
      expect(autoEnterService.isAutoEnterActive('terminal-2')).toBe(true);

      mockTerminalManager.writeToTerminal.mockClear();

      // さらに1000ms経過すると、タブ2だけに送信される
      vi.advanceTimersByTime(1000);
      expect(mockTerminalManager.writeToTerminal).not.toHaveBeenCalledWith('terminal-1', '\r');
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledWith('terminal-2', '\r');
    });
  });

  describe('コンテキストキー更新: アクティブタブの状態に応じたトグルUI同期', () => {
    it('アクティブターミナルの状態変更時にVS Codeコンテキストキーが更新される', () => {
      // タブ1でONにする
      autoEnterService.toggleAutoEnter('terminal-1');

      // secondaryTerminal.autoEnterActive が true にセットされる
      expect(mockVscode.commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'secondaryTerminal.autoEnterActive',
        true
      );

      // タブ2（OFFのタブ）に切り替える
      activeTerminalId = 'terminal-2';
      if (terminalFocusListener) {
        terminalFocusListener('terminal-2');
      }

      // 切り替え後、タブ2はOFFなのでコンテキストキーが false に更新される
      expect(mockVscode.commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'secondaryTerminal.autoEnterActive',
        false
      );

      // 再びタブ1に切り替えると true に復帰する
      activeTerminalId = 'terminal-1';
      if (terminalFocusListener) {
        terminalFocusListener('terminal-1');
      }
      expect(mockVscode.commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'secondaryTerminal.autoEnterActive',
        true
      );
    });
  });

  describe('ターミナル削除時の自動クリーンアップ', () => {
    it('ターミナルが閉じられたら、そのターミナルのAuto-Enterタイマーが自動解除される', () => {
      autoEnterService.startAutoEnter('terminal-1');
      expect(autoEnterService.isAutoEnterActive('terminal-1')).toBe(true);

      // ターミナル1が削除されたイベントを発火
      if (terminalRemovedListener) {
        terminalRemovedListener('terminal-1');
      }

      // タイマーが解除されていることを確認
      expect(autoEnterService.isAutoEnterActive('terminal-1')).toBe(false);

      // 時間が経過しても送信されない
      vi.advanceTimersByTime(2000);
      expect(mockTerminalManager.writeToTerminal).not.toHaveBeenCalled();
    });
  });

  describe('設定変更の動的反映', () => {
    it('設定でインターバルが変更された場合、実行中のタイマー間隔が更新される', () => {
      autoEnterService.startAutoEnter('terminal-1');

      // 500ms経過（まだ送信されない）
      vi.advanceTimersByTime(500);
      expect(mockTerminalManager.writeToTerminal).not.toHaveBeenCalled();

      // 設定を500msに変更
      autoEnterInterval = 500;
      if (configChangeListener) {
        configChangeListener({
          affectsConfiguration: (section: string) =>
            section === 'secondaryTerminal.autoEnterInterval' || section === 'secondaryTerminal',
        });
      }

      // 新しい間隔500msで動作することを確認
      vi.advanceTimersByTime(500);
      expect(mockTerminalManager.writeToTerminal).toHaveBeenCalledTimes(1);
    });

    it('設定値が無効（最小値未満など）の場合はデフォルト値(1000ms)にフォールバックする', () => {
      autoEnterInterval = -100;
      expect(autoEnterService.getInterval()).toBe(1000);
    });
  });

  describe('破棄処理', () => {
    it('dispose実行時にすべてのタイマーが解除され、コンテキストキーもfalseになる', () => {
      autoEnterService.startAutoEnter('terminal-1');
      autoEnterService.startAutoEnter('terminal-2');

      autoEnterService.dispose();

      expect(autoEnterService.isAutoEnterActive('terminal-1')).toBe(false);
      expect(autoEnterService.isAutoEnterActive('terminal-2')).toBe(false);
      expect(autoEnterService.getActiveAutoEnterTerminalIds()).toHaveLength(0);

      vi.advanceTimersByTime(2000);
      expect(mockTerminalManager.writeToTerminal).not.toHaveBeenCalled();
    });
  });
});
