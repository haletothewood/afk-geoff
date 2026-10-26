import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLabel } from './label.js';
test('trims and lowercases labels', () => { assert.equal(normalizeLabel('  HeLLo  '), 'hello'); });
