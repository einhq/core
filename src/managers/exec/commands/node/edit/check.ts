/**
 * Syntax checks for the editor: where a JSON, YAML or bash text stops parsing, and why. A
 * Markdown text is checked block by block, for each fenced block in one of those languages.
 */

import { BashSyntaxError, parse as parseBash } from '@ein/bash-executor';
import { parse as parseJsonc } from '@std/jsonc';
import { parseAll as parseYaml } from '@std/yaml';
import { fencedBlocks } from '../../../../shell/terminal/syntax.ts';

/** A syntax error at a 1-based line, and a 1-based column when the parser says one. */
export type Problem = { line: number; col?: number; message: string };

/** Texts longer than this are not checked: the editor checks after every change. */
const MAX_CHECK_LENGTH = 1_000_000;

const CHECKED = new Set(['json', 'jsonc', 'yaml', 'bash', 'markdown']);

/** Whether `check` has anything to say about a language. */
export const isCheckable = (lang?: string): boolean => lang !== undefined && CHECKED.has(lang);

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The 1-based line and column of a character offset. */
function positionAt(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length, col: offset - lineStart + 1 };
}

const lastLine = (text: string) => text.replace(/\n+$/, '').split('\n').length;

function checkJson(text: string, comments: boolean): Problem[] {
  // An empty file is one being started, not a broken one.
  if (!text.trim()) return [];
  if (comments) {
    try {
      parseJsonc(text);
      return [];
    } catch (error) {
      return [jsoncProblem(text, error as Error)];
    }
  }
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = (error as Error).message;
    const at = / in JSON at position \d+ \(line (\d+) column (\d+)\)$/.exec(message);
    if (at) return [{ line: Number(at[1]), col: Number(at[2]), message: lowerFirst(message.slice(0, at.index)) }];
    // V8 names no position for a stray token or a cut-off text; the JSONC parser does.
    try {
      parseJsonc(text);
    } catch (jsoncError) {
      return [jsoncProblem(text, jsoncError as Error)];
    }
    return [{ line: 1, message: lowerFirst(message.split(', "')[0]) }];
  }
}

function jsoncProblem(text: string, error: Error): Problem {
  const message = error.message.replace(/^Cannot parse JSONC: /, '');
  const at = / in JSONC at position (\d+)$/.exec(message);
  if (at) return { ...positionAt(text, Number(at[1])), message: message.slice(0, at.index) };
  return { line: lastLine(text), message: message.replace(' of JSONC input', ' of input') };
}

function checkYaml(text: string): Problem[] {
  try {
    parseYaml(text);
    return [];
  } catch (error) {
    const first = (error as Error).message.split('\n')[0];
    const at = / at line (\d+), column (\d+):?$/.exec(first);
    const message = lowerFirst((at ? first.slice(0, at.index) : first).replace(/^Cannot [^:]*: /, ''));
    return [at ? { line: Number(at[1]), col: Number(at[2]), message } : { line: lastLine(text), message }];
  }
}

/** The first here-document in a parsed script that the text ended inside, as the parser marks it. */
function unclosedHereDocument(node: unknown): { delimiter: string; line: number } | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const heredoc = (node as { heredoc?: { unterminated?: { delimiter: string; line: number } } }).heredoc;
  if (heredoc?.unterminated) return heredoc.unterminated;
  for (const value of Object.values(node)) {
    const found = unclosedHereDocument(value);
    if (found) return found;
  }
  return undefined;
}

function checkBash(text: string): Problem[] {
  try {
    // As bash reads a script: a here-document the text ends inside takes the rest, and is marked.
    const ast = parseBash(text, { unterminatedHereDocuments: 'end' });
    const hereDocument = unclosedHereDocument(ast);
    return hereDocument ? [{ line: hereDocument.line, message: `here-document not closed (wanted '${hereDocument.delimiter}')` }] : [];
  } catch (error) {
    if (!(error instanceof BashSyntaxError)) throw error;
    const detail = error.detail;
    let message: string;
    if (detail?.kind === 'token') message = `unexpected token '${detail.token}'`;
    else if (detail?.kind === 'eof') message = 'unexpected end of file';
    else if (detail?.kind === 'unclosed') message = `unclosed ${detail.closer}`;
    else if (detail?.kind === 'arithmeticFor') message = detail.problem;
    else message = lowerFirst(error.message.replace(/^Parse error on line \d+: /, ''));
    const start = error.location?.start;
    return [{ line: start?.row ?? lastLine(text), col: start?.row !== undefined ? start.col : undefined, message }];
  }
}

async function checkMarkdown(text: string): Promise<Problem[]> {
  const lines = text.split('\n');
  const problems: Problem[] = [];
  for (const block of fencedBlocks(lines)) {
    if (block.lang === 'markdown' || !isCheckable(block.lang)) continue;
    const found = await check(block.lang, lines.slice(block.body, block.end).join('\n'));
    problems.push(...found.map((problem) => ({ ...problem, line: problem.line + block.body })));
  }
  return problems;
}

/** The syntax errors in a text written in a language; none for a language nothing checks. */
export async function check(lang: string | undefined, text: string): Promise<Problem[]> {
  if (text.length > MAX_CHECK_LENGTH) return [];
  switch (lang) {
    case 'json':
      return checkJson(text, false);
    case 'jsonc':
      return checkJson(text, true);
    case 'yaml':
      return checkYaml(text);
    case 'bash':
      return checkBash(text);
    case 'markdown':
      return await checkMarkdown(text);
    default:
      return [];
  }
}
