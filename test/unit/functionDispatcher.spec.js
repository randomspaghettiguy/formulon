
import { expect } from 'vitest';

import dispatch from '../../src/functionDispatcher.js';
import { buildLiteralFromJs } from '../../src/utils.js';

describe('dispatch', () => {
  describe('valid input', () => {
    it('correctly returns result', () => {
      const args = [1, 2].map((v) => buildLiteralFromJs(v));
      expect(dispatch('add', args)).to.deep.eq(buildLiteralFromJs(3));
    });
  });
});
