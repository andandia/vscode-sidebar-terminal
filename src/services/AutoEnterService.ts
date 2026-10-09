import * as vscode from 'vscode';
import { TerminalManager } from '../terminals/TerminalManager';
import { extension as log } from '../utils/logger';

/**
 * ターミナルごとの自動Enter送信タイマーを管理するサービス
 * - 指定したターミナルに対して設定された間隔でEnter(\r)を定期送信
 * - 別タブが選択されていても、ONになっているターミナルに対して送信を継続
 * - VS Codeのコンテキストキーと連携してトグルボタン表示を同期
 */
export class AutoEnterService {
  /** デフォルトの送信間隔（ミリ秒） */
  public static readonly DEFAULT_INTERVAL_MS = 1000;
  /** 最小の送信間隔（ミリ秒） */
  public static readonly MIN_INTERVAL_MS = 100;
  /** コンテキストキー名 */
  public static readonly CONTEXT_KEY = 'secondaryTerminal.autoEnterActive';

  /** ターミナルIDごとのタイマー保持マップ */
  private readonly _timers = new Map<string, NodeJS.Timeout>();
  /** イベントリスナー等の破棄用ディスポーザブル一覧 */
  private readonly _disposables: vscode.Disposable[] = [];
  /** 現在のアクティブターミナルID（コンテキストキー追従用） */
  private _currentActiveTerminalId: string | undefined;

  constructor(
    private readonly _terminalManager: TerminalManager,
    private readonly _vscodeContext: typeof vscode = vscode
  ) {
    this._currentActiveTerminalId = this._terminalManager?.getActiveTerminalId?.();

    // ターミナル削除時のタイマークリーンアップを購読
    if (this._terminalManager?.onTerminalRemoved) {
      const removeDisposable = this._terminalManager.onTerminalRemoved((terminalId: string) => {
        this.handleTerminalRemoved(terminalId);
      });
      if (removeDisposable) {
        this._disposables.push(removeDisposable);
      }
    }

    // ターミナルフォーカス切り替え時のコンテキストキー更新を購読
    if (this._terminalManager?.onTerminalFocus) {
      const focusDisposable = this._terminalManager.onTerminalFocus((terminalId: string) => {
        this.handleTerminalFocus(terminalId);
      });
      if (focusDisposable) {
        this._disposables.push(focusDisposable);
      }
    }

    // 設定変更時のタイマー間隔更新を購読
    try {
      if (this._vscodeContext?.workspace?.onDidChangeConfiguration) {
        // eslint-disable-next-line no-restricted-syntax
        const configDisposable = this._vscodeContext.workspace.onDidChangeConfiguration(
          (event: vscode.ConfigurationChangeEvent) => {
            if (event?.affectsConfiguration?.('secondaryTerminal.autoEnterInterval')) {
              this.handleConfigurationChanged();
            }
          }
        );
        if (configDisposable) {
          this._disposables.push(configDisposable);
        }
      }
    } catch {
      // モック環境などでworkspaceが存在しない場合は無視
    }

    // 初期コンテキストキー状態を設定
    this.updateContextKey();
  }

  /**
   * 設定から自動送信の間隔（ミリ秒）を取得
   */
  public getInterval(): number {
    try {
      const config = this._vscodeContext?.workspace?.getConfiguration?.('secondaryTerminal');
      const interval = config?.get<number>(
        'autoEnterInterval',
        AutoEnterService.DEFAULT_INTERVAL_MS
      );

      if (
        typeof interval !== 'number' ||
        isNaN(interval) ||
        interval < AutoEnterService.MIN_INTERVAL_MS
      ) {
        return AutoEnterService.DEFAULT_INTERVAL_MS;
      }

      return interval;
    } catch {
      return AutoEnterService.DEFAULT_INTERVAL_MS;
    }
  }

  /**
   * 指定ターミナル（省略時は現在のアクティブターミナル）の自動送信をトグル切り替え
   * @param terminalId 対象ターミナルID
   * @returns 有効化された場合は true、無効化された場合は false
   */
  public toggleAutoEnter(terminalId?: string): boolean {
    const targetId = terminalId || this._terminalManager.getActiveTerminalId();

    if (!targetId) {
      this._vscodeContext.window.showWarningMessage(
        'アクティブなターミナルが見つかりません。まずターミナルを開いてください。'
      );
      return false;
    }

    if (this.isAutoEnterActive(targetId)) {
      this.stopAutoEnter(targetId);
      return false;
    } else {
      this.startAutoEnter(targetId);
      return true;
    }
  }

  /**
   * 指定したターミナルの自動Enter送信を開始
   * @param terminalId 対象ターミナルID
   */
  public startAutoEnter(terminalId: string): void {
    // 既存タイマーがあれば二重起動を防ぐためクリア
    if (this._timers.has(terminalId)) {
      this.clearTimer(terminalId);
    }

    const interval = this.getInterval();

    // eslint-disable-next-line no-restricted-syntax
    const timer = setInterval(() => {
      this.sendEnterToTerminal(terminalId);
    }, interval);

    this._timers.set(terminalId, timer);
    log(`[AutoEnter] Started auto-enter for terminal: ${terminalId} (interval: ${interval}ms)`);

    // ステータスバーに開始通知を表示
    try {
      const terminal = this._terminalManager?.getTerminal?.(terminalId);
      const name = terminal?.name || terminalId;
      const sec = interval >= 1000 ? `${interval / 1000}s` : `${interval}ms`;
      this._vscodeContext?.window?.setStatusBarMessage?.(
        `$(play) Auto Enter: 有効化 [${name}] (${sec}ごと)`,
        3000
      );
    } catch {
      // 無視
    }

    this.updateContextKey();
  }

  /**
   * 指定したターミナルの自動Enter送信を停止
   * @param terminalId 対象ターミナルID
   */
  public stopAutoEnter(terminalId: string): void {
    if (this._timers.has(terminalId)) {
      this.clearTimer(terminalId);
      log(`[AutoEnter] Stopped auto-enter for terminal: ${terminalId}`);

      // ステータスバーに停止通知を表示
      try {
        const terminal = this._terminalManager?.getTerminal?.(terminalId);
        const name = terminal?.name || terminalId;
        this._vscodeContext?.window?.setStatusBarMessage?.(
          `$(debug-pause) Auto Enter: 停止 [${name}]`,
          3000
        );
      } catch {
        // 無視
      }
    }

    this.updateContextKey();
  }

  /**
   * 指定したターミナル（省略時はアクティブターミナル）で自動送信が動作中か判定
   * @param terminalId 対象ターミナルID
   */
  public isAutoEnterActive(terminalId?: string): boolean {
    const targetId = terminalId || this._terminalManager.getActiveTerminalId();
    if (!targetId) {
      return false;
    }
    return this._timers.has(targetId);
  }

  /**
   * 現在自動送信が動作しているすべてのターミナルID一覧を取得
   */
  public getActiveAutoEnterTerminalIds(): string[] {
    return Array.from(this._timers.keys());
  }

  /**
   * ターミナルへEnterキー(\r)を送信
   * @param terminalId 対象ターミナルID
   */
  private sendEnterToTerminal(terminalId: string): void {
    // ターミナルが存在するか確認し、直接送信
    const terminal = this._terminalManager.getTerminal?.(terminalId);
    // 該当ターミナルがなければタイマー停止
    if (!terminal) {
      log(`[AutoEnter] Terminal not found: ${terminalId}, stopping timer.`);
      this.stopAutoEnter(terminalId);
      return;
    }

    const success = this._terminalManager.writeToTerminal(terminalId, '\r');
    if (!success) {
      log(`[AutoEnter] Failed to write Enter to terminal: ${terminalId}`);
    }
  }

  /**
   * ターミナル削除時の処理
   * @param terminalId 削除されたターミナルID
   */
  private handleTerminalRemoved(terminalId: string): void {
    if (this._timers.has(terminalId)) {
      this.clearTimer(terminalId);
      log(`[AutoEnter] Cleaned up auto-enter timer for removed terminal: ${terminalId}`);
    }
    this.updateContextKey();
  }

  /**
   * ターミナルフォーカス変更時の処理
   * @param terminalId フォーカスされたターミナルID
   */
  private handleTerminalFocus(terminalId: string): void {
    this._currentActiveTerminalId = terminalId;
    this.updateContextKey();
  }

  /**
   * 設定変更時の処理（実行中タイマーの間隔を再設定）
   */
  private handleConfigurationChanged(): void {
    const activeIds = this.getActiveAutoEnterTerminalIds();
    if (activeIds.length === 0) {
      return;
    }

    log(`[AutoEnter] Configuration changed, restarting ${activeIds.length} active timers.`);
    for (const id of activeIds) {
      this.startAutoEnter(id);
    }
  }

  /**
   * タイマーをクリア
   * @param terminalId 対象ターミナルID
   */
  private clearTimer(terminalId: string): void {
    const timer = this._timers.get(terminalId);
    if (timer) {
      clearInterval(timer);
      this._timers.delete(terminalId);
    }
  }

  /**
   * アクティブターミナルの状態に応じてVS Codeコンテキストキーを更新
   */
  private updateContextKey(): void {
    try {
      const activeId = this._terminalManager?.getActiveTerminalId?.();
      const isActive = activeId ? this._timers.has(activeId) : false;

      this._vscodeContext?.commands?.executeCommand?.(
        'setContext',
        AutoEnterService.CONTEXT_KEY,
        isActive
      );
    } catch {
      // モック環境などでcommandsが存在しない場合は無視
    }
  }

  /**
   * サービス破棄時のクリーンアップ
   */
  public dispose(): void {
    for (const [terminalId] of this._timers) {
      this.clearTimer(terminalId);
    }
    this._timers.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables.length = 0;

    try {
      this._vscodeContext?.commands?.executeCommand?.(
        'setContext',
        AutoEnterService.CONTEXT_KEY,
        false
      );
    } catch {
      // モック環境などでcommandsが存在しない場合は無視
    }
  }
}
