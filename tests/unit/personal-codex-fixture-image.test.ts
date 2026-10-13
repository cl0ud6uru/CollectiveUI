import { describe, expect, it } from 'vitest';
import { isReviewedFixtureImage } from '../../scripts/lib/personal-codex-fixture-image.mjs';

describe('reviewed disposable runtime image inputs', () => {
  it.each([
    `sha256:${'a'.repeat(64)}`,
    `collectiveui/personal-codex@sha256:${'b'.repeat(64)}`,
    'collectiveui/personal-codex:stock-runtime',
  ])('accepts exact operator image reference %s', image => {
    expect(isReviewedFixtureImage(image)).toBe(true);
  });
  it.each([
    undefined, '', 'sha256:short', `sha256:${'a'.repeat(63)}`,
    `sha256:${'a'.repeat(65)}`, `sha256:${'A'.repeat(64)}`,
    `sha256:${'a'.repeat(64)}\n`, 'other/personal-codex:stock-runtime',
    'collectiveui/personal-codex:stock-runtime --privileged', '--privileged',
    'collectiveui/personal-codex:stock-runtime\n',
  ])('rejects malformed or unrelated reference %s', image => {
    expect(isReviewedFixtureImage(image)).toBe(false);
  });
});
