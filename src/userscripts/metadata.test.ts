import { describe, expect, it } from 'vitest';
import { parseUserscriptMetadata } from './metadata';

describe('parseUserscriptMetadata', () => {
  it('reads a header pasted with Windows line endings and returns the body without it', () => {
    const code = '// ==UserScript==\r\n// @name crlf script\r\n// @match https://x.test/*\r\n// ==/UserScript==\r\nreturn 1;\r\n';
    const parsed = parseUserscriptMetadata(code);
    expect(parsed).toEqual({ name: 'crlf script', matches: ['https://x.test/*'], body: 'return 1;\n' });
  });

  it('reads a header that uses bare carriage returns', () => {
    const parsed = parseUserscriptMetadata('// ==UserScript==\r// @name cr script\r// ==/UserScript==\rreturn 2;');
    expect(parsed?.name).toBe('cr script');
    expect(parsed?.body).toBe('return 2;');
  });

  it('returns null for code with no metadata block', () => {
    expect(parseUserscriptMetadata('return 3;')).toBeNull();
  });
});
