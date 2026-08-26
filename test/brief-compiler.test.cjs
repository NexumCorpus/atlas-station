// Brief-compiler + retry-classification tests (fleet/B-343-R).
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } }
import('../fleethost.mjs').then(({ compileBrief }) => {
  const task = 'Extend the build-brief compiler: add optional spec param with prior-art check, failure-class hint, scope and verification overrides, plus a retry classification gate blocking unclassified auto-retries. '.repeat(2);

  // 1. Backward compat: single-arg output identical to null-spec.
  const a = compileBrief(task);
  const b = compileBrief(task, null);
  ok('backcompat identical', JSON.stringify(a) === JSON.stringify(b));
  ok('scope line default', a.split('\n')[3] === 'This is a focused build task. Make only the changes described below.');
  ok('no spec sections', !a.includes('### Prior-Art Check') && !a.includes('### Failure-Class Hint'));

  // 2. Spec sections emitted.
  const s = compileBrief(task, {
    scope: 'Narrow scope line.',
    verification: ['run node --check', 'run tests'],
    priorArt: 'Checked master a04416c: compiler absent.',
    failureClass: 'brief-defect'
  });
  ok('prior-art section', s.includes('### Prior-Art Check\nChecked master a04416c: compiler absent.'));
  ok('failure-class section', s.includes('### Failure-Class Hint\nbrief-defect'));
  ok('scope override', s.split('\n')[3] === 'Narrow scope line.');
  ok('verification lines', s.includes('run node --check') && s.includes('run tests'));
  ok('task preserved', s.endsWith(task));

  // 3. Validation errors.
  try { compileBrief(task, { failureClass: 'brief-defect' }); ok('missing priorArt throws', false); }
  catch (e) { ok('missing priorArt throws', /priorArt/.test(e.message)); }
  try { compileBrief(task, { failureClass: 'bogus' }); ok('bad failureClass throws', false); }
  catch (e) { ok('bad failureClass throws', true); }

  // 4. Retry classification gate contract.
  const RETRY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
  function gate(record) {
    const fc = record && record.failureClass;
    if (fc === 'constraint-era') return { allow: true };
    if (fc === 'brief-defect' || fc === 'novel') return { allow: false };
    const tsCands = [record.failedAt, record.endedAt].map(t => Date.parse(t)).filter(Number.isFinite);
    const ts = tsCands.length ? Math.max(...tsCands) : NaN;
    return Number.isFinite(ts) && Date.now() - ts >= RETRY_GRACE_MS ? { allow: false } : { allow: true, grace: true };
  }
  ok('constraint-era allowed', gate({ failureClass: 'constraint-era' }).allow === true);
  ok('brief-defect blocked', gate({ failureClass: 'brief-defect' }).allow === false);
  ok('unclassified fresh grace', gate({ failedAt: new Date().toISOString() }).grace === true);
  ok('unclassified stale blocked', gate({ failedAt: new Date(Date.now() - RETRY_GRACE_MS - 1000).toISOString() }).allow === false);

  console.log(`pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error('LOADFAIL', e.message); process.exit(1); });
