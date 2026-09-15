import { describe, it, expect } from 'vitest';
import { parseEngineArgs } from '../../utils/engineArgs';

describe('parseEngineArgs', () => {
  it('parses --key=value as one token', () => {
    expect(parseEngineArgs('--max-model-len=8192')).toEqual({
      ok: true,
      args: ['--max-model-len=8192'],
    });
  });

  it('parses --key value as two tokens', () => {
    expect(parseEngineArgs('--gpu-memory-utilization 0.85')).toEqual({
      ok: true,
      args: ['--gpu-memory-utilization', '0.85'],
    });
  });

  it('parses a bare --switch as one token', () => {
    expect(parseEngineArgs('--enable-prefix-caching')).toEqual({
      ok: true,
      args: ['--enable-prefix-caching'],
    });
  });

  it('skips blank lines and # comment lines', () => {
    expect(parseEngineArgs('--a=1\n\n  \n# a comment\n--b=2')).toEqual({
      ok: true,
      args: ['--a=1', '--b=2'],
    });
  });

  it('preserves a trailing # inside a value', () => {
    expect(parseEngineArgs('--x=a#b')).toEqual({ ok: true, args: ['--x=a#b'] });
  });

  it('preserves internal whitespace in a --key value pair', () => {
    expect(parseEngineArgs('--chat-template /path/with spaces.jinja')).toEqual({
      ok: true,
      args: ['--chat-template', '/path/with spaces.jinja'],
    });
  });

  it('strips one quote layer, double quotes, --key=value form', () => {
    expect(parseEngineArgs('--x="a b"')).toEqual({ ok: true, args: ['--x=a b'] });
  });

  it('strips one quote layer, single quotes, --key value form', () => {
    expect(parseEngineArgs("--chat-template '/p/t.jinja'")).toEqual({
      ok: true,
      args: ['--chat-template', '/p/t.jinja'],
    });
  });

  it('strips only one quote layer, leaving a nested layer intact', () => {
    expect(parseEngineArgs(`--x="'a'"`)).toEqual({ ok: true, args: [`--x='a'`] });
  });

  it('preserves order across multiple lines', () => {
    expect(parseEngineArgs('--c=3\n--a=1\n--b=2')).toEqual({
      ok: true,
      args: ['--c=3', '--a=1', '--b=2'],
    });
  });

  it('rejects a non-empty line that does not start with --, naming the 1-based line number', () => {
    expect(parseEngineArgs('--a=1\nnot-a-flag\n--b=2')).toEqual({
      ok: false,
      kind: 'prefix',
      line: 2,
      content: 'not-a-flag',
    });
  });

  it('rejects a reserved flag in --key=value form', () => {
    expect(parseEngineArgs('--port=9999')).toEqual({
      ok: false,
      kind: 'reserved',
      line: 1,
      flag: '--port',
    });
  });

  it('rejects a reserved flag in --key value form', () => {
    expect(parseEngineArgs('--port 9999')).toEqual({
      ok: false,
      kind: 'reserved',
      line: 1,
      flag: '--port',
    });
  });

  it('rejects a bare reserved flag', () => {
    expect(parseEngineArgs('--port')).toEqual({
      ok: false,
      kind: 'reserved',
      line: 1,
      flag: '--port',
    });
  });

  it('rejects an unambiguous prefix abbreviation of a reserved flag (argparse allow_abbrev, #126 review)', () => {
    expect(parseEngineArgs('--hos=0.0.0.0')).toEqual({
      ok: false,
      kind: 'reserved',
      line: 1,
      flag: '--hos',
      abbreviates: '--host',
    });
    expect(parseEngineArgs('--por 9999')).toEqual({
      ok: false,
      kind: 'reserved',
      line: 1,
      flag: '--por',
      abbreviates: '--port',
    });
    expect(parseEngineArgs('--tensor-parallel')).toEqual({
      ok: false,
      kind: 'reserved',
      line: 1,
      flag: '--tensor-parallel',
      abbreviates: '--tensor-parallel-size',
    });
  });

  it('does not reject a flag that merely has a reserved flag as its own prefix (#126 review)', () => {
    expect(parseEngineArgs('--model-impl=vllm')).toEqual({
      ok: true,
      args: ['--model-impl=vllm'],
    });
  });

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(parseEngineArgs('')).toEqual({ ok: true, args: [] });
    expect(parseEngineArgs('   \n  \n')).toEqual({ ok: true, args: [] });
  });
});
