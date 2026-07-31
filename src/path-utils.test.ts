import { describe, expect, it } from 'vitest';
import { normalizePathForComparison } from './path-utils';

describe('normalizePathForComparison', () => {
  it('compares Windows drive paths without case or separator differences', () => {
    expect(normalizePathForComparison('C:\\Photos\\Campaign\\'))
      .toBe('c:/photos/campaign');
    expect(normalizePathForComparison('c:/PHOTOS/CAMPAIGN'))
      .toBe('c:/photos/campaign');
  });

  it('compares UNC paths without case differences', () => {
    expect(normalizePathForComparison('\\\\Server\\Share\\Photos\\'))
      .toBe('//server/share/photos');
  });

  it('preserves case for POSIX paths', () => {
    expect(normalizePathForComparison('/Photos/A/')).toBe('/Photos/A');
    expect(normalizePathForComparison('/Photos/a/')).toBe('/Photos/a');
    expect(normalizePathForComparison('/Photos/A'))
      .not.toBe(normalizePathForComparison('/Photos/a'));
  });
});
