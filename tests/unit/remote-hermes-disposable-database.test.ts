import { describe, expect, it } from 'vitest';
import { assertDisposableHermesDatabase } from '../fixtures/remote-hermes-disposable-database';

describe('disposable native conformance database boundary before pool creation', () => {
  it.each([
    'postgres://fixture:fixture@127.0.0.1/hermes_fixture',
    'postgresql://fixture:fixture@localhost:5544/hermes_fixture',
  ])('accepts a named loopback database without overrides: %s', url => {
    expect(() => assertDisposableHermesDatabase(url)).not.toThrow();
  });
  it.each([
    undefined, '', 'not-a-url',
    'postgres://fixture:fixture@remote.example/hermes_fixture',
    'postgres://fixture:fixture@127.0.0.1/user_database',
    'https://127.0.0.1/hermes_fixture',
    'postgres://fixture:fixture@127.0.0.1/hermes_fixture?host=remote.example',
    'postgres://fixture:fixture@127.0.0.1/hermes_fixture?%68ost=remote.example',
    'postgres://fixture:fixture@127.0.0.1/hermes_fixture?dbname=user_database',
    'postgres://fixture:fixture@127.0.0.1/hermes_fixture?user=real-account',
    'postgres://fixture:fixture@127.0.0.1/hermes_fixture?sslmode=require',
    'postgres://fixture:fixture@127.0.0.1/hermes_fixture#ignored',
  ])('rejects unsafe or overridden connections: %s', url => {
    expect(() => assertDisposableHermesDatabase(url)).toThrow('disposable loopback');
  });
});
