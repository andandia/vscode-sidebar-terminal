import { TerminalInstance, TerminalInfo } from '../types/shared';
import { terminal as log } from '../utils/logger';
import { ActiveTerminalManager } from '../utils/common';
import { ICliAgentDetectionService } from '../interfaces/CliAgentService';

const ENABLE_TERMINAL_DEBUG_LOGS = process.env.SECONDARY_TERMINAL_DEBUG_LOGS === 'true';

/** Handles terminal input/output operations */
export class TerminalIOCoordinator {
  private readonly _debugLoggingEnabled = ENABLE_TERMINAL_DEBUG_LOGS;
  private static readonly MAX_PTY_RETRY_ATTEMPTS = 3;
  private static readonly PTY_RETRY_DELAY_MS = 300;

  // Win32 Input Mode (CSI ? 9001 h) が有効になっているターミナルIDのセット
  private readonly _win32InputModeTerminals = new Set<string>();

  constructor(
    private readonly _terminals: Map<string, TerminalInstance>,
    private readonly _activeTerminalManager: ActiveTerminalManager,
    private readonly _cliAgentService: ICliAgentDetectionService
  ) {}

  private debugLog(...args: unknown[]): void {
    if (this._debugLoggingEnabled) {
      log(...args);
    }
  }

  /**
   * PTYからの出力データを受信し、Win32 Input Modeなどのエスケープシーケンスを監視・更新します
   * @param terminalId ターミナルID
   * @param data PTYからの出力データ
   */
  public notifyPtyOutput(terminalId: string, data: string): void {
    if (!data) {
      return;
    }

    // Win32 Input Mode 有効化シーケンス (CSI ? 9001 h) の検知
    if (data.includes('\x1b[?9001h')) {
      this._win32InputModeTerminals.add(terminalId);
      this.debugLog(`[PTY-INPUT-MODE] Win32 Input Mode enabled for ${terminalId}`);
    }

    // Win32 Input Mode 無効化シーケンス (CSI ? 9001 l) の検知
    if (data.includes('\x1b[?9001l')) {
      this._win32InputModeTerminals.delete(terminalId);
      this.debugLog(`[PTY-INPUT-MODE] Win32 Input Mode disabled for ${terminalId}`);
    }
  }

  /**
   * ターミナル削除時・終了時のクリーンアップ処理
   * @param terminalId ターミナルID
   */
  public cleanupTerminal(terminalId: string): void {
    this._win32InputModeTerminals.delete(terminalId);
  }

  /**
   * PTYへ送信する入力データを環境やモードに応じて適切にフォーマットします
   * Windows ConPTY かつ Win32 Input Mode 有効時、ConPTYがAltキー(Vk=18)に誤変換してしまう
   * 「・」(U+30FB)などの非ASCII文字を明示的なWin32 Inputシーケンスに変換します。
   * @param terminalId ターミナルID
   * @param data 入力データ文字列
   */
  public formatInputForPty(terminalId: string, data: string): string {
    // Windows 以外、または Win32 Input Mode が無効な場合は変換しない
    if (process.platform !== 'win32' || !this._win32InputModeTerminals.has(terminalId)) {
      return data;
    }

    // 既にエスケープシーケンスが含まれている入力（矢印キーや特殊コマンド等）はそのまま渡す
    if (data.includes('\x1b')) {
      return data;
    }

    let formatted = '';
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);
      // 非ASCII文字（全角文字・カタカナ中点など）を明示的なWin32 Inputシーケンスに変換
      // KeyDown: Vk=0, Sc=0, Uc=code, Kd=1, Cs=0, Rc=1
      // KeyUp:   Vk=0, Sc=0, Uc=code, Kd=0, Cs=0, Rc=1
      if (code >= 128) {
        formatted += `\x1b[0;0;${code};1;0;1_\x1b[0;0;${code};0;0;1_`;
      } else {
        formatted += data[i];
      }
    }

    return formatted;
  }

  public sendInput(data: string, terminalId?: string): void {
    const resolvedTerminalId = this.resolveTerminalId(terminalId);
    if (!resolvedTerminalId) {
      return;
    }

    const terminal = this._terminals.get(resolvedTerminalId);
    if (!terminal) {
      return;
    }

    try {
      this._cliAgentService.handleInputChunk(resolvedTerminalId, data);
      // PTY向けに入力データをフォーマット
      const formattedData = this.formatInputForPty(resolvedTerminalId, data);
      const result = this.writeToPtyWithValidation(terminal, formattedData);
      if (!result.success && !this.attemptPtyRecovery(terminal, formattedData)) {
        throw new Error(result.error || 'PTY write failed');
      }
    } catch (error) {
      log(`Error sending input to ${terminal.name}:`, error);
    }
  }

  private resolveTerminalId(terminalId?: string): string | undefined {
    if (terminalId && this._terminals.has(terminalId)) {
      return terminalId;
    }

    const activeId = this._activeTerminalManager.getActive();
    if (activeId && this._terminals.has(activeId)) {
      return activeId;
    }

    const availableTerminals = Array.from(this._terminals.keys());
    return availableTerminals[0];
  }

  public resize(cols: number, rows: number, terminalId?: string): void {
    const id = terminalId || this._activeTerminalManager.getActive();
    if (!id) {
      return;
    }

    const terminal = this._terminals.get(id);
    if (!terminal) {
      return;
    }

    try {
      const result = this.resizePtyWithValidation(terminal, cols, rows);
      if (!result.success) {
        throw new Error(result.error);
      }
    } catch (error) {
      log('Failed to resize terminal:', error);
    }
  }

  public getTerminalInfo(terminalId: string): TerminalInfo | undefined {
    const terminal = this._terminals.get(terminalId);
    if (!terminal) {
      return undefined;
    }
    return {
      id: terminal.id,
      name: terminal.name,
      isActive: terminal.isActive,
      ...(terminal.indicatorColor ? { indicatorColor: terminal.indicatorColor } : {}),
    };
  }

  public writeToTerminal(terminalId: string, data: string): boolean {
    const terminal = this._terminals.get(terminalId);
    if (!terminal) {
      return false;
    }

    try {
      const ptyInstance = terminal.ptyProcess || terminal.pty;
      if (!ptyInstance || typeof ptyInstance.write !== 'function') {
        return false;
      }
      ptyInstance.write(data);
      return true;
    } catch {
      return false;
    }
  }

  public resizeTerminal(terminalId: string, cols: number, rows: number): boolean {
    try {
      this.resize(cols, rows, terminalId);
      return true;
    } catch {
      return false;
    }
  }

  private writeToPtyWithValidation(
    terminal: TerminalInstance,
    data: string,
    retryAttempt: number = 0
  ): { success: boolean; error?: string } {
    const ptyInstance = terminal.ptyProcess || terminal.pty;

    if (!ptyInstance) {
      if (retryAttempt >= TerminalIOCoordinator.MAX_PTY_RETRY_ATTEMPTS) {
        return { success: false, error: `PTY not ready after ${retryAttempt} retries` };
      }

      const delay = TerminalIOCoordinator.PTY_RETRY_DELAY_MS * Math.pow(1.5, retryAttempt);
      setTimeout(() => {
        const updatedTerminal = this._terminals.get(terminal.id);
        if (updatedTerminal) {
          this.writeToPtyWithValidation(updatedTerminal, data, retryAttempt + 1);
        }
      }, delay);

      return { success: false, error: 'PTY not ready, queued for retry' };
    }

    if (typeof ptyInstance.write !== 'function') {
      return { success: false, error: 'PTY missing write method' };
    }

    if (
      terminal.ptyProcess &&
      typeof terminal.ptyProcess === 'object' &&
      'killed' in terminal.ptyProcess &&
      (terminal.ptyProcess as { killed: boolean }).killed
    ) {
      return { success: false, error: 'PTY process killed' };
    }

    try {
      ptyInstance.write(data);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Write failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private attemptPtyRecovery(terminal: TerminalInstance, data: string): boolean {
    // Primary PTY is ptyProcess if available, otherwise pty
    const primary = terminal.ptyProcess;
    // Try alternative PTY instances (excluding the primary that already failed)
    const alternatives = [terminal.ptyProcess, terminal.pty].filter(
      (p): p is NonNullable<typeof p> => p != null && p !== primary
    );

    for (const ptyInstance of alternatives) {
      if (typeof ptyInstance.write === 'function') {
        try {
          ptyInstance.write(data);
          // If we succeeded with terminal.pty, clear the failed ptyProcess
          if (ptyInstance === terminal.pty) {
            terminal.ptyProcess = undefined;
          }
          return true;
        } catch {
          // Try next alternative
        }
      }
    }

    return false;
  }

  private resizePtyWithValidation(
    terminal: TerminalInstance,
    cols: number,
    rows: number
  ): { success: boolean; error?: string } {
    if (cols <= 0 || rows <= 0) {
      return { success: false, error: `Invalid dimensions: ${cols}x${rows}` };
    }

    if (cols > 500 || rows > 200) {
      return { success: false, error: `Dimensions too large: ${cols}x${rows}` };
    }

    const ptyInstance = terminal.ptyProcess || terminal.pty;
    if (!ptyInstance) {
      return { success: false, error: 'No PTY instance' };
    }

    if (typeof ptyInstance.resize !== 'function') {
      return { success: false, error: 'PTY missing resize method' };
    }

    if (
      terminal.ptyProcess &&
      typeof terminal.ptyProcess === 'object' &&
      'killed' in terminal.ptyProcess &&
      (terminal.ptyProcess as { killed: boolean }).killed
    ) {
      return { success: false, error: 'PTY process killed' };
    }

    try {
      ptyInstance.resize(cols, rows);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Resize failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
