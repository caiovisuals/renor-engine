import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Published #132 kept `if (structured) return` inside the fact, event, and
 * preference blocks. The comment said the skip was per-lane. The statement
 * still left indexFile, so a current fact row never reached events or
 * preferences.
 *
 * The all-lanes-current return in step 3 is a different statement: it fires
 * only when every enabled lane is already current. This test does not forbid
 * that one. It forbids a return whose condition is a single lane's row.
 */

const PIPELINE = path.resolve(__dirname, '../../src/indexer/pipeline.ts');

function sourceFile(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

function returnsFromFunction(node: ts.Node): boolean {
  let found = false;
  function walk(inner: ts.Node): void {
    if (ts.isReturnStatement(inner)) {
      found = true;
      return;
    }
    // A return inside a nested function is not a return from this function.
    if (inner !== node && (ts.isFunctionLike(inner) || ts.isArrowFunction(inner))) return;
    ts.forEachChild(inner, walk);
  }
  walk(node);
  return found;
}

function singleLaneReturns(source: string): string[] {
  const sf = sourceFile(PIPELINE, source);
  const hits: string[] = [];
  function walk(node: ts.Node): void {
    if (ts.isIfStatement(node) && returnsFromFunction(node.thenStatement)) {
      const condition = node.expression.getText(sf);
      const oneLane = ['structured', 'currentEvents', 'currentPrefs'].filter(name => (
        new RegExp(`\\b${name}\\b`).test(condition)
      ));
      if (oneLane.length === 1 && !/&&/.test(condition)) hits.push(condition);
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return hits;
}

function staleLaneOwnsExtractor(source: string): string[] {
  const sf = sourceFile(PIPELINE, source);
  const missing: string[] = [];
  const lanes = [
    { flag: '!structured', extractor: 'numericFactExtractor' },
    { flag: '!currentEvents', extractor: 'eventExtractor' },
    { flag: '!currentPrefs', extractor: 'preferenceExtractor' },
  ];
  for (const lane of lanes) {
    let owned = false;
    function walk(node: ts.Node): void {
      if (!ts.isIfStatement(node)) {
        ts.forEachChild(node, walk);
        return;
      }
      const head = node.expression.getText(sf);
      if (head === lane.flag) {
        function calls(inner: ts.Node): void {
          if (ts.isCallExpression(inner)) {
            const text = inner.expression.getText(sf);
            if (text.includes(lane.extractor)) owned = true;
          }
          ts.forEachChild(inner, calls);
        }
        calls(node.thenStatement);
      }
      ts.forEachChild(node, walk);
    }
    walk(sf);
    if (!owned) missing.push(lane.extractor);
  }
  return missing;
}

describe('per-lane structured-row skip', () => {
  const source = fs.readFileSync(PIPELINE, 'utf8');

  it('does not return from the note when only one lane is current', () => {
    expect(singleLaneReturns(source)).toEqual([]);
  });

  it('calls each extractor only from that lane\'s stale branch', () => {
    expect(staleLaneOwnsExtractor(source)).toEqual([]);
  });

  it('fails the published early-return shape', () => {
    const published = `
      if (structured) {
        return;
      }
      const extracted = await options.numericFactExtractor(parsed.title, parsed.body);
    `;
    expect(singleLaneReturns(published)).toEqual(['structured']);
    expect(staleLaneOwnsExtractor(published)).toContain('numericFactExtractor');
  });
});
