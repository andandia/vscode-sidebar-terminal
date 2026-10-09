import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  CommandRegistrar,
  CommandRegistrarDeps,
  SessionCommandHandlers,
} from '../../../../core/CommandRegistrar';
import { AutoEnterService } from '../../../../services/AutoEnterService';

describe('CommandRegistrar - AutoEnter Commands', () => {
  let commandRegistrar: CommandRegistrar;
  let mockDeps: CommandRegistrarDeps;
  let mockSessionHandlers: SessionCommandHandlers;
  let mockAutoEnterService: {
    toggleAutoEnter: ReturnType<typeof vi.fn>;
  };
  let registeredCommands: Map<string, (...args: any[]) => Promise<any>>;
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    registeredCommands = new Map();

    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation(
      (command: string, callback: (...args: any[]) => any) => {
        registeredCommands.set(command, callback);
        return { dispose: vi.fn() } as vscode.Disposable;
      }
    );

    mockAutoEnterService = {
      toggleAutoEnter: vi.fn(),
    };

    mockDeps = {
      terminalManager: undefined,
      sidebarProvider: undefined,
      extensionPersistenceService: undefined,
      fileReferenceCommand: undefined,
      terminalCommand: undefined,
      copilotIntegrationCommand: undefined,
      shellIntegrationService: undefined,
      keyboardShortcutService: undefined,
      telemetryService: undefined,
      autoEnterService: mockAutoEnterService as unknown as AutoEnterService,
    };

    mockSessionHandlers = {
      handleSaveSession: vi.fn().mockResolvedValue(undefined),
      handleRestoreSession: vi.fn().mockResolvedValue(undefined),
      handleClearSession: vi.fn().mockResolvedValue(undefined),
      handleTestScrollback: vi.fn().mockResolvedValue(undefined),
      diagnoseSessionData: vi.fn().mockResolvedValue(undefined),
    };

    mockContext = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    commandRegistrar = new CommandRegistrar(mockDeps, mockSessionHandlers);
    commandRegistrar.registerCommands(mockContext);
  });

  it('AutoEnter関連のコマンドが正しく登録される', () => {
    expect(registeredCommands.has('secondaryTerminal.toggleAutoEnter')).toBe(true);
    expect(registeredCommands.has('secondaryTerminal.enableAutoEnter')).toBe(true);
    expect(registeredCommands.has('secondaryTerminal.disableAutoEnter')).toBe(true);
  });

  it('toggleAutoEnter実行時にautoEnterService.toggleAutoEnterが呼び出される', async () => {
    const handler = registeredCommands.get('secondaryTerminal.toggleAutoEnter')!;
    await handler();
    expect(mockAutoEnterService.toggleAutoEnter).toHaveBeenCalledTimes(1);
  });

  it('enableAutoEnter実行時にautoEnterService.toggleAutoEnterが呼び出される', async () => {
    const handler = registeredCommands.get('secondaryTerminal.enableAutoEnter')!;
    await handler();
    expect(mockAutoEnterService.toggleAutoEnter).toHaveBeenCalledTimes(1);
  });

  it('disableAutoEnter実行時にautoEnterService.toggleAutoEnterが呼び出される', async () => {
    const handler = registeredCommands.get('secondaryTerminal.disableAutoEnter')!;
    await handler();
    expect(mockAutoEnterService.toggleAutoEnter).toHaveBeenCalledTimes(1);
  });
});
