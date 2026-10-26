const fs = require('fs');
const { CASES, loadCase } = require('../../../scripts/eval/cases');
const {
  PROFILES, BASE_PROFILES, PROFILE_FOR_LABEL, validateStudents, buildProfile,
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
