const m = require('../../../scripts/eval/metrics');

// ---- helpers: build a transcript from a list of steps -------------------------------------------

/**
 * Each step is one student answer and the Host's decision after it:
 * { label, type: 'main'|'followUp', action: 'follow_up'|'next_main'|'end', question, reason, fallback, modelCall }
 */
function transcript(steps, over = {}) {
  const turns = [{ role: 'host', kind: 'main', text: 'Main 1?', reason: 'first main question' }];
  let endDetail;
  let endModelCall;
  steps.forEach((s, i) => {
    turns.push({ role: 'student', kind: s.type === 'followUp' ? 'follow_up' : 'main', text: 'answer', scripted: { label: s.label, answerType: s.type || 'main' } });
    const reason = s.reason === undefined ? 'fine' : s.reason;
    if (s.action === 'end') {
      endDetail = { reason, ...(s.fallback && { fallback: s.fallback }) };
      endModelCall = s.modelCall;
    } else {
      turns.push({
        role: 'host',
        kind: s.action === 'follow_up' ? 'follow_up' : 'main',
        text: s.question || (s.action === 'follow_up' ? 'Explain the loop.' : `Main ${i + 2}?`),
        reason,
        ...(s.fallback && { fallback: s.fallback }),
        ...(s.modelCall && { modelCall: s.modelCall }),
      });
    }
  });
  return {
    promptVersion: 'host.v3', caseId: 'case2', profile: 'vague', status: 'completed', budget: 1,
    turns, ...(endDetail && { endDetail }), ...(endModelCall && { endModelCall }), calls: [], ...over,
  };
}

const analyze = (t) => m.summarize(m.analyzeTranscript(t));

// ---- question heuristics ------------------------------------------------------------------------

describe('isYesNo', () => {
  it.each(['Is', 'Are', 'Does', 'Do', 'Did', 'Can', 'Could', 'Will', 'Would', 'Should', 'Has', 'Have'])(
    'flags a question starting with %s', (word) => {
      expect(m.isYesNo(`${word} the loop stop here?`)).toBe(true);
      expect(m.isYesNo(`${word.toLowerCase()} the loop stop here?`)).toBe(true);
    }
  );

  it.each([
    'What happens when the stack is full?',
    'Why is top decremented after the read?',
    'Walk me through the loop.',
    'Explain how push works.',
    'Trace the while loop in main.',
    'Isolate the problem first: what does it return?',
    'Doesnt matter?',
  ])('does not flag %p', (q) => {
    expect(m.isYesNo(q)).toBe(false);
  });
});

describe('isMultiPart', () => {
  it('flags more than one question mark', () => {
    expect(m.isMultiPart('Why is it written that way? What would change otherwise?')).toBe(true);
  });

  it.each([
    'What does it return, and why is that correct?',
    'What happens first and what happens after that?',
    'How does push work and how does pop work?',
  ])('flags two questions joined by "and": %p', (q) => {
    expect(m.isMultiPart(q)).toBe(true);
  });

  it.each([
    'What happens when the stack is full?',
    'Explain the loop and the return value.',
    'Trace pop and top.',
    'Walk me through the loop.',
  ])('does not flag a single question: %p', (q) => {
    expect(m.isMultiPart(q)).toBe(false);
  });
});

describe('reasonContradictsAction', () => {
  it.each([
    'The answer is complete, no follow-up needed.',
    'No follow up needed here.',
    'Student fully covers the point.',
  ])('a follow-up with the reason %p contradicts', (reason) => {
    expect(m.reasonContradictsAction('follow_up', reason)).toBe(true);
  });

  it.each(['next_main', 'end'])('%s with a reason that asks for more contradicts', (action) => {
    expect(m.reasonContradictsAction(action, 'The answer needs clarification before moving on.')).toBe(true);
    expect(m.reasonContradictsAction(action, 'Requires clarification on the destructor.')).toBe(true);
    expect(m.reasonContradictsAction(action, 'Need to probe how top changes.')).toBe(true);
    expect(m.reasonContradictsAction(action, 'The answer is incomplete.')).toBe(true);
  });

  it('accepts reasons that match the action', () => {
    expect(m.reasonContradictsAction('follow_up', 'The answer is vague, so one follow-up is asked.')).toBe(false);
    expect(m.reasonContradictsAction('next_main', 'Explains the link and the head update; moving on.')).toBe(false);
    expect(m.reasonContradictsAction('end', 'All themes covered.')).toBe(false);
  });

  it('ignores a phrase that is negated', () => {
    expect(m.reasonContradictsAction('next_main', 'There is no need to probe further.')).toBe(false);
    expect(m.reasonContradictsAction('next_main', 'The answer is not incomplete.')).toBe(false);
  });

  it('an empty reason is never a contradiction', () => {
    expect(m.reasonContradictsAction('follow_up', '')).toBe(false);
  });
});

describe('classifyReason', () => {
  it.each([
    ['override: follow-up limit for this main question reached; asked the next main question', 'followUpLimit'],
    ['override: model asked to end but main questions remain; asked the next main question', 'earlyEnd'],
    ['override: model asked for another main question but none remain; ended', 'nextMainNoneRemain'],
    ['fallback: model unavailable; asked the next main question', 'fallback'],
    ['fallback: invalid model output; no main questions remain, ended', 'fallback'],
    ['The answer covers the point.', 'model'],
    ['', 'model'],
  ])('%p -> %s', (reason, kind) => {
    expect(m.classifyReason(reason)).toBe(kind);
  });
});

// ---- follow-up judgement --------------------------------------------------------------------------

describe('unnecessary follow-ups', () => {
  it('counts follow-ups asked after a main answer labelled good', () => {
    const s = analyze(transcript([
      { label: 'good', action: 'follow_up' },
      { label: 'good', type: 'followUp', action: 'next_main' },
      { label: 'good', action: 'next_main' },
      { label: 'good', action: 'end' },
    ]));
    expect(s.unnecessaryFollowUp).toEqual({ num: 1, den: 3, rate: 1 / 3 });
  });

  it('ignores answers to follow-ups', () => {
    const s = analyze(transcript([
      { label: 'vague', action: 'follow_up' },
      { label: 'good', type: 'followUp', action: 'follow_up' },
    ]));
    expect(s.unnecessaryFollowUp).toEqual({ num: 0, den: 0, rate: null });
  });

  it('is not measured when no follow-up was allowed, or when the decision was a fallback', () => {
    const none = analyze(transcript([{ label: 'good', action: 'next_main' }], { budget: 0 }));
    expect(none.unnecessaryFollowUp.den).toBe(0);
    const fell = analyze(transcript([{ label: 'good', action: 'next_main', fallback: 'invalid_output', reason: 'fallback: invalid model output; asked the next main question' }]));
    expect(fell.unnecessaryFollowUp.den).toBe(0);
  });
});

describe('missed follow-ups', () => {
  it('counts a bad answer that did not get a follow-up, by label', () => {
    const s = analyze(transcript([
      { label: 'vague', action: 'follow_up' },
      { label: 'vague', type: 'followUp', action: 'next_main' },
      { label: 'wrong', action: 'next_main' },
      { label: 'short', action: 'next_main' },
      { label: 'idk', action: 'end' },
    ]));
    expect(s.missedFollowUp).toEqual({ num: 3, den: 4, rate: 0.75 });
    expect(s.missedFollowUpByLabel.vague).toEqual({ num: 0, den: 1, rate: 0 });
    expect(s.missedFollowUpByLabel.wrong).toEqual({ num: 1, den: 1, rate: 1 });
    expect(s.missedFollowUpByLabel.short).toEqual({ num: 1, den: 1, rate: 1 });
    expect(s.missedFollowUpByLabel.idk).toEqual({ num: 1, den: 1, rate: 1 });
  });

  it('is not measured when the budget is 0 or the decision was a fallback', () => {
    expect(analyze(transcript([{ label: 'wrong', action: 'next_main' }], { budget: 0 })).missedFollowUp.den).toBe(0);
    expect(analyze(transcript([{ label: 'wrong', action: 'next_main', fallback: 'model_unavailable', reason: 'fallback: model unavailable; asked the next main question' }])).missedFollowUp.den).toBe(0);
  });
});

// ---- overrides, fallbacks, throttling -------------------------------------------------------------

describe('overrides and fallbacks', () => {
  const t = transcript([
    { label: 'good', action: 'next_main', reason: 'override: follow-up limit for this main question reached; asked the next main question' },
    { label: 'good', action: 'next_main', reason: 'override: model asked to end but main questions remain; asked the next main question' },
    { label: 'good', action: 'next_main', reason: 'override: model asked to end but main questions remain; asked the next main question' },
    { label: 'good', action: 'next_main', fallback: 'invalid_output', reason: 'fallback: invalid model output; asked the next main question' },
    { label: 'good', action: 'next_main', fallback: 'model_unavailable', reason: 'fallback: model unavailable; asked the next main question', modelCall: { throttled: true, errorName: 'ThrottlingException' } },
    { label: 'good', action: 'next_main', fallback: 'model_unavailable', reason: 'fallback: model unavailable; asked the next main question', modelCall: { throttled: false, errorName: 'InternalServerException' } },
    { label: 'good', action: 'next_main' },
    { label: 'good', action: 'end', reason: 'override: model asked for another main question but none remain; ended' },
  ]);
  t.calls = [{ throttleRetries: 1, inputTokens: 1, outputTokens: 1 }, { throttleRetries: 0 }, { throttleRetries: 2 }];
  const s = analyze(t);

  it('counts overrides by type, over all decisions including the final one', () => {
    expect(s.overrides.byType).toMatchObject({
      followUpLimit: { num: 1, den: 8 },
      earlyEnd: { num: 2, den: 8 },
      nextMainNoneRemain: { num: 1, den: 8 },
    });
    expect(s.overrides.total).toEqual({ num: 4, den: 8, rate: 0.5 });
  });

  it('keeps throttling apart from other model failures', () => {
    expect(s.fallbacks.invalidOutput).toBe(1);
    expect(s.fallbacks.throttled).toBe(1);
    expect(s.fallbacks.modelUnavailable).toBe(1);
    expect(s.fallbacks.total).toEqual({ num: 3, den: 8, rate: 3 / 8 });
    expect(s.fallbacks.throttleRetries).toBe(3);
  });
});

// ---- question style, reasons ----------------------------------------------------------------------

describe('follow-up style', () => {
  it('reports yes/no and multi-part rates over the follow-ups asked', () => {
    const s = analyze(transcript([
      { label: 'vague', action: 'follow_up', question: 'Can you explain that?' },
      { label: 'vague', type: 'followUp', action: 'next_main' },
      { label: 'vague', action: 'follow_up', question: 'What happens first and what next?' },
      { label: 'vague', type: 'followUp', action: 'next_main' },
      { label: 'vague', action: 'follow_up', question: 'Trace the loop.' },
      { label: 'vague', type: 'followUp', action: 'next_main' },
      { label: 'vague', action: 'follow_up', question: 'Why? What changes?' },
    ]));
    expect(s.yesNo).toEqual({ num: 1, den: 4, rate: 0.25 });
    expect(s.multiPart).toEqual({ num: 2, den: 4, rate: 0.5 });
  });

  it('has no rate when no follow-ups were asked', () => {
    expect(analyze(transcript([{ label: 'good', action: 'end' }])).yesNo.rate).toBeNull();
  });
});

describe('reason contradictions', () => {
  it('checks only reasons written by the model, against the action taken', () => {
    const s = analyze(transcript([
      { label: 'good', action: 'follow_up', reason: 'The answer is complete, no follow-up needed.' },
      { label: 'good', type: 'followUp', action: 'next_main', reason: 'The answer needs clarification before moving on.' },
      { label: 'good', action: 'next_main', reason: 'Covers the point, moving on.' },
      { label: 'good', action: 'next_main', reason: 'override: follow-up limit for this main question reached; asked the next main question' },
      { label: 'good', action: 'end', reason: 'fallback: model unavailable; no main questions remain, ended', fallback: 'model_unavailable' },
    ]));
    expect(s.reasonContradiction).toEqual({ num: 2, den: 3, rate: 2 / 3 });
  });
});

// ---- interview level --------------------------------------------------------------------------------

describe('interview-level numbers', () => {
  it('counts completed, timed out and errored interviews and questions per interview', () => {
    const a = transcript([{ label: 'good', action: 'next_main' }, { label: 'good', action: 'end' }]);
    const b = transcript([{ label: 'good', action: 'next_main' }], { status: 'timed_out' });
    const c = transcript([], { status: 'error' });
    const s = m.summarizeTranscripts([a, b, c]);
    expect(s).toMatchObject({ interviews: 3, completed: 1, timedOut: 1, errored: 1 });
    expect(s.questionsPerInterview).toBeCloseTo((2 + 2 + 1) / 3);
  });

  it('computes latency percentiles, tokens and cost from the calls', () => {
    const t = transcript([{ label: 'good', action: 'end' }]);
    t.calls = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((latencyMs) => ({ latencyMs, inputTokens: 1000000 / 10, outputTokens: 100000 / 10 }));
    t.calls.push({ latencyMs: 0, inputTokens: 0, outputTokens: 0, errorName: 'ThrottlingException' });
    const s = analyze(t);
    expect(s.latencyMs).toEqual({ median: 550, p95: 1000, n: 10 });
    expect(s.calls).toBe(11);
    expect(s.inputTokens).toBe(1000000);
    expect(s.outputTokens).toBe(100000);
    expect(s.estimatedCostUsd).toBeCloseTo(0.15 + 0.06);
  });

  it('uses the prices it is given', () => {
    expect(m.estimateCost(2e6, 1e6, { inputPerMillion: 1, outputPerMillion: 3 })).toBe(5);
  });

  it('median and percentile of nothing are null', () => {
    expect(m.median([])).toBeNull();
    expect(m.percentile([], 0.95)).toBeNull();
  });
});

// ---- grouping ---------------------------------------------------------------------------------------

describe('summarizeRun', () => {
  const make = (promptVersion, caseId, profile, label, action) =>
    transcript([{ label, action }], { promptVersion, caseId, profile });

  it('groups by prompt version, then overall, by case and by profile', () => {
    const results = m.summarizeRun([
      make('host.v2', 'case1', 'strong', 'good', 'follow_up'),
      make('host.v2', 'case2', 'vague', 'vague', 'next_main'),
      make('host.v3', 'case1', 'strong', 'good', 'next_main'),
      make('host.v3', 'case2', 'vague', 'vague', 'follow_up'),
    ]);
    expect(Object.keys(results)).toEqual(['host.v2', 'host.v3']);
    expect(results['host.v2'].overall.interviews).toBe(2);
    expect(Object.keys(results['host.v2'].byCase)).toEqual(['case1', 'case2']);
    expect(Object.keys(results['host.v2'].byProfile)).toEqual(['strong', 'vague']);

    expect(results['host.v2'].overall.unnecessaryFollowUp.rate).toBe(1);
    expect(results['host.v3'].overall.unnecessaryFollowUp.rate).toBe(0);
    expect(results['host.v2'].byProfile.vague.missedFollowUp.rate).toBe(1);
    expect(results['host.v3'].byProfile.vague.missedFollowUp.rate).toBe(0);
    // a profile with no answers to measure has no rate, not 0%
    expect(results['host.v3'].byProfile.strong.missedFollowUp.rate).toBeNull();
  });

  it('merging counters adds numbers, objects and latency lists', () => {
    const a = m.analyzeTranscript(transcript([{ label: 'wrong', action: 'next_main' }]));
    const merged = m.mergeCounters(a, a);
    expect(merged.interviews).toBe(2);
    expect(merged.missed.wrong).toBe(2);
  });
});
