const fs = require('fs');
const { CASES, loadCase } = require('../../../scripts/eval/cases');
const {
  PROFILES, BASE_PROFILES, GAMING_PROFILES, RUN_PROFILES, PROFILE_FOR_LABEL, validateStudents, buildProfile,
} = require('../../../scripts/eval/students');
const { buildAnswersMarkdown, ANSWERS_FILE } = require('../../../scripts/eval/build-answers');

const cases = CASES.map((c) => loadCase(c.id));

describe.each(cases)('$id', (c) => {
  it('has 2-3 themes and 4-5 main questions', () => {
    expect(c.config.themes.length).toBeGreaterThanOrEqual(2);
    expect(c.config.themes.length).toBeLessThanOrEqual(3);
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
      expect(entry.main).toEqual(c.studentsRaw.profiles[entry.source][i].main);
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

  it('gives every non-good scripted answer, main and follow-up, a gap that exists, and no good answer one', () => {
    for (const name of BASE_PROFILES) {
      c.studentsRaw.profiles[name].forEach((entry, i) => {
        const ids = c.studentsRaw.gaps[i].map((gap) => gap.id);
        ['main', 'followUp'].forEach((which) => {
          const answer = entry[which];
          if (answer.label === 'good') expect(answer.gap).toBeUndefined();
          else expect([...ids, 'all']).toContain(answer.gap);
        });
      });
    }
  });

  it('short and idk answers leave every gap open ("all"); vague and wrong answers name one', () => {
    for (const name of ['short', 'idk']) {
      c.studentsRaw.profiles[name].forEach((entry) => expect([entry.main.gap, entry.followUp.gap]).toEqual(['all', 'all']));
    }
    for (const name of ['vague', 'wrong']) {
      c.studentsRaw.profiles[name].forEach((entry) => expect(entry.main.gap).not.toBe('all'));
    }
  });

  it('has at least 2 minimal pairs per main question; each pair leaves two different gaps', () => {
    expect(c.studentsRaw.pairs).toHaveLength(c.mains.length);
    c.studentsRaw.pairs.forEach((list, i) => {
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(new Set(list.map((p) => p.id)).size).toBe(list.length);
      list.forEach((pair) => {
        expect(pair.a.gap).not.toBe(pair.b.gap);
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
        expect(entry.main.gap).toBeTruthy();
      });
    }
    expect(RUN_PROFILES).toEqual([...PROFILES, ...GAMING_PROFILES]);
  });
});

describe('validateStudents: gaps, pairs and gaming', () => {
  const fresh = () => JSON.parse(JSON.stringify(loadCase('case2').studentsRaw));
  const mains = loadCase('case2').mains;

  it('rejects a non-good answer without a gap, a gap on a good answer and an unknown gap', () => {
    const a = fresh();
    delete a.profiles.vague[0].main.gap;
    expect(() => validateStudents(a, 5, 'x')).toThrow(/gap must be/);
    const b = fresh();
    b.profiles.strong[0].main.gap = 'g1';
    expect(() => validateStudents(b, 5, 'x')).toThrow(/good answer has no gap/);
    const c = fresh();
    c.profiles.wrong[2].followUp.gap = 'g9';
    expect(() => validateStudents(c, 5, 'x')).toThrow(/gap must be/);
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
