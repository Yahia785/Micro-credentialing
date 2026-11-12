// The four multipart upload endpoints for proctoring recordings. S3 and the presigner are mocked; the handlers import the layer
// as /opt/nodejs/..., which jest.config.js maps to this folder.
const mockSend = jest.fn();
const mockSign = jest.fn();
const mockS3Client = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const command = (name) =>
    class {
      constructor(input) {
        this.commandName = name;
        this.input = input;
      }
    };
  return {
    S3Client: function S3Client(config) {
      mockS3Client(config);
      return { send: (...args) => mockSend(...args) };
    },
    CreateMultipartUploadCommand: command('CreateMultipartUpload'),
    UploadPartCommand: command('UploadPart'),
    CompleteMultipartUploadCommand: command('CompleteMultipartUpload'),
    AbortMultipartUploadCommand: command('AbortMultipartUpload'),
    HeadObjectCommand: command('HeadObject'),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: (...args) => mockSign(...args) }));

const { handler: create } = require('../../../functions/proctoring/multipart-create/index.js');
const { handler: presign } = require('../../../functions/proctoring/multipart-presign/index.js');
const { handler: complete } = require('../../../functions/proctoring/multipart-complete/index.js');
const { handler: abort } = require('../../../functions/proctoring/multipart-abort/index.js');

const USER = 'user-1';
const KEY = `recordings/${USER}/sub_abc/webcam.webm`;

const event = (body, userId = USER) => ({
  httpMethod: 'POST',
  path: '/proctoring/multipart/x',
  body: JSON.stringify(body),
  requestContext: userId ? { authorizer: { claims: { sub: userId } } } : {},
});
const json = (res) => JSON.parse(res.body);
const s3Error = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });
const sentCommands = (name) => mockSend.mock.calls.map(([c]) => c).filter((c) => c.commandName === name);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  mockSend.mockReset();
  mockSign.mockReset().mockImplementation(async (_client, cmd) => `https://s3.test/part-${cmd.input.PartNumber}?sig=1`);
});
afterEach(() => jest.restoreAllMocks());

describe('POST /proctoring/multipart/create', () => {
  it('starts the upload, builds the key on the server and returns the part size', async () => {
    mockSend.mockResolvedValue({ UploadId: 'up-1' });
    const res = await create(event({ submissionId: 'sub_abc', fileType: 'webcam' }), {});
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ uploadId: 'up-1', key: KEY, partSize: 8388608 });

    const [cmd] = sentCommands('CreateMultipartUpload');
    expect(cmd.input).toMatchObject({
      Bucket: 'micro-credentialing-recordings',
      Key: KEY,
      ContentType: 'video/webm',
      Metadata: { 'uploaded-by': USER, 'submission-id': 'sub_abc', 'file-type': 'webcam' },
    });
    expect(cmd.input.Metadata['uploaded-at']).toEqual(expect.any(String));
  });

  it('uses the screen path for a screen recording', async () => {
    mockSend.mockResolvedValue({ UploadId: 'up-2' });
    const res = await create(event({ submissionId: 'sub_abc', fileType: 'screen' }), {});
    expect(json(res).key).toBe(`recordings/${USER}/sub_abc/screen.webm`);
  });

  it('creates the S3 client with checksums only when required, so presigned URLs work from a browser', async () => {
    mockSend.mockResolvedValue({ UploadId: 'up-1' });
    await create(event({ submissionId: 'sub_abc', fileType: 'webcam' }), {});
    expect(mockS3Client).toHaveBeenCalledWith(
      expect.objectContaining({ requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })
    );
  });

  it('never takes a key, bucket or user from the client', async () => {
    mockSend.mockResolvedValue({ UploadId: 'up-1' });
    const res = await create(
      event({
        submissionId: 'sub_abc',
        fileType: 'webcam',
        key: 'recordings/someone-else/sub_x/webcam.webm',
        Key: 'recordings/someone-else/sub_x/webcam.webm',
        bucket: 'another-bucket',
        userId: 'someone-else',
      }),
      {}
    );
    expect(json(res).key).toBe(KEY);
    const [cmd] = sentCommands('CreateMultipartUpload');
    expect(cmd.input.Key).toBe(KEY);
    expect(cmd.input.Bucket).toBe('micro-credentialing-recordings');
    expect(cmd.input.Metadata['uploaded-by']).toBe(USER);
  });

  it.each([
    ['a missing submissionId', { fileType: 'webcam' }],
    ['a submissionId with a path in it', { submissionId: '../other/sub', fileType: 'webcam' }],
    ['a submissionId with a slash', { submissionId: 'a/b', fileType: 'webcam' }],
    ['a non-string submissionId', { submissionId: 12, fileType: 'webcam' }],
    ['a missing fileType', { submissionId: 'sub_abc' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await create(event(body), {});
    expect(res.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a fileType that is not allowed, and says which are', async () => {
    const res = await create(event({ submissionId: 'sub_abc', fileType: 'audio' }), {});
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatch(/webcam, screen, screenshot/);
  });

  it('rejects a screenshot: those are single images, not uploaded in parts', async () => {
    const res = await create(event({ submissionId: 'sub_abc', fileType: 'screenshot' }), {});
    expect(res.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a request without a signed-in user', async () => {
    const res = await create(event({ submissionId: 'sub_abc', fileType: 'webcam' }, null), {});
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /proctoring/multipart/presign', () => {
  const body = (extra = {}) => ({ submissionId: 'sub_abc', fileType: 'webcam', uploadId: 'up-1', partNumbers: [1, 2], ...extra });

  it('returns one URL per part, signed for the server-built key, valid for an hour', async () => {
    const res = await presign(event(body()), {});
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({
      urls: [
        { partNumber: 1, url: 'https://s3.test/part-1?sig=1' },
        { partNumber: 2, url: 'https://s3.test/part-2?sig=1' },
      ],
      expiresIn: 3600,
    });
    expect(mockSign).toHaveBeenCalledTimes(2);
    const [, cmd, options] = mockSign.mock.calls[0];
    expect(cmd.input).toEqual({ Bucket: 'micro-credentialing-recordings', Key: KEY, UploadId: 'up-1', PartNumber: 1 });
    expect(options).toEqual({ expiresIn: 3600 });
  });

  it('ignores a key sent by the client', async () => {
    await presign(event(body({ key: 'recordings/someone-else/sub_x/webcam.webm' })), {});
    expect(mockSign.mock.calls[0][1].input.Key).toBe(KEY);
  });

  it('signs a part number once when it is listed twice', async () => {
    const res = await presign(event(body({ partNumbers: [3, 3, 4] })), {});
    expect(json(res).urls.map((u) => u.partNumber)).toEqual([3, 4]);
  });

  it('accepts 20 part numbers and rejects 21', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect((await presign(event(body({ partNumbers: twenty })), {})).statusCode).toBe(200);
    expect((await presign(event(body({ partNumbers: [...twenty, 21] })), {})).statusCode).toBe(400);
  });

  it.each([
    ['an empty list', []],
    ['zero', [0]],
    ['10001', [10001]],
    ['a fraction', [1.5]],
    ['a string', ['1']],
    ['not a list', 3],
  ])('rejects %s with 400', async (_label, partNumbers) => {
    const res = await presign(event(body({ partNumbers })), {});
    expect(res.statusCode).toBe(400);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('accepts the highest part number, 10000', async () => {
    expect((await presign(event(body({ partNumbers: [10000] })), {})).statusCode).toBe(200);
  });

  it('rejects a missing uploadId and a wrong fileType', async () => {
    expect((await presign(event(body({ uploadId: undefined })), {})).statusCode).toBe(400);
    expect((await presign(event(body({ fileType: 'screenshot' })), {})).statusCode).toBe(400);
    expect((await presign(event(body({ fileType: 'nope' })), {})).statusCode).toBe(400);
  });
});

describe('POST /proctoring/multipart/complete', () => {
  const body = (extra = {}) => ({
    submissionId: 'sub_abc',
    fileType: 'webcam',
    uploadId: 'up-1',
    parts: [
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 1, etag: '"etag-1"' },
    ],
    ...extra,
  });

  it('sorts the parts, completes the upload and returns the key and size', async () => {
    mockSend.mockImplementation(async (cmd) => (cmd.commandName === 'HeadObject' ? { ContentLength: 12345 } : {}));
    const res = await complete(event(body()), {});
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ key: KEY, size: 12345 });

    const [cmd] = sentCommands('CompleteMultipartUpload');
    expect(cmd.input).toEqual({
      Bucket: 'micro-credentialing-recordings',
      Key: KEY,
      UploadId: 'up-1',
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: '"etag-1"' },
          { PartNumber: 2, ETag: '"etag-2"' },
        ],
      },
    });
  });

  it('ignores a key sent by the client', async () => {
    mockSend.mockImplementation(async (cmd) => (cmd.commandName === 'HeadObject' ? { ContentLength: 1 } : {}));
    await complete(event(body({ key: 'recordings/someone-else/sub_x/webcam.webm' })), {});
    expect(sentCommands('CompleteMultipartUpload')[0].input.Key).toBe(KEY);
    expect(sentCommands('HeadObject')[0].input.Key).toBe(KEY);
  });

  it('succeeds when it is retried after an earlier call already finished the upload', async () => {
    mockSend.mockImplementation(async (cmd) => {
      if (cmd.commandName === 'CompleteMultipartUpload') throw s3Error('NoSuchUpload');
      return { ContentLength: 999 };
    });
    const res = await complete(event(body()), {});
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ key: KEY, size: 999 });
    expect(sentCommands('HeadObject')).toHaveLength(1);
  });

  it('answers 404 when the upload is gone and no object exists', async () => {
    mockSend.mockImplementation(async (cmd) => {
      if (cmd.commandName === 'CompleteMultipartUpload') throw s3Error('NoSuchUpload');
      throw s3Error('NotFound', { $metadata: { httpStatusCode: 404 } });
    });
    const res = await complete(event(body()), {});
    expect(res.statusCode).toBe(404);
  });

  it('answers 500 for any other S3 failure', async () => {
    mockSend.mockRejectedValue(s3Error('InternalError'));
    const res = await complete(event(body()), {});
    expect(res.statusCode).toBe(500);
  });

  it.each([
    ['no parts', { parts: [] }],
    ['parts that are not a list', { parts: 'x' }],
    ['a part without an etag', { parts: [{ partNumber: 1 }] }],
    ['a part number of 0', { parts: [{ partNumber: 0, etag: '"a"' }] }],
    ['a part number over 10000', { parts: [{ partNumber: 10001, etag: '"a"' }] }],
    ['a repeated part number', { parts: [{ partNumber: 1, etag: '"a"' }, { partNumber: 1, etag: '"b"' }] }],
    ['no uploadId', { uploadId: undefined }],
    ['a screenshot', { fileType: 'screenshot' }],
  ])('rejects %s with 400', async (_label, extra) => {
    const res = await complete(event(body(extra)), {});
    expect(res.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('POST /proctoring/multipart/abort', () => {
  const body = (extra = {}) => ({ submissionId: 'sub_abc', fileType: 'webcam', uploadId: 'up-1', ...extra });

  it('aborts the upload on the server-built key', async () => {
    mockSend.mockResolvedValue({});
    const res = await abort(event(body({ key: 'recordings/someone-else/sub_x/webcam.webm' })), {});
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ aborted: true });
    expect(sentCommands('AbortMultipartUpload')[0].input).toEqual({
      Bucket: 'micro-credentialing-recordings',
      Key: KEY,
      UploadId: 'up-1',
    });
  });

  it('counts an upload that is already gone as success', async () => {
    mockSend.mockRejectedValue(s3Error('NoSuchUpload'));
    const res = await abort(event(body()), {});
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ aborted: true });
  });

  it('answers 500 for any other S3 failure', async () => {
    mockSend.mockRejectedValue(s3Error('InternalError'));
    expect((await abort(event(body()), {})).statusCode).toBe(500);
  });

  it('rejects bad input with 400', async () => {
    expect((await abort(event(body({ uploadId: undefined })), {})).statusCode).toBe(400);
    expect((await abort(event(body({ fileType: 'x' })), {})).statusCode).toBe(400);
    expect((await abort(event(body({ submissionId: '../a' })), {})).statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
