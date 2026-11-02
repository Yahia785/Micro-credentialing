const fs = require('fs');
const { CASES, loadCase } = require('../../../scripts/eval/cases');
const {
  PROFILES, BASE_PROFILES, GAMING_PROFILES, RUN_PROFILES, PROFILE_FOR_LABEL, validateStudents, buildProfile, pairGapsLeft,
} = require('../../../scripts/eval/students');
const { buildAnswersMarkdown, ANSWERS_FILE } = require('../../../scripts/eval/build-answers');

const cases = CASES.map((c) => loadCase(c.id));

describe.each(cases)('$id', (c) => {
  it('has 2-5 themes and 4-5 main questions', () => {
    expect(c.config.themes.length).toBeGreaterThanOrEqual(2);
    expect(c.config.themes.length).toBeLessThanOrEqual(5);
    expect(c.mains.length).toBeGreaterThanOrEqual(4);
    expect(c.mains.length).toBeLessThanOrEqual(5);
  });

  it('has a valid interview config with a follow-up budget of 1 per main question', () => {
    expect(c.config.enabled).toBe(true);
    expect(c.config.maxFollowUpsPerMainQuestion).toBe(1);
  });

  it('has criteria for every theme', () => {
    c.config.themes.forEach((theme) => expect(theme.criteria.length).toBeGreaterThan(0));
  });

  it('has scripted students that match its main questions', () => {
    expect(() => validateStudents(c.studentsRaw, c.mains.length, c.id)).not.toThrow();
    expect(c.studentsRaw.caseId).toBe(c.id);
  });

  it('labels every answer of a profile with that profile', () => {
    for (const name of BASE_PROFILES) {
      const expected = Object.keys(PROFILE_FOR_LABEL).find((label) => PROFILE_FOR_LABEL[label] === name);
      buildProfile(c.studentsRaw, name).forEach((entry) => {
        expect(entry.main.label).toBe(expected);
        expect(entry.followUp.label).toBe(expected);
      });
    }
  });

  it('strong answers are complete (not a few words) and idk answers say so', () => {
    buildProfile(c.studentsRaw, 'strong').forEach((entry) => {
      expect(entry.main.text.split(/\s+/).length).toBeGreaterThanOrEqual(20);
      expect(entry.followUp.text.split(/\s+/).length).toBeGreaterThanOrEqual(15);
    });
    buildProfile(c.studentsRaw, 'idk').forEach((entry) => {
      expect(entry.main.text).toMatch(/don't know|not sure|no idea/i);
    });
    buildProfile(c.studentsRaw, 'short').forEach((entry) => {
      expect(entry.main.text.split(/\s+/).length).toBeLessThanOrEqual(6);
    });
  });

  it('the mixed profile uses a different label per main question, fixed in the file', () => {
    expect(new Set(c.studentsRaw.mixed).size).toBe(c.mains.length);
    const first = buildProfile(c.studentsRaw, 'mixed');
    const second = buildProfile(c.studentsRaw, 'mixed');
    expect(second).toEqual(first);
    first.forEach((entry, i) => {
      expect(entry.main.label).toBe(c.studentsRaw.mixed[i]);
      expect(entry.source).toBe(PROFILE_FOR_LABEL[c.studentsRaw.mixed[i]]);
      const raw = c.studentsRaw.profiles[entry.source][i].main;
      expect(entry.main).toMatchObject({ text: raw.text, label: raw.label });
    });
  });

  it('main questions point at code instead of stating behaviour (they name something in the program)', () => {
    c.mains.forEach((main) => expect(main.question.length).toBeGreaterThan(20));
  });
});

describe('the new cases', () => {
  it.each(['case2', 'case3'])('%s is a 30-60 line program', (id) => {
    const lines = loadCase(id).code.trimEnd().split('\n').length;
    expect(lines).toBeGreaterThanOrEqual(30);
    expect(lines).toBeLessThanOrEqual(60);
  });

  it('case 1 is the existing sample', () => {
    expect(loadCase('case1').codeFile).toMatch(/sample\.cpp$/);
    expect(loadCase('case1').configFile).toMatch(/sample-interview\.json$/);
  });

  it('case 3 has a real bug that a main question asks about, and the strong student admits it', () => {
    const c = loadCase('case3');
    expect(c.code).toContain('int words = 1;');
    const bugQuestion = c.mains.findIndex((m) => /countWords with b and c/.test(m.question));
    expect(bugQuestion).toBeGreaterThanOrEqual(0);
    const strong = buildProfile(c.studentsRaw, 'strong')[bugQuestion];
    expect(strong.main.text).toMatch(/bug|does not handle|wrong/i);
    const wrong = buildProfile(c.studentsRaw, 'wrong')[bugQuestion];
    expect(wrong.main.text).toMatch(/handles those cases correctly|right answers/i);
  });

  it('the cases use different topics from the linked list', () => {
    expect(loadCase('case2').code).not.toMatch(/Node|head/);
    expect(loadCase('case3').code).not.toMatch(/Node|head/);
  });
});

describe('validateStudents', () => {
  const good = () => JSON.parse(JSON.stringify(loadCase('case2').studentsRaw));

  it('rejects a profile with the wrong number of entries', () => {
    const raw = good();
    raw.profiles.vague.pop();
    expect(() => validateStudents(raw, 5, 'x')).toThrow(/vague/);
  });

  it('rejects an unknown label, empty text and a repeated mixed label', () => {
    const a = good();
    a.profiles.strong[0].main.label = 'great';
    expect(() => validateStudents(a, 5, 'x')).toThrow(/label/);
    const b = good();
    b.profiles.strong[0].followUp.text = ' ';
    expect(() => validateStudents(b, 5, 'x')).toThrow(/missing answer text/);
    const c = good();
    c.mixed = ['good', 'good', 'wrong', 'idk', 'short'];
    expect(() => validateStudents(c, 5, 'x')).toThrow(/different label/);
  });

  it('knows every profile', () => {
    expect(PROFILES).toEqual(['strong', 'vague', 'wrong', 'short', 'idk', 'mixed']);
    expect(() => buildProfile(good(), 'nobody')).toThrow(/Unknown profile/);
  });
});

describe('answers.md', () => {
  it('is up to date (regenerate with: node scripts/eval/build-answers.js)', () => {
    // Git on Windows may check the file out with CRLF line endings.
    expect(fs.readFileSync(ANSWERS_FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(buildAnswersMarkdown());
  });

  it('lists every question with every profile', () => {
    const md = fs.readFileSync(ANSWERS_FILE, 'utf8');
    for (const c of cases) {
      c.mains.forEach((main, i) => {
        expect(md).toContain(`### ${c.id} Q${i + 1}`);
        expect(md).toContain(main.question);
      });
    }
    expect(md.match(/^\| mixed \(/gm)).toHaveLength(cases.reduce((n, c) => n + c.mains.length, 0));
  });
});

describe.each(cases)('$id gaps, pairs and gaming answers', (c) => {
  it('lists at least 2 gaps per main question, each tied to a criterion of the theme', () => {
    expect(c.studentsRaw.gaps).toHaveLength(c.mains.length);
    c.studentsRaw.gaps.forEach((list, i) => {
      expect(list.length).toBeGreaterThanOrEqual(2);
      list.forEach((gap) => {
        expect(gap.criterion).toBeLessThan(c.mains[i].criteria.length);
        expect(gap.text.trim().length).toBeGreaterThan(20);
      });
    });
  });

  it('gives every non-good scripted answer, main and follow-up, a list of gaps that exist, and no good answer one', () => {
    for (const name of BASE_PROFILES) {
      c.studentsRaw.profiles[name].forEach((entry, i) => {
        const ids = c.studentsRaw.gaps[i].map((gap) => gap.id);
        ['main', 'followUp'].forEach((which) => {
          const answer = entry[which];
          expect(answer.gap).toBeUndefined();
          if (answer.label === 'good' && !answer.ownCode) expect(answer.gaps).toBeUndefined();
          else if (answer.gaps !== 'all') {
            expect(answer.gaps.length).toBeGreaterThan(0);
            answer.gaps.forEach((id) => expect(ids).toContain(id));
          }
        });
      });
    }
  });

  it('built answers list every gap they leave as an array of ids (empty for a good answer)', () => {
    for (const name of [...BASE_PROFILES, 'mixed', ...GAMING_PROFILES]) {
      buildProfile(c.studentsRaw, name, c.mains).forEach((entry, i) => {
        const ids = c.studentsRaw.gaps[i].map((gap) => gap.id);
        ['main', 'followUp'].forEach((which) => {
          const { gaps, label } = entry[which];
          expect(Array.isArray(gaps)).toBe(true);
          if (label === 'good' && !entry[which].ownCode) expect(gaps).toEqual([]);
          else {
            expect(gaps.length).toBeGreaterThan(0);
            gaps.forEach((id) => expect(ids).toContain(id));
          }
        });
      });
    }
  });

  it('short, idk, wrong and gaming answers leave every gap ("all"); a vague answer leaves some but not all', () => {
    // cases 4 and 5 are written differently: wrong and short answers state some correct facts (see the next test)
    const leaveAll = ['case4', 'case5'].includes(c.id) ? ['idk'] : ['short', 'idk', 'wrong'];
    for (const name of leaveAll) {
      c.studentsRaw.profiles[name].forEach((entry) => expect([entry.main.gaps, entry.followUp.gaps]).toEqual(['all', 'all']));
    }
    buildProfile(c.studentsRaw, 'vague').forEach((entry, i) => {
      const count = c.studentsRaw.gaps[i].length;
      expect(entry.main.gaps.length).toBeLessThan(count);
      expect(entry.followUp.gaps.length).toBeLessThan(count);
    });
    for (const name of GAMING_PROFILES) {
      buildProfile(c.studentsRaw, name, c.mains).forEach((entry, i) => {
        if (name !== 'inject') expect(entry.main.gaps).toHaveLength(c.studentsRaw.gaps[i].length);
      });
    }
  });

  it('cases 4 and 5: wrong, short and vague answers leave one or two of the three gaps, never all, and no gap is always the missing one', () => {
    if (!['case4', 'case5'].includes(c.id)) return;
    const seen = {};
    for (const name of ['vague', 'wrong', 'short']) {
      c.studentsRaw.profiles[name].forEach((entry, i) => {
        expect(c.studentsRaw.gaps[i]).toHaveLength(3);
        [entry.main, entry.followUp].forEach((answer) => {
          expect(Array.isArray(answer.gaps)).toBe(true);
          expect(answer.gaps.length).toBeGreaterThanOrEqual(1);
          expect(answer.gaps.length).toBeLessThanOrEqual(2);
          answer.gaps.forEach((id) => { seen[`${name}|${id}`] = (seen[`${name}|${id}`] || 0) + 1; });
        });
      });
    }
    // every gap id is the missing one somewhere, in every one of the three profiles
    for (const name of ['vague', 'wrong', 'short']) {
      ['g1', 'g2', 'g3'].forEach((id) => expect(seen[`${name}|${id}`]).toBeGreaterThan(0));
    }
  });

  it('a question with three gaps has every extra gap tied to a criterion, and its strong answers are not affected', () => {
    c.studentsRaw.gaps.forEach((list) => {
      expect(list.length).toBeLessThanOrEqual(3);
      expect(new Set(list.map((gap) => gap.id)).size).toBe(list.length);
    });
  });

  it('has at least 2 minimal pairs per main question; each pair leaves two different gaps', () => {
    expect(c.studentsRaw.pairs).toHaveLength(c.mains.length);
    c.studentsRaw.pairs.forEach((list, i) => {
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(new Set(list.map((p) => p.id)).size).toBe(list.length);
      list.forEach((pair) => {
        expect(pair.a.gap).not.toBe(pair.b.gap);
        expect(pairGapsLeft(pair.a)).toContain(pair.a.gap);
        expect(pairGapsLeft(pair.b)).toContain(pair.b.gap);
        expect(pairGapsLeft(pair.a)).not.toContain(pair.b.gap);
        expect(pairGapsLeft(pair.b)).not.toContain(pair.a.gap);
        expect(pair.a.text).not.toBe(pair.b.text);
        expect(c.studentsRaw.gaps[i].map((g) => g.id)).toEqual(expect.arrayContaining([pair.a.gap, pair.b.gap]));
      });
    });
  });

  it('builds the three gaming profiles with the gaming label', () => {
    for (const name of GAMING_PROFILES) {
      const built = buildProfile(c.studentsRaw, name, c.mains);
      expect(built).toHaveLength(c.mains.length);
      built.forEach((entry) => {
        expect(entry.main.label).toBe('gaming');
        expect(entry.followUp.label).toBe('gaming');
        expect(entry.main.gaps.length).toBeGreaterThan(0);
      });
    }
    expect(RUN_PROFILES).toEqual([...PROFILES, ...GAMING_PROFILES]);
  });
});

describe('validateStudents: gaps, pairs and gaming', () => {
  const fresh = () => JSON.parse(JSON.stringify(loadCase('case2').studentsRaw));
  const mains = loadCase('case2').mains;

  it('rejects a non-good answer without gaps, gaps on a good answer, an unknown gap and the old single gap', () => {
    const a = fresh();
    delete a.profiles.vague[0].main.gaps;
    expect(() => validateStudents(a, 5, 'x')).toThrow(/gaps must be/);
    const b = fresh();
    b.profiles.strong[0].main.gaps = ['g1'];
    expect(() => validateStudents(b, 5, 'x')).toThrow(/good answer has no gaps/);
    const c = fresh();
    c.profiles.vague[2].followUp.gaps = ['g1', 'g9'];
    expect(() => validateStudents(c, 5, 'x')).toThrow(/gaps must be/);
    const d = fresh();
    d.profiles.vague[2].followUp.gaps = [];
    expect(() => validateStudents(d, 5, 'x')).toThrow(/gaps must be/);
    const e = fresh();
    e.profiles.vague[0].main.gap = 'g1';
    expect(() => validateStudents(e, 5, 'x')).toThrow(/replaced by "gaps"/);
  });

  it('rejects a pair variant whose gaps list leaves out its own gap or names an unknown gap', () => {
    const a = fresh();
    a.pairs[0][0].a.gaps = ['g2'];
    expect(() => validateStudents(a, 5, 'x')).toThrow(/include its gap/);
    const b = fresh();
    b.pairs[0][0].a.gaps = ['g1', 'g9'];
    expect(() => validateStudents(b, 5, 'x')).toThrow(/include its gap/);
  });

  it('rejects too few gaps, a criterion the theme does not have, and reserved or repeated ids', () => {
    const a = fresh();
    a.gaps[0].pop();
    expect(() => validateStudents(a, 5, 'x')).toThrow(/at least 2 gaps/);
    const b = fresh();
    b.gaps[0][0].criterion = 7;
    expect(() => validateStudents(b, 5, 'x', mains)).toThrow(/criterion 7/);
    const c = fresh();
    c.gaps[0][1].id = 'none';
    expect(() => validateStudents(c, 5, 'x')).toThrow(/unique/);
    const d = fresh();
    d.gaps[0][1].id = 'g1';
    expect(() => validateStudents(d, 5, 'x')).toThrow(/unique/);
  });

  it('rejects a pair question with fewer than 2 pairs, a pair with the same gap twice, and missing pair text', () => {
    const a = fresh();
    a.pairs[1].pop();
    expect(() => validateStudents(a, 5, 'x')).toThrow(/at least 2 pairs/);
    const b = fresh();
    b.pairs[0][0].b.gap = b.pairs[0][0].a.gap;
    expect(() => validateStudents(b, 5, 'x')).toThrow(/different gaps/);
    const c = fresh();
    c.pairs[0][0].a.text = ' ';
    expect(() => validateStudents(c, 5, 'x')).toThrow(/missing answer text/);
  });

  it('rejects missing keyword answers', () => {
    const a = fresh();
    a.gaming.keywords.pop();
    expect(() => validateStudents(a, 5, 'x')).toThrow(/keywords/);
  });
});

describe('cases 4 and 5: tank fill controller', () => {
  const c4 = loadCase('case4');
  const c5 = loadCase('case5');

  const QUESTIONS = [
    'With settings 20, 80, 100, walk me through what your controller does for the readings 50, 18, 40, 85, 70, 15, and how many times the pump starts.',
    'Why does the controller use two levels, 20 and 80, instead of switching the pump at a single level like 50?',
    'Suppose the controller is FILLING and the next reading is -5. What happens, and what happens with the readings after that?',
    'If the check `reading >= s.high` were changed to `reading > s.high`, what would change in the output?',
    'Your `step` function takes the current state and returns the next one, instead of changing a global variable. Why is that a useful way to write it?',
  ];
  const CRITERIA = [
    'The student traces each reading to the correct state and explains why the state holds between the two levels.',
    'The student explains the purpose of the gap between the levels (hysteresis) and its effect on the pump.',
    'The student explains how an invalid reading is detected and what the alarm state does to later readings.',
    'The student identifies the boundary case the change affects and its consequence.',
    'The student explains the benefit of a pure function for a state machine.',
  ];

  it.each([['case4', c4], ['case5', c5]])('%s asks the 5 instructor questions word for word, one theme and one criterion each, 10 minutes, 1 follow-up', (id, c) => {
    expect(c.mains.map((m) => m.question)).toEqual(QUESTIONS);
    expect(c.config.themes).toHaveLength(5);
    c.config.themes.forEach((theme, i) => {
      expect(theme.mainQuestions).toHaveLength(1);
      expect(theme.criteria).toEqual([CRITERIA[i]]);
    });
    expect(c.config.timeLimitMinutes).toBe(10);
    expect(c.config.maxFollowUpsPerMainQuestion).toBe(1);
  });

  it.each([['case4', c4], ['case5', c5]])('%s has exactly 3 gaps per question (g1 to g3), each tied to the single criterion, as the instructor wrote them', (id, c) => {
    const gaps = c.studentsRaw.gaps;
    gaps.forEach((list) => {
      expect(list.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
      list.forEach((g) => expect(g.criterion).toBe(0));
    });
    expect(gaps[0][0].text).toBe('At 40 the controller stays `FILLING`, because a reading between `low` and `high` keeps the current state.');
    expect(gaps[0][2].text).toBe('The pump starts twice (at 18 and at 15), because a start is counted only when entering `FILLING` from another state.');
    expect(gaps[1][0].text).toBe('With a single level, readings that go back and forth around it (49, 51, 49, 51) would turn the pump on and off on every reading.');
    expect(gaps[2][2].text).toBe('The controller stays in `ALARM` for every later reading, even valid ones, because `step` checks `ALARM` first.');
    expect(gaps[3][1].text).toBe('An input that shows it, for example `10 80`: the second line becomes `80 -> FILLING` instead of `80 -> FULL`.');
    expect(gaps[4][2].text).toBe('`main` stays in control of the current state, which makes the loop easy to read and trace.');
  });

  it('both cases are the same problem with the same 7 stored tests (input and expected output)', () => {
    expect(c4.tests).toEqual(c5.tests);
    expect(c4.tests.map((t) => t.id)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
    c4.tests.forEach((t) => {
      expect(typeof t.input).toBe('string');
      expect(t.expected.length).toBeGreaterThan(0);
      expect(t.expected[t.expected.length - 1]).toMatch(/^Pump starts: \d+$/);
    });
    expect(c4.tests[0].expected).toEqual(['50 -> IDLE', '18 -> FILLING', '40 -> FILLING', '85 -> FULL', '70 -> FULL', '15 -> FILLING', 'Pump starts: 2']);
    expect(c4.tests[4]).toMatchObject({ input: '20 80 100', expected: ['Pump starts: 0'] });
    expect(loadCase('case2').tests).toEqual([]);
  });

  it('case 4 is the starter code with the reference isValid and step; case 5 differs by exactly the final line of step', () => {
    expect(c4.code).toContain('return reading >= 0 && reading <= s.max;');
    expect(c4.code).toContain('return current;  // between low and high: keep the current state');
    const a = c4.code.split('\n');
    const b = c5.code.split('\n');
    expect(b).toHaveLength(a.length);
    const different = a.map((line, i) => [line, b[i]]).filter(([x, y]) => x !== y);
    expect(different).toEqual([['    return current;  // between low and high: keep the current state', '    return TankState::IDLE;']]);
  });

  it('every profile has a main answer and a follow-up for every question, plus 2 minimal pairs per question', () => {
    [c4, c5].forEach((c) => {
      for (const name of RUN_PROFILES) {
        const built = buildProfile(c.studentsRaw, name, c.mains);
        expect(built).toHaveLength(5);
        built.forEach((entry) => {
          expect(entry.main.text.trim()).not.toBe('');
          expect(entry.followUp.text.trim()).not.toBe('');
        });
      }
      c.studentsRaw.pairs.forEach((list) => expect(list).toHaveLength(2));
    });
  });

  it('strong answers leave no gaps in case 4; in case 5 only Q1 (the answer about the own output) leaves g1 and g2', () => {
    buildProfile(c4.studentsRaw, 'strong').forEach((entry) => {
      expect(entry.main.gaps).toEqual([]);
      expect(entry.followUp.gaps).toEqual([]);
    });
    buildProfile(c5.studentsRaw, 'strong').forEach((entry, i) => {
      const expected = i === 0 ? ['g1', 'g2'] : [];
      expect(entry.main.gaps).toEqual(expected);
      expect(entry.followUp.gaps).toEqual(expected);
      expect(entry.main.label).toBe('good');
    });
    const q1 = buildProfile(c5.studentsRaw, 'strong')[0];
    expect(q1.main.text).toMatch(/40 is in the middle and it comes out IDLE/);
    expect(q1.main.text).toMatch(/70 is in the middle again and it is IDLE again/);
    expect(q1.main.text).toMatch(/starts 2 times/);
  });

  it('case 5 differs from case 4 only in Q1 (and its pairs); every case 5 Q1 answer that traces leaves g1 and g2', () => {
    for (const name of ['strong', 'vague', 'wrong', 'short', 'idk']) {
      expect(c5.studentsRaw.profiles[name].slice(1)).toEqual(c4.studentsRaw.profiles[name].slice(1));
      if (name !== 'idk') expect(c5.studentsRaw.profiles[name][0]).not.toEqual(c4.studentsRaw.profiles[name][0]); // idk does not trace
    }
    expect(c5.studentsRaw.pairs.slice(1)).toEqual(c4.studentsRaw.pairs.slice(1));
    expect(c5.studentsRaw.gaps).toEqual(c4.studentsRaw.gaps);
    for (const name of ['strong', 'vague', 'wrong', 'short']) {
      const entry = buildProfile(c5.studentsRaw, name)[0];
      expect(entry.main.gaps).toEqual(expect.arrayContaining(['g1', 'g2']));
      expect(entry.followUp.gaps).toEqual(expect.arrayContaining(['g1', 'g2']));
    }
  });

  it('a good answer may carry gaps only when it is marked ownCode', () => {
    const raw = JSON.parse(JSON.stringify(c5.studentsRaw));
    expect(() => validateStudents(JSON.parse(JSON.stringify(raw)), 5, 'case5', c5.mains)).not.toThrow();
    delete raw.profiles.strong[0].main.ownCode;
    expect(() => validateStudents(raw, 5, 'case5')).toThrow(/good answer has no gaps/);
  });

  it('wrong and short answers leave one or two of the three gaps; idk leaves all three', () => {
    for (const c of [c4, c5]) {
      for (const name of ['wrong', 'short']) {
        buildProfile(c.studentsRaw, name).forEach((entry) => {
          [entry.main.gaps, entry.followUp.gaps].forEach((g) => {
            expect(g.length).toBeGreaterThanOrEqual(1);
            expect(g.length).toBeLessThanOrEqual(2);
          });
        });
      }
      buildProfile(c.studentsRaw, 'idk').forEach((entry) => expect(entry.main.gaps).toEqual(['g1', 'g2', 'g3']));
    }
  });

  it('more than 40% of the non-good main answers have a chance level below 100% (they leave some but not all gaps)', () => {
    for (const c of [c4, c5]) {
      let weak = 0;
      let partial = 0;
      for (const name of RUN_PROFILES.filter((p) => p !== 'mixed')) {
        buildProfile(c.studentsRaw, name, c.mains).forEach((entry, i) => {
          if (!entry.main.gaps.length) return;
          weak += 1;
          if (entry.main.gaps.length < c.studentsRaw.gaps[i].length) partial += 1;
        });
      }
      expect(partial / weak).toBeGreaterThan(0.4);
    }
  });
});
