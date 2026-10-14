// Only reviewed fixture names or a complete immutable local Docker image ID.
// A local ID is still subject to the probe's binary, requirements and policy checks.
export function isReviewedFixtureImage(image) {
  return typeof image === 'string' && !/\s/.test(image)
    && /^(?:sha256:[a-f0-9]{64}|collectiveui\/personal-codex(?::[a-z0-9-]+|@sha256:[a-f0-9]{64}))$/.test(image);
}
