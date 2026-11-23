// The A2 pilot's setup: the template's permissions (S3 only under a2-pilot/*), the shipped assets, the interview-only config, the seed script
// and the handlers that start a practice interview on an import and list the imported records.
jest.mock('../db/users', () => ({ getUser: jest.fn() }));

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const BACKEND = path.join(__dirname, '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(BACKEND, ...parts), 'utf8').replace(/\r\n/g, '\n');

// CloudFormation short tags (!Ref, !Sub, ...) become plain objects, so the template can be read as data.
const TAGS = ['Ref', 'Sub', 'GetAtt', 'Join', 'Select', 'FindInMap', 'If', 'Equals', 'Not', 'And', 'Or', 'Base64', 'Cidr', 'ImportValue', 'Split', 'GetAZs', 'Condition'];
const CFN = yaml.Schema.create(yaml.DEFAULT_SAFE_SCHEMA, TAGS.flatMap((tag) => ['scalar', 'sequence', 'mapping'].map((kind) => new yaml.Type(`!${tag}`, { kind, construct: (data) => ({ [tag]: data }) }))));
const template = yaml.load(read('template.yaml'), { schema: CFN });
const resources = template.Resources;

const statementsOf = (fn) => (resources[fn].Properties.Policies || []).filter((p) => p.Statement).flatMap((p) => p.Statement);
const s3Statements = (fn) => statementsOf(fn).filter((st) => [].concat(st.Action).some((a) => String(a).startsWith('s3:')));
const hasTableRead = (fn) => (resources[fn].Properties.Policies || []).some((p) => p.DynamoDBReadPolicy && p.DynamoDBReadPolicy.TableName && p.DynamoDBReadPolicy.TableName.Ref === 'ImportedSubmissionsTable');
const interviewFunctions = Object.keys(resources).filter((name) => /Interview/.test(name) && resources[name].Type === 'AWS::Serverless::Function');

describe('permissions in template.yaml', () => {
  const READS_CODE = ['PrepareInterviewFunction', 'SubmitInterviewAnswerFunction', 'GetInterviewFunction'];

  it('gives s3:GetObject on a2-pilot/* only, to the three functions that read the code, and no other interview function any S3 access', () => {
    const withS3 = interviewFunctions.filter((fn) => s3Statements(fn).length > 0).sort();
    expect(withS3).toEqual([...READS_CODE].sort());
    READS_CODE.forEach((fn) => {
      const statements = s3Statements(fn);
      expect(statements).toHaveLength(1);
      expect(statements[0].Effect).toBe('Allow');
      expect(statements[0].Action).toEqual(['s3:GetObject']);
      expect(statements[0].Resource).toEqual(['arn:aws:s3:::micro-credentialing-recordings/a2-pilot/*']);
    });
    // no managed S3 policy on any interview function (S3CrudPolicy and S3ReadPolicy are whole-bucket)
    interviewFunctions.forEach((fn) => {
      expect((resources[fn].Properties.Policies || []).some((p) => p.S3CrudPolicy || p.S3ReadPolicy || p.S3FullAccessPolicy)).toBe(false);
    });
  });

  it('gives read (not write) access to ImportedSubmissions to the functions that need the record, and to no other function', () => {
    const readers = Object.keys(resources).filter((name) => resources[name].Type === 'AWS::Serverless::Function' && hasTableRead(name)).sort();
    expect(readers).toEqual(['GetInterviewFunction', 'ListSubmissionInterviewsFunction', 'PrepareInterviewFunction', 'StartPracticeInterviewFunction', 'SubmitInterviewAnswerFunction']);
    Object.keys(resources).filter((name) => resources[name].Type === 'AWS::Serverless::Function').forEach((name) => {
      const crud = (resources[name].Properties.Policies || []).some((p) => p.DynamoDBCrudPolicy && p.DynamoDBCrudPolicy.TableName && p.DynamoDBCrudPolicy.TableName.Ref === 'ImportedSubmissionsTable');
      expect(crud).toBe(false);
    });
  });

  it('passes the table name to every function', () => {
    expect(template.Globals.Function.Environment.Variables.IMPORTED_SUBMISSIONS_TABLE).toEqual({ Sub: 'ImportedSubmissions-${Environment}' });
  });

  it('keeps the practice start and the list admin-only in the handlers', () => {
    expect(read('functions', 'interviews', 'practice', 'index.js')).toContain('requireAdmin: true');
    expect(read('functions', 'interviews', 'list', 'index.js')).toContain('requireAdmin: true');
  });
});

describe('the code the interview Lambdas ship', () => {
  it('has the same header and driver as the evaluation set', () => {
    expect(read('shared', 'nodejs', 'a2', 'assets', 'functions.h')).toBe(read('scripts', 'eval', 'a2', 'reference', 'functions.h'));
    expect(read('shared', 'nodejs', 'a2', 'assets', 'main.cpp')).toBe(read('scripts', 'eval', 'a2', 'driver', 'main.cpp'));
  });

  it('reads S3 only under a2-pilot/ and only with an import id', async () => {
    const store = require('../a2/imported-store');
    expect(store.keysFor('0b6f2c1e-3d4a-4e5b-8c7d-9a1b2c3d4e5f')).toEqual({
      header: 'a2-pilot/0b6f2c1e-3d4a-4e5b-8c7d-9a1b2c3d4e5f/functions.h',
      source: 'a2-pilot/0b6f2c1e-3d4a-4e5b-8c7d-9a1b2c3d4e5f/functions.cpp',
    });
    expect(() => store.keysFor('../other')).toThrow('importId must be an import id');
    expect(() => store.keysFor('fakeuser03')).toThrow();
    const s3 = { client: { send: jest.fn() }, GetObjectCommand: jest.fn() };
    await expect(store.getFile('recordings/other.webm', { s3 })).rejects.toThrow('outside a2-pilot/');
    await expect(store.getFile('a2-pilot/../x', { s3 })).rejects.toThrow('outside a2-pilot/');
    expect(s3.client.send).not.toHaveBeenCalled();
  });

  it('lists the records with the fields an admin needs (and reads nothing else)', async () => {
    const store = require('../a2/imported-store');
    const send = jest.fn().mockResolvedValue({ Items: [
      { importId: 'b', githubUsername: 'fakeuser02', status: 'ok', plan: { form: 'B' } },
      { importId: 'a', githubUsername: 'fakeuser01', status: 'no_version_before_deadline' },
    ] });
    class Scan { constructor(input) { this.input = input; } }
    const records = await store.listRecords({ ddb: { client: { send }, ScanCommand: Scan } });
    expect(records).toEqual([
      { importId: 'a', githubUsername: 'fakeuser01', status: 'no_version_before_deadline', form: null, hasPlan: false },
      { importId: 'b', githubUsername: 'fakeuser02', status: 'ok', form: 'B', hasPlan: true },
    ]);
    expect(send.mock.calls[0][0].input.ProjectionExpression).toBe('importId, githubUsername, #status, #plan.form, #plan.noPlan');
  });
});

describe('interviewOnly in the interview config', () => {
  const { parseInterview } = require('../utils/interview-config');

  it('allows an interview-only setup with no themes, and keeps interviewOnly and source', () => {
    const parsed = parseInterview({ enabled: true, interviewOnly: true, source: 'a2-pilot', timeLimitMinutes: 20, themes: [] }, { language: 'cpp' });
    expect(parsed.error).toBeNull();
    expect(parsed.value).toMatchObject({ enabled: true, interviewOnly: true, source: 'a2-pilot', timeLimitMinutes: 20, themes: [] });
  });

  it('still needs a theme for an ordinary interview, and rejects a bad source or a non-boolean flag', () => {
    expect(parseInterview({ enabled: true, themes: [] }, { language: 'cpp' }).error).toMatch(/at least one theme/);
    expect(parseInterview({ enabled: true, interviewOnly: true, source: 'a b', themes: [] }, { language: 'cpp' }).error).toMatch(/source/);
    expect(parseInterview({ enabled: true, interviewOnly: 'yes', themes: [] }, { language: 'cpp' }).error).toMatch(/interviewOnly/);
  });
});

describe('seed-a2-assessment', () => {
  const seed = require('../../../scripts/seed-a2-assessment');
  const { parseInterview } = require('../utils/interview-config');

  it('is a hidden C++ assessment titled "Code Interview" with a neutral description that does not name the assignment', () => {
    const { milestone } = seed.buildPlan({ previewUserIds: ['u-1', 'u-1', 'u-2'] });
    expect(milestone).toMatchObject({ title: 'Code Interview', language: 'cpp', isHidden: true, previewUserIds: ['u-1', 'u-2'] });
    expect(milestone.description).not.toMatch(/assignment|a2|02|vector|craps|split|reverse|mode/i);
  });

  it('has the interview-only config: source a2-pilot, 20 minutes, the prompt version of the A2 flow', () => {
    const { milestone } = seed.buildPlan();
    expect(milestone.interview).toMatchObject({ enabled: true, interviewOnly: true, source: 'a2-pilot', timeLimitMinutes: 20, promptVersion: 'host.a2', maxFollowUpsPerMainQuestion: 1 });
    expect(parseInterview(milestone.interview, { language: 'cpp' }).error).toBeNull();
  });

  it('copies the preview list from the tank milestone, and says what --update changes', () => {
    expect(seed.TANK_MILESTONE_ID).toBe('milestone_cceb891e-decc-47ce-8e9e-97aa9f62cbe8');
    const { milestone } = seed.buildPlan({ previewUserIds: ['u-1'] });
    expect(seed.updateChanges({ description: milestone.description, interview: milestone.interview, previewUserIds: ['u-1'] }, milestone)).toEqual({ description: false, interview: false, previewUserIds: false });
    expect(seed.updateChanges({ description: 'old', interview: null, previewUserIds: [] }, milestone)).toEqual({ description: true, interview: true, previewUserIds: true });
  });

  it('parses --dry-run, --update and refuses unknown options', () => {
    expect(seed.parseArgs(['--dry-run', '--update'])).toMatchObject({ dryRun: true, update: true });
    expect(() => seed.parseArgs(['--nope'])).toThrow('Unknown option');
  });
});

describe('the assessment views', () => {
  const { forViewer } = require('../utils/assessment-view');
  const assessment = { milestoneId: 'm', title: 'Code Interview', isHidden: true, previewUserIds: ['u'], interview: { enabled: true, interviewOnly: true, timeLimitMinutes: 20, themes: [] } };

  it('tells admins and students the assessment is interview-only, and never sends students the setup', () => {
    expect(forViewer(assessment, true)).toMatchObject({ interviewEnabled: true, interviewOnly: true });
    const student = forViewer(assessment, false);
    expect(student).toMatchObject({ interviewEnabled: true, interviewOnly: true, interviewTimeLimitMinutes: 20 });
    expect(student).not.toHaveProperty('interview');
    expect(student).not.toHaveProperty('previewUserIds');
  });
});
