import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deselections, loadModel } from '../../plugins/buildorder/lib/standard.mjs';

const CLASSES = ['mandatory', 'standard', 'option'];

test('the model lists every item once with a class and a provider', () => {
  const { items } = loadModel();
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const item of items) {
    assert.ok(CLASSES.includes(item.class), `${item.id}: class`);
    assert.match(item.provider, /^(core|stack|[a-z][a-z0-9-]*)$/, `${item.id}: provider`);
    assert.ok(['repo', 'github', 'plugin', 'workspace'].includes(item.where), `${item.id}: where`);
  }
  // The spec's mandatory row and the docker-cicd part of the standard row.
  for (const id of ['lint', 'tests-coverage', 'build', 'secret-scan', 'dependency-audit', 'dependency-review', 'codeql',
    'dependabot', 'action-pins', 'workflow-lint', 'pre-commit', 'rulesets', 'guardrail-hooks', 'doc-map']) {
    assert.equal(items.find((i) => i.id === id)?.class, 'mandatory', id);
  }
  for (const id of ['container-image', 'deploy']) {
    const item = items.find((i) => i.id === id);
    assert.equal(item?.class, 'standard', id);
    assert.equal(item.provider, 'docker-cicd', id);
  }
});

test('a standard item can be deselected with a reason', () => {
  const out = deselections(loadModel(), ['container-image=library, no image', 'deploy=deployed by hand']);
  assert.deepEqual([...out], [['container-image', 'library, no image'], ['deploy', 'deployed by hand']]);
  assert.deepEqual([...deselections(loadModel(), undefined)], []);
});

test('a mandatory item cannot be deselected', () => {
  assert.throws(() => deselections(loadModel(), ['codeql=too slow']), /^Error: 'codeql' is mandatory and cannot be deselected$/);
  assert.throws(() => deselections(loadModel(), ['rulesets=later']), /'rulesets' is mandatory/);
});

test('a standard item needs a reason, and the id must be known', () => {
  for (const bad of ['container-image', 'container-image=', 'container-image=   ']) {
    assert.throws(() => deselections(loadModel(), [bad]), /deselecting 'container-image' needs a reason: --without container-image=<reason>/);
  }
  assert.throws(() => deselections(loadModel(), ['nope=x']), /unknown standard item 'nope'/);
});

test('versioning is an option module that lives in the plugin', () => {
  const item = loadModel().items.find((i) => i.id === 'versioning');
  assert.equal(item?.class, 'option');
  assert.equal(item.provider, 'versioning');
  assert.equal(item.where, 'plugin');
  assert.equal(item.summary, 'Version drift warning on release prompts (hook version-drift)');
});

test('web-quality is an option module for react and angular', () => {
  const item = loadModel().items.find((i) => i.id === 'web-quality');
  assert.deepEqual(item, {
    id: 'web-quality',
    class: 'option',
    provider: 'web-quality',
    where: 'workspace',
    stacks: ['react', 'angular'],
    summary: 'Performance, SEO and accessibility: a rule for the frontend sources and the web-quality skill',
  });
});
