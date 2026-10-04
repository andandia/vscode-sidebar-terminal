import { describe, it, expect } from 'vitest';
import { formatTerminalPasteText } from '../../../../utils/terminalPaste';

describe('terminalPaste', () => {
  describe('formatTerminalPasteText', () => {
    it('CRLF改行を含む複数行テキストを正規化し、ブラケッティドペーストモードでラップすること', () => {
      const input = 'line1\r\nline2\r\nline3';
      const expected = '\x1b[200~line1\rline2\rline3\x1b[201~';
      expect(formatTerminalPasteText(input)).toBe(expected);
    });

    it('LF改行を含む複数行テキストを正規化し、ブラケッティドペーストモードでラップすること', () => {
      const input = 'line1\nline2\nline3';
      const expected = '\x1b[200~line1\rline2\rline3\x1b[201~';
      expect(formatTerminalPasteText(input)).toBe(expected);
    });

    it('単独CR改行を含む複数行テキストを正規化し、ブラケッティドペーストモードでラップすること', () => {
      const input = 'line1\rline2\rline3';
      const expected = '\x1b[200~line1\rline2\rline3\x1b[201~';
      expect(formatTerminalPasteText(input)).toBe(expected);
    });

    it('CRLF、LF、CRが混在する複数行テキストを正しく単一のCRに正規化すること', () => {
      const input = 'line1\r\nline2\nline3\rline4';
      const expected = '\x1b[200~line1\rline2\rline3\rline4\x1b[201~';
      expect(formatTerminalPasteText(input)).toBe(expected);
    });

    it('改行のない単一行テキストもブラケッティドペーストモードでラップすること', () => {
      const input = 'single line text';
      const expected = '\x1b[200~single line text\x1b[201~';
      expect(formatTerminalPasteText(input)).toBe(expected);
    });

    it('空文字列の場合もブラケッティドペーストモードのエスケープシーケンスでラップすること', () => {
      const input = '';
      const expected = '\x1b[200~\x1b[201~';
      expect(formatTerminalPasteText(input)).toBe(expected);
    });
  });
});
